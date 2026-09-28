"""Avatar API. Bearer token -> owner mapping is a local platform-auth adapter."""

import io
import json
import os
import secrets
import uuid
from pathlib import Path

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageOps, UnidentifiedImageError

from .models import AvatarProfile, StrictModel
from .packages import validate_package
from .store import Conflict, Store

DATABASE_URL = "postgresql+psycopg://avatar:avatar-local@127.0.0.1:55432/avatar"


class JobRequest(StrictModel):
    profile: AvatarProfile
    avatar_id: uuid.UUID | None = None


def public_job(row):
    return {
        key: row.get(key)
        for key in (
            "id",
            "avatar_id",
            "version",
            "status",
            "created_at",
            "error",
            "approved",
        )
    }


def create_app(*, store=None, data_dir=None, tokens=None):
    store = store or Store(os.getenv("AVATAR_DATABASE_URL", DATABASE_URL))
    data_dir = Path(
        data_dir or os.getenv("AVATAR_DATA_DIR", ".runtime/avatar-data")
    ).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    tokens = (
        tokens if tokens is not None else json.loads(os.getenv("AVATAR_TOKENS", "{}"))
    )
    if not tokens:
        raise RuntimeError(
            "Set AVATAR_TOKENS to a JSON object mapping bearer tokens to owner IDs"
        )
    app = FastAPI(title="Avatar Service", version="0.1.0")
    app.state.data_dir = data_dir

    def owner(authorization: str | None = Header(default=None)):
        value = (
            authorization.removeprefix("Bearer ")
            if authorization and authorization.startswith("Bearer ")
            else ""
        )
        for token, owner_id in tokens.items():
            if secrets.compare_digest(value, token):
                return owner_id
        raise HTTPException(401, "Valid bearer token required")

    def get_job(job_id, owner_id):
        row = store.get(job_id, owner_id)
        if not row:
            raise HTTPException(404, "Job not found")
        return row

    def get_version(avatar_id, version, owner_id):
        row = store.version(avatar_id, version, owner_id)
        if not row:
            raise HTTPException(404, "Avatar version not found")
        return row

    @app.post("/v1/avatar-jobs", status_code=202)
    def create_job(
        body: JobRequest,
        owner_id=Depends(owner),
        idempotency_key: str | None = Header(
            default=None, min_length=1, max_length=128
        ),
    ):
        for reference in body.profile.references:
            if not store.reference(reference, owner_id):
                raise HTTPException(404, "Reference not found")
        try:
            return public_job(
                store.create(
                    owner_id,
                    body.profile.model_dump(),
                    idempotency_key,
                    str(body.avatar_id) if body.avatar_id else None,
                )
            )
        except Conflict as exc:
            raise HTTPException(409, str(exc)) from exc
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.get("/v1/avatar-jobs/{job_id}")
    def job(job_id: str, owner_id=Depends(owner)):
        return public_job(get_job(job_id, owner_id))

    @app.post("/v1/avatar-jobs/{job_id}/cancel")
    def cancel(job_id: str, owner_id=Depends(owner)):
        get_job(job_id, owner_id)
        return public_job(store.cancel(job_id, owner_id))

    @app.post("/v1/references", status_code=201)
    async def upload_reference(file: UploadFile = File(), owner_id=Depends(owner)):
        raw = await file.read(10 * 1024 * 1024 + 1)
        await file.close()
        if len(raw) > 10 * 1024 * 1024:
            raise HTTPException(413, "Reference exceeds 10 MB")
        try:
            with Image.open(io.BytesIO(raw)) as source:
                if (
                    source.format not in ("JPEG", "PNG")
                    or source.width * source.height > 24_000_000
                ):
                    raise ValueError("Use JPEG or PNG up to 24 megapixels")
                source.load()
                photo = ImageOps.exif_transpose(source).convert("RGB")
                photo.thumbnail((2048, 2048))
        except (
            UnidentifiedImageError,
            OSError,
            ValueError,
            Image.DecompressionBombError,
        ) as exc:
            raise HTTPException(422, "Invalid reference image") from exc
        reference_id = str(uuid.uuid4())
        path = data_dir / "references" / f"{reference_id}.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        photo.save(path, "JPEG", quality=90)
        try:
            store.add_reference(owner_id, path, reference_id)
        except Exception:
            path.unlink(missing_ok=True)
            raise
        return {"id": reference_id}

    @app.get("/v1/references/{reference_id}")
    def reference(reference_id: str, owner_id=Depends(owner)):
        row = store.reference(reference_id, owner_id)
        if not row:
            raise HTTPException(404, "Reference not found")
        return FileResponse(row["path"], media_type="image/jpeg")

    @app.get("/v1/avatars/{avatar_id}/versions/{version}")
    def manifest(avatar_id: str, version: int, owner_id=Depends(owner)):
        row = get_version(avatar_id, version, owner_id)
        return validate_package(Path(row["result_path"])).model_dump()

    @app.get("/v1/avatars/{avatar_id}/versions/{version}/model")
    def model(avatar_id: str, version: int, owner_id=Depends(owner)):
        row = get_version(avatar_id, version, owner_id)
        return FileResponse(
            Path(row["result_path"]) / "avatar.glb", media_type="model/gltf-binary"
        )

    @app.get("/v1/avatars/{avatar_id}/versions/{version}/package")
    def package(avatar_id: str, version: int, owner_id=Depends(owner)):
        row = get_version(avatar_id, version, owner_id)
        return FileResponse(
            Path(row["result_path"]) / "package.zip",
            media_type="application/zip",
            filename=f"avatar-{avatar_id}-v{version}.zip",
        )

    @app.post("/v1/avatars/{avatar_id}/versions/{version}/approve")
    def approve(avatar_id: str, version: int, owner_id=Depends(owner)):
        row = get_version(avatar_id, version, owner_id)
        store.approve(row["id"], owner_id)
        return {"approved": True, "avatar_id": avatar_id, "version": version}

    return app
