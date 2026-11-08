"""Photo sets and the avatar jobs built from them (the GPU work runs in services/avatar/multiview/avatar_worker.py)."""

import hashlib
import asyncio
import io
import json
import os
import re
import shutil
import tempfile
import uuid
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageOps, UnidentifiedImageError

MIN_AVATAR_PHOTOS = 8
AVATAR_STAGES = [("cameras", "Camera positions"), ("masks", "Person masks"), ("prepare", "Training data"),
                 ("train", "Gaussian training"), ("skeleton", "Skeleton"), ("rig", "Skinning and export")]
RIG_FILES = {"manifest.json": "application/json", "avatar.splat": "application/octet-stream",
             "indices.bin": "application/octet-stream", "weights.bin": "application/octet-stream"}
ACTIVE = {"queued", "running"}
VIDEO_STAGE = ("frames", "Video frames")
MAX_VIDEO_BYTES = 1024 ** 3
VIDEO_TYPES = {"video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm"}


def video_signature(head):
    """MP4/MOV carry an ISO-BMFF `ftyp` box; WebM/Matroska starts with the EBML magic."""
    return head[4:8] == b"ftyp" or head[:4] == bytes.fromhex("1a45dfa3")


COOKIE = "avatar_photo_session"


def resolve_account(token):
    """Validate a JWT centrally; never trust claims supplied by a browser."""
    if not isinstance(token, str) or len(token) > 8192 or not re.fullmatch(
        r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", token
    ):
        raise HTTPException(401, "Authentication required")
    url = os.getenv("ROOM_AUTH_API_URL", "http://127.0.0.1:8003/v1/rooms/auth/me")
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            raw = response.read(4097)
        if len(raw) > 4096:
            raise ValueError("Invalid account response")
        account = json.loads(raw)
        account["id"] = str(uuid.UUID(account["id"]))
        if account.get("disabled") is not False or account.get("role") not in {
            "ADMIN", "RECONSTRUCTOR", "SPLAT_UPLOADER"
        }:
            raise HTTPException(401, "Authentication required")
        return account
    except urllib.error.HTTPError as error:
        if error.code in {401, 403}:
            raise HTTPException(401, "Authentication required") from None
        raise HTTPException(503, "Authentication service unavailable") from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, TypeError):
        raise HTTPException(503, "Authentication service unavailable") from None


