"""Stage 0 (video sets): pick sharp, evenly spread frames of a walk-around video.

The person stands still while the camera circles them, so frames spread evenly in time are spread evenly in angle.
Writes AVATAR_WORK/input/0.jpg … N-1.jpg, which the later stages treat exactly like an uploaded photo set.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

from progress import report as progress

INPUT, WORK = Path(os.environ.get("AVATAR_INPUT", "/input")), Path(os.environ.get("AVATAR_WORK", "/work"))
TARGET = int(os.environ.get("AVATAR_VIDEO_FRAMES", "36"))


def fail(message):
    print(f"ERROR {message}", flush=True)
    sys.exit(1)


def main():
    videos = sorted(INPUT.glob("video.*"))
    if not videos:
        fail("The set has no video file.")
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration:stream=width,height",
                            "-of", "json", str(videos[0])], capture_output=True, text=True, timeout=60)
    try:
        info = json.loads(probe.stdout)
        duration = float(info["format"]["duration"])
    except (ValueError, KeyError):
        fail("The video could not be read. Upload an MP4, MOV or WebM file from a phone or camera.")
    if not 5 <= duration <= 600:
        fail("Use a video between 5 seconds and 10 minutes that circles the person once or twice.")
    candidates = WORK / "candidates"
    shutil.rmtree(candidates, ignore_errors=True); candidates.mkdir(parents=True)
    # About five candidates per selected frame; ffmpeg applies the rotation metadata of phone videos.
    fps = min(10.0, TARGET * 5 / duration)
    progress(0.05, f"Decoding {duration:.0f} s of video")
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(videos[0]), "-an",
                    "-vf", f"fps={fps:.4f},scale='if(gt(iw,ih),min(1600,iw),-2)':'if(gt(iw,ih),-2,min(1600,ih))'",
                    "-q:v", "2", str(candidates / "%05d.jpg")], check=True, timeout=1800)
    paths = sorted(candidates.glob("*.jpg"))
    if len(paths) < 12:
        fail("The video is too short to provide enough views of the person.")
    sharpness = []
    for index, path in enumerate(paths):
        gray = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        gray = cv2.resize(gray, (480, int(480 * gray.shape[0] / gray.shape[1])))
        sharpness.append(float(cv2.Laplacian(gray, cv2.CV_64F).var()))
        if index % 20 == 0:
            progress(0.3 + 0.5 * index / len(paths), f"Checking sharpness of {index + 1}/{len(paths)} frames")
    sharpness = np.asarray(sharpness)
    # Motion-blurred frames ruin feature matching and textures; skip them even if a time slot stays empty.
    usable = sharpness >= 0.35 * np.median(sharpness)
    output = WORK / "input"
    shutil.rmtree(output, ignore_errors=True); output.mkdir()
    selected = []
    for group in np.array_split(np.arange(len(paths)), TARGET):
        group = [i for i in group if usable[i]]
        if group:
            selected.append(max(group, key=lambda i: sharpness[i]))
    for number, index in enumerate(selected):
        shutil.copy(paths[index], output / f"{number}.jpg")
    shutil.rmtree(candidates)
    if len(selected) < 12:
        fail("Too few sharp frames. Move slowly around the person and keep them in focus.")
    progress(1.0, f"{len(selected)} sharp frames from {len(paths)} candidates ({duration:.0f} s video)",
             frames=len(selected), candidates=len(paths), seconds=round(duration, 1))


if __name__ == "__main__":
    main()
