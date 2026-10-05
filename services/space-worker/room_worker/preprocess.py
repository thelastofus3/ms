import hashlib
import math
import threading
from dataclasses import dataclass
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageOps
from .commands import run, inspect_video

Image.MAX_IMAGE_PIXELS = 40_000_000


@dataclass
class Frame:
    index: int
    sharpness: float
    path: Path
    gray: np.ndarray


def video_frame_budget(duration, profile):
    # Keep approximately the same temporal density as a two-minute capture,
    # bounded independently of video duration and GPU image-cache capacity.
    return min(profile.get("max_video_frames", profile["frames"] * 2),
               math.ceil(profile["frames"] * max(1., duration / 120.)))


def view_overlap(a, b):
    """Tracked background coverage plus displacement, at thumbnail resolution."""
    points = cv2.goodFeaturesToTrack(a, maxCorners=200, qualityLevel=0.01, minDistance=5)
    if points is None or len(points) < 12:
        return 0., float("inf")
    forward, ok, _ = cv2.calcOpticalFlowPyrLK(a, b, points, None)
    if forward is None:
        return 0., float("inf")
    backward, back_ok, _ = cv2.calcOpticalFlowPyrLK(b, a, forward, None)
    if backward is None:
        return 0., float("inf")
    valid = (ok.ravel() != 0) & (back_ok.ravel() != 0)
    valid &= np.linalg.norm((points-backward).reshape(-1, 2), axis=1) < 1.5
    xy = forward.reshape(-1, 2)
    valid &= (xy[:, 0] >= 0) & (xy[:, 0] < b.shape[1]) & (xy[:, 1] >= 0) & (xy[:, 1] < b.shape[0])
    if np.count_nonzero(valid) < 12:
        return 0., float("inf")
    motion = np.linalg.norm((forward-points).reshape(-1, 2)[valid], axis=1)
    return float(np.mean(valid)), float(np.median(motion))