def create_photo_app(data_dir=None):
    root = Path(
        data_dir or os.getenv("PHOTO_DATA_DIR", ".runtime/photo-captures")
    ).resolve()
    root.mkdir(parents=True, exist_ok=True)
    app = FastAPI(title="Photographic avatar captures")
    origins = {origin.strip() for origin in os.getenv(
        "ROOM_BROWSER_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173"
    ).split(",") if origin.strip()}
    claim_lock = threading.Lock()

    def claim_legacy(request):
        token = request.cookies.get(COOKIE, "")
        if not re.fullmatch(r"[a-f0-9]{64}", token):
            return
        old = root / hashlib.sha256(token.encode()).hexdigest()
        target = root / request.state.owner
        with claim_lock:
            if not old.is_dir():
                return
            target.mkdir(exist_ok=True)
            for source in old.iterdir():
                try:
                    canonical = str(uuid.UUID(source.name))
                except ValueError:
                    continue
                if not source.is_dir() or source.is_symlink() or source.name != canonical:
                    continue
                destination = target / canonical
                if not destination.exists():
                    source.rename(destination)
            if not any(old.iterdir()):
                old.rmdir()

    @app.middleware("http")
    async def authentication(request: Request, call_next):
        from fastapi.responses import JSONResponse

        if not request.url.path.startswith("/v1/photo-captures"):
            return await call_next(request)
        authorization = request.headers.get("authorization")
        origin = request.headers.get("origin")
        if request.method not in {"GET", "HEAD", "OPTIONS"} and origin not in origins and (
            origin is not None or authorization is None
        ):
            return JSONResponse({"detail": "Origin not allowed"}, status_code=403)
        if authorization is not None:
            # Explicit credentials are authoritative, even when malformed.
            token = authorization[7:] if authorization[:7].lower() == "bearer " else ""
        else:
            token = request.cookies.get("room_access_token", "")
        try:
            account = await asyncio.to_thread(resolve_account, token)
        except HTTPException as error:
            return JSONResponse({"detail": error.detail}, status_code=error.status_code,
                                headers={"Cache-Control": "no-store"})
        request.state.owner = account["id"]
        creates_capture = request.method == "POST" and (
            request.url.path in {"/v1/photo-captures", "/v1/photo-captures/video"} or request.url.path.endswith("/generate")
        )
        if creates_capture and account["role"] not in {"ADMIN", "RECONSTRUCTOR"}:
            return JSONResponse({"detail": "Your role permits Gaussian PLY uploads only"}, status_code=403)
        await asyncio.to_thread(claim_legacy, request)

        if request.method == "POST" and request.url.path == "/v1/photo-captures/video":
            length = request.headers.get("content-length", "")
            if not length.isdecimal():
                return JSONResponse({"detail": "Content-Length required for video upload"}, status_code=411)
            if int(length) > MAX_VIDEO_BYTES:
                return JSONResponse({"detail": "The video exceeds 1 GB"}, status_code=413)
        if request.method == "POST" and request.url.path == "/v1/photo-captures":
            length = request.headers.get("content-length", "")
            if not length.isdecimal():
                return JSONResponse(
                    {"detail": "Content-Length required for photo upload"},
                    status_code=411,
                )
            if int(length) > 101 * 1024 * 1024:
                return JSONResponse(
                    {"detail": "The photo set exceeds 100 MB"}, status_code=413
                )

        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        if request.cookies.get(COOKIE):
            response.delete_cookie(COOKIE, path="/v1/photo-captures")
        return response

    def directory(request):
        return root / request.state.owner

    def read_job(path):
        try:
            job = json.loads((path / "job.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if job.get("state") in ACTIVE and (path / "cancel-request").exists():
            job["cancelling"] = True
        return job

    def summary(path):
        item = json.loads((path / "capture.json").read_text(encoding="utf-8"))
        item.pop("message", None)
        item["job"] = read_job(path)
        return item

    def capture(request, capture_id):
        try:
            canonical = str(uuid.UUID(capture_id))
        except ValueError:
            raise HTTPException(404, "Capture not found") from None
        path = directory(request) / canonical
        if not (path / "capture.json").is_file():
            raise HTTPException(404, "Capture not found")
        return path

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/v1/photo-captures/capabilities")
    def capabilities():
        return {
            "generation_available": True,
            "min_avatar_photos": MIN_AVATAR_PHOTOS,
            "max_photos": 32,
            "max_file_mb": 10,
            "max_batch_mb": 100,
        }

    @app.get("/v1/photo-captures")
    def captures(request: Request):
        items = [summary(p.parent) for p in directory(request).glob("*/capture.json")]
        return sorted(items, key=lambda item: item["created_at"], reverse=True)

    @app.post("/v1/photo-captures/video", status_code=201)
    async def upload_video(request: Request):
        """Raw body (not multipart) streamed to disk; frames are extracted by the avatar worker."""
        content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if content_type not in VIDEO_TYPES:
            raise HTTPException(415, "Upload an MP4, MOV or WebM video")
        parent = directory(request)
        parent.mkdir(exist_ok=True)
        if len(list(parent.glob("*/capture.json"))) >= 20:
            raise HTTPException(409, "20 sets are saved. Delete one you no longer need.")
        expected, capture_id = int(request.headers["content-length"]), str(uuid.uuid4())
        with tempfile.TemporaryDirectory(prefix=".upload-", dir=parent) as temporary:
            staging = Path(temporary) / "capture"
            staging.mkdir()
            target, size, head = staging / f"video.{VIDEO_TYPES[content_type]}", 0, b""
            with target.open("wb") as output:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > expected or size > MAX_VIDEO_BYTES:
                        raise HTTPException(413, "The video is larger than declared")
                    if len(head) < 16:
                        head += chunk[:16 - len(head)]
                    output.write(chunk)
            if size != expected or size < 1024:
                raise HTTPException(400, "The video upload is incomplete")
            if not video_signature(head):
                raise HTTPException(422, "The file is not an MP4, MOV or WebM video")
            item = {"id": capture_id, "created_at": datetime.now(timezone.utc).isoformat(), "status": "photos_ready",
                    "kind": "video", "photo_count": 0, "photos": [],
                    "video": {"file": target.name, "bytes": size, "name": request.headers.get("x-file-name", "")[:200]}}
            (staging / "capture.json").write_text(json.dumps(item, ensure_ascii=False), encoding="utf-8")
            staging.rename(parent / capture_id)
        return {**item, "job": None}

    @app.post("/v1/photo-captures", status_code=201)
    async def upload(request: Request, photos: list[UploadFile] = File()):
        try:
            if not 1 <= len(photos) <= 32:
                raise HTTPException(413, "Choose 1 to 32 photos")
            parent = directory(request)
            parent.mkdir(exist_ok=True)
            if len(list(parent.glob("*/capture.json"))) >= 20:
                raise HTTPException(
                    409, "20 sets are saved. Delete one you no longer need."
                )
            capture_id = str(uuid.uuid4())
            with tempfile.TemporaryDirectory(
                prefix=".upload-", dir=parent
            ) as temporary:
                staging = Path(temporary) / "capture"
                staging.mkdir()
                total = 0
                details = []
                for index, file in enumerate(photos):
                    raw = await file.read(10 * 1024 * 1024 + 1)
                    total += len(raw)
                    if len(raw) > 10 * 1024 * 1024 or total > 100 * 1024 * 1024:
                        raise HTTPException(
                            413, "Up to 10 MB per photo and 100 MB per set"
                        )
                    try:
                        with Image.open(io.BytesIO(raw)) as source:
                            if (
                                source.format not in {"JPEG", "PNG", "WEBP"}
                                or source.width * source.height > 24_000_000
                            ):
                                raise ValueError("format or dimensions")
                            source.load()
                            image = ImageOps.exif_transpose(source).convert("RGB")
                            image.thumbnail((2048, 2048))
                            # Rebuild pixels to avoid retaining EXIF, GPS or arbitrary info.
                            clean = Image.new("RGB", image.size)
                            clean.paste(image)
                            clean.save(staging / f"{index}.jpg", "JPEG", quality=95)
                            details.append(
                                {
                                    "index": index,
                                    "width": clean.width,
                                    "height": clean.height,
                                }
                            )
                    except (
                        UnidentifiedImageError,
                        OSError,
                        ValueError,
                        Image.DecompressionBombError,
                    ):
                        raise HTTPException(
                            422, f"Photo {index + 1}: use a JPEG, PNG or WebP up to 24 MP"
                        ) from None
                item = {
                    "id": capture_id,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "status": "photos_ready",
                    "photo_count": len(details),
                    "photos": details,
                }
                (staging / "capture.json").write_text(
                    json.dumps(item, ensure_ascii=False), encoding="utf-8"
                )
                staging.rename(parent / capture_id)
            return {**item, "job": None}
        finally:
            for file in photos:
                await file.close()

    @app.get("/v1/photo-captures/{capture_id}")
    def get_capture(capture_id: str, request: Request):
        return summary(capture(request, capture_id))

    @app.get("/v1/photo-captures/{capture_id}/photos/{index}")
    def get_photo(capture_id: str, index: int, request: Request):
        folder = capture(request, capture_id)
        # Video sets show the frames the worker extracted.
        video = json.loads((folder / "capture.json").read_text(encoding="utf-8")).get("kind") == "video"
        path = folder / "work" / "input" / f"{index}.jpg" if video else folder / f"{index}.jpg"
        if index < 0 or index > (199 if video else 31) or not path.is_file():
            raise HTTPException(404, "Photo not found")
        return FileResponse(path, media_type="image/jpeg")

    @app.post("/v1/photo-captures/{capture_id}/generate", status_code=202)
    def generate(capture_id: str, request: Request):
        path = capture(request, capture_id)
        item = json.loads((path / "capture.json").read_text(encoding="utf-8"))
        video = item.get("kind") == "video"
        if not video and item["photo_count"] < MIN_AVATAR_PHOTOS:
            raise HTTPException(422, f"An avatar needs at least {MIN_AVATAR_PHOTOS} photos of the person from all sides")
        with claim_lock:
            current = read_job(path)
            if current and current.get("state") in ACTIVE:
                raise HTTPException(409, "An avatar is already being built from this photo set")
            # A new run starts clean; the worker only picks up queued jobs.
            shutil.rmtree(path / "work", ignore_errors=True)
            (path / "cancel-request").unlink(missing_ok=True)
            job = {"state": "queued", "stage": None, "createdAt": datetime.now(timezone.utc).isoformat(), "error": None,
                   "stages": [{"id": key, "label": label, "state": "pending", "progress": 0.0}
                              for key, label in ([VIDEO_STAGE] if video else []) + AVATAR_STAGES]}
            temporary = path / "job.tmp"
            temporary.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
            temporary.replace(path / "job.json")
        return job

    @app.get("/v1/photo-captures/{capture_id}/job")
    def job_status(capture_id: str, request: Request):
        path = capture(request, capture_id)
        job = read_job(path)
        if job is None:
            raise HTTPException(404, "No avatar job for this photo set")
        log = path / "work" / "job.log"
        if log.is_file():
            with log.open("rb") as stream:
                stream.seek(max(0, log.stat().st_size - 8192))
                job["logTail"] = stream.read().decode("utf-8", "replace").splitlines()[-30:]
        return job

    @app.post("/v1/photo-captures/{capture_id}/job/cancel", status_code=202)
    def cancel_job(capture_id: str, request: Request):
        path = capture(request, capture_id)
        job = read_job(path)
        if not job or job.get("state") not in ACTIVE:
            raise HTTPException(409, "No running avatar job to cancel")
        (path / "cancel-request").touch()
        return {**job, "cancelling": True}

    @app.get("/v1/photo-captures/{capture_id}/avatar/model.ply")
    def avatar_model(capture_id: str, request: Request):
        path = capture(request, capture_id)
        job = read_job(path)
        model = path / "work" / "export" / "person.ply"
        if not job or job.get("state") != "done" or not model.is_file():
            raise HTTPException(404, "The avatar is not ready")
        return FileResponse(model, media_type="application/octet-stream", filename="avatar.ply")

    @app.get("/v1/photo-captures/{capture_id}/avatar/rig/{name}")
    def avatar_rig(capture_id: str, name: str, request: Request):
        """The animatable `gaussian-rig` package (skeleton + skinning) for the browser viewer."""
        path = capture(request, capture_id)
        job = read_job(path)
        target = path / "work" / "rig" / name
        if name not in RIG_FILES or not job or job.get("state") != "done" or not target.is_file():
            raise HTTPException(404, "The animatable avatar is not ready")
        return FileResponse(target, media_type=RIG_FILES[name])

    @app.get("/v1/photo-captures/{capture_id}/avatar/previews/{name}")
    def avatar_preview(capture_id: str, name: str, request: Request):
        path = capture(request, capture_id)
        preview = path / "work" / "renders" / name
        if not re.fullmatch(r"[A-Za-z0-9_.-]+\.jpg", name) or not preview.is_file():
            raise HTTPException(404, "Preview not found")
        return FileResponse(preview, media_type="image/jpeg")

    @app.delete("/v1/photo-captures/{capture_id}", status_code=204)
    def delete(capture_id: str, request: Request):
        path = capture(request, capture_id).resolve()
        if path.parent != directory(request).resolve() or not path.is_relative_to(root):
            raise HTTPException(404, "Capture not found")
        job = read_job(path)
        if job and job.get("state") in ACTIVE:
            raise HTTPException(409, "Cancel the avatar job before deleting this photo set")
        shutil.rmtree(path)
        return Response(status_code=204)

    return app
