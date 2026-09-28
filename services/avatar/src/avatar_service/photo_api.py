"""Local photo intake. A capture is not an avatar or a reconstruction job."""

import hashlib
import io
import json
import os
import re
import secrets
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageOps, UnidentifiedImageError

BLOCKER = "Фото можно сохранить. Создание личного аватара пока недоступно: движок реконструкции по фото ещё не подключён."
COOKIE = "avatar_photo_session"


def create_photo_app(data_dir=None):
    root = Path(
        data_dir or os.getenv("PHOTO_DATA_DIR", ".runtime/photo-captures")
    ).resolve()
    root.mkdir(parents=True, exist_ok=True)
    app = FastAPI(title="Photographic avatar captures")
    origins = {
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:8002",
        "http://localhost:8002",
    }

    @app.middleware("http")
    async def session(request: Request, call_next):
        from fastapi.responses import JSONResponse

        if request.method == "POST" and request.url.path == "/v1/photo-captures":
            length = request.headers.get("content-length", "")
            if not length.isdecimal():
                return JSONResponse(
                    {"detail": "Content-Length required for photo upload"},
                    status_code=411,
                )
            if int(length) > 101 * 1024 * 1024:
                return JSONResponse(
                    {"detail": "Набор превышает 100 МБ"}, status_code=413
                )

        if request.method not in {"GET", "HEAD", "OPTIONS"} and request.headers.get(
            "origin"
        ) not in origins | {None}:
            return JSONResponse({"detail": "Origin not allowed"}, status_code=403)
        token = request.cookies.get(COOKIE, "")
        fresh = not re.fullmatch(r"[a-f0-9]{64}", token)
        if fresh:
            token = secrets.token_hex(32)
        request.state.owner = hashlib.sha256(token.encode()).hexdigest()
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        if fresh:
            response.set_cookie(
                COOKIE,
                token,
                httponly=True,
                samesite="strict",
                max_age=365 * 86400,
                path="/v1/photo-captures",
            )
        return response

    def directory(request):
        return root / request.state.owner

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
            "generation_available": False,
            "reason": BLOCKER,
            "max_photos": 32,
            "max_file_mb": 10,
            "max_batch_mb": 100,
        }

    @app.get("/v1/photo-captures")
    def captures(request: Request):
        items = [
            json.loads(p.read_text(encoding="utf-8"))
            for p in directory(request).glob("*/capture.json")
        ]
        return sorted(items, key=lambda item: item["created_at"], reverse=True)

    @app.post("/v1/photo-captures", status_code=201)
    async def upload(request: Request, photos: list[UploadFile] = File()):
        try:
            if not 1 <= len(photos) <= 32:
                raise HTTPException(413, "Выберите от 1 до 32 фотографий")
            parent = directory(request)
            parent.mkdir(exist_ok=True)
            if len(list(parent.glob("*/capture.json"))) >= 20:
                raise HTTPException(
                    409, "Сохранено 20 наборов. Удалите ненужный набор."
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
                            413, "До 10 МБ на фото и до 100 МБ на набор"
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
                            422, f"Фото {index + 1}: нужен JPEG, PNG или WebP до 24 Мп"
                        ) from None
                item = {
                    "id": capture_id,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "status": "photos_ready",
                    "photo_count": len(details),
                    "photos": details,
                    "message": BLOCKER,
                }
                (staging / "capture.json").write_text(
                    json.dumps(item, ensure_ascii=False), encoding="utf-8"
                )
                staging.rename(parent / capture_id)
            return item
        finally:
            for file in photos:
                await file.close()

    @app.get("/v1/photo-captures/{capture_id}")
    def get_capture(capture_id: str, request: Request):
        return json.loads(
            (capture(request, capture_id) / "capture.json").read_text(encoding="utf-8")
        )

    @app.get("/v1/photo-captures/{capture_id}/photos/{index}")
    def get_photo(capture_id: str, index: int, request: Request):
        path = capture(request, capture_id) / f"{index}.jpg"
        if index < 0 or index > 31 or not path.is_file():
            raise HTTPException(404, "Photo not found")
        return FileResponse(path, media_type="image/jpeg")

    @app.post("/v1/photo-captures/{capture_id}/generate")
    def generate(capture_id: str, request: Request):
        capture(request, capture_id)
        raise HTTPException(503, BLOCKER)

    @app.delete("/v1/photo-captures/{capture_id}", status_code=204)
    def delete(capture_id: str, request: Request):
        path = capture(request, capture_id).resolve()
        if path.parent != directory(request).resolve() or not path.is_relative_to(root):
            raise HTTPException(404, "Capture not found")
        shutil.rmtree(path)
        return Response(status_code=204)

    return app