def select_video_frames(candidates, budget, lease=None):
    usable = []
    for frame in candidates:
        if frame.sharpness < 12:
            continue
        if usable and np.mean(cv2.absdiff(frame.gray, usable[-1].gray)) < 1.5:
            continue
        usable.append(frame)
    # Reserve space for bridging views instead of spending the entire budget
    # on sharp endpoints. Candidate indices retain temporal order.
    initial = min(len(usable), max(2, int(budget * 0.8)))
    selected = [max((usable[int(i)] for i in group), key=lambda f: f.sharpness)
                for group in np.array_split(np.arange(len(usable)), initial)] if initial else []
    selected.sort(key=lambda frame: frame.index)
    checks = 0
    cache = {}
    def gap(a, b):
        nonlocal checks
        key = (a.index, b.index)
        if key not in cache:
            if lease:
                lease.check()
                lease.progress("Select frames", f"Checking overlap between candidate views · {checks} pairs checked")
            cache[key] = view_overlap(a.gray, b.gray)
            checks += 1
        coverage, displacement = cache[key]
        return coverage < 0.65 or displacement > min(a.gray.shape) * 0.08
    while len(selected) < budget:
        choices = []
        for a, b in zip(selected, selected[1:]):
            between = [frame for frame in usable if a.index < frame.index < b.index]
            if between and gap(a, b):
                midpoint = (a.index + b.index) / 2
                nearby = sorted(between, key=lambda frame: abs(frame.index-midpoint))[:max(1, len(between)//2)]
                choices.append((b.index-a.index, max(nearby, key=lambda frame: frame.sharpness)))
        if not choices:
            break
        selected.append(max(choices, key=lambda item: item[0])[1])
        selected.sort(key=lambda frame: frame.index)
    unresolved = sum(gap(a, b) for a, b in zip(selected, selected[1:]))
    return selected, {"overlapChecks": checks, "possibleOverlapGaps": unresolved,
                      "discardedBlurredOrRepeatedFrames": len(candidates)-len(usable)}


def prepare(media, storage, work: Path, profile, lease):
    inputs = work / "input"
    inputs.mkdir()
    files = []
    total_bytes = sum(item["size"] for item in media)
    downloaded = 0
    download_lock = threading.Lock()
    def download_progress(size):
        nonlocal downloaded
        with download_lock:
            downloaded += size
            lease.progress("Download capture", "Reading uploaded media", downloaded, total_bytes, "bytes downloaded")
    lease.progress("Download capture", "Reading uploaded media", 0, total_bytes, "bytes downloaded", force=True)
    for index, item in enumerate(media):
        lease.check()
        path = inputs / f"{index:05d}.media"
        storage.download_file(storage.bucket, item["key"], str(path), Callback=download_progress)
        if path.stat().st_size != item["size"]:
            raise ValueError("Uploaded file size changed")
        files.append(path)
    video = media[0]["contentType"].startswith("video/")
    budget = profile["frames"]
    capture = {}
    if video:
        duration = inspect_video(files[0])
        budget = video_frame_budget(duration, profile)
        capture["videoDurationSeconds"] = duration
        capture["frameBudget"] = budget
        frames = work / "frames"
        frames.mkdir()
        resolution = profile["resolution"]
        fps = min(4, (budget * 4) / duration)
        lease.progress("Decode video", "Extracting video frames", 0, duration, "video seconds decoded", force=True)
        run(["ffmpeg", "-v", "error", "-nostdin", "-i", files[0], "-an", "-vf",
             f"fps={fps},scale={resolution}:{resolution}:force_original_aspect_ratio=decrease",
             "-frames:v", budget*4, "-progress", work / "decode-progress.txt", "-q:v", "2", frames / "%05d.jpg"], work, lease, 600)
        files = sorted(frames.glob("*.jpg"))
    candidates = []
    hashes = set()
    for index, path in enumerate(files):
        lease.check()
        lease.progress("Inspect frames", "Checking sharpness and duplicate views", index, len(files), "frames inspected")
        try:
            with Image.open(path) as source:
                if source.format not in {"JPEG", "PNG", "WEBP"} or source.width * source.height > Image.MAX_IMAGE_PIXELS:
                    raise ValueError("Unsupported image or image exceeds 40 megapixels")
                image = ImageOps.exif_transpose(source).convert("RGB")
                if min(image.size) < 320:
                    raise ValueError("Use images at least 320 pixels on each side")
                image.thumbnail((profile["resolution"], profile["resolution"]))
                digest = hashlib.sha256(image.tobytes()).digest()
                if digest in hashes:
                    continue
                hashes.add(digest)
                thumbnail = image.copy()
                thumbnail.thumbnail((256, 256))
                gray = cv2.cvtColor(np.asarray(thumbnail), cv2.COLOR_RGB2GRAY)
                sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
                # Retain paths and small thumbnails, not hundreds of full RGB images.
                candidates.append(Frame(index, sharpness, path, gray))
        except (OSError, Image.DecompressionBombError) as error:
            raise ValueError("A photo could not be decoded safely") from error
    if video:
        selected, selection = select_video_frames(candidates, budget, lease)
        capture.update(selection)
    elif len(candidates) > budget:
        selected = []
        for indices in np.array_split(np.arange(len(candidates)), budget):
            selected.append(max((candidates[int(i)] for i in indices), key=lambda frame: frame.sharpness))
    else:
        selected = candidates
    selected = sorted(selected, key=lambda frame: frame.index)
    dataset = work / "dataset"
    images = dataset / "images"
    images.mkdir(parents=True)
    kept = 0
    for index, frame in enumerate(selected):
        lease.check()
        lease.progress("Select frames", "Filtering and saving distinct sharp views", index, len(selected), "candidate frames processed")
        with Image.open(frame.path) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            image.thumbnail((profile["resolution"], profile["resolution"]))
            image.save(images / f"{kept:05d}.jpg", quality=95)
        kept += 1
    if kept < 12:
        raise ValueError("Not enough distinct sharp views. Walk slowly around the room and keep overlapping views.")
    lease.progress("Prepare frames", "Frame preparation complete", len(files), len(files), "frames inspected", force=True)
    return dataset, {**capture, "selectedFrames": kept, "inputFiles": len(media), "video": video, "resolution": profile["resolution"]}
