"""Upload one room video (or 12-500 photos) through the room API and queue a reconstruction job.

Credentials come from ROOM_ADMIN_USERNAME / ROOM_ADMIN_PASSWORD (environment or the project .env).
Usage: python scripts/submit-room-capture.py --name "Room" [--profile quality] FILE [FILE ...]
"""
import argparse
import mimetypes
import os
import uuid
from pathlib import Path

import httpx

TYPES = {".mov": "video/quicktime", ".mp4": "video/mp4", ".webm": "video/webm",
         ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


def env(name, default=None):
    if name in os.environ:
        return os.environ[name]
    for line in (Path(__file__).resolve().parents[1] / ".env").read_text().splitlines():
        if line.startswith(name + "=") and line.split("=", 1)[1].strip():
            return line.split("=", 1)[1].strip()
    if default is None:
        raise SystemExit(f"{name} is not set")
    return default


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--name", required=True)
    parser.add_argument("--profile", choices=["local", "quality"], default="quality")
    parser.add_argument("--api", default="http://127.0.0.1:5173")
    args = parser.parse_args()
    # Mutating requests need a trusted browser Origin (CSRF guard in JwtAuthenticationFilter).
    with httpx.Client(base_url=args.api, timeout=300, headers={"Origin": args.api}) as api:
        api.post("/v1/rooms/auth/login", json={"username": env("ROOM_ADMIN_USERNAME", "admin"),
                                               "password": env("ROOM_ADMIN_PASSWORD")}).raise_for_status()
        media = [{"name": f.name, "size": f.stat().st_size,
                  "contentType": TYPES.get(f.suffix.lower()) or mimetypes.guess_type(f.name)[0]} for f in args.files]
        upload = api.post("/v1/rooms/uploads", json={"files": media, "kind": "capture"})
        upload.raise_for_status()
        upload = upload.json()
        completed = []
        for path, operation in zip(args.files, upload["files"]):
            parts = []
            with path.open("rb") as source:
                if "url" in operation:
                    api.put(operation["url"], content=source.read()).raise_for_status()
                else:
                    for part in operation["parts"]:
                        response = api.put(part["url"], content=source.read(operation["partSize"]))
                        response.raise_for_status()
                        parts.append({"number": part["number"], "etag": response.headers["ETag"]})
                        print(f"{path.name}: part {part['number']}/{len(operation['parts'])}", flush=True)
            completed.append({"key": operation["key"], "parts": parts})
        api.post(f"/v1/rooms/uploads/{upload['id']}/complete", json={"files": completed}).raise_for_status()
        job = api.post("/v1/rooms/jobs", json={"uploadId": upload["id"], "name": args.name, "profile": args.profile,
                                               "idempotencyKey": str(uuid.uuid4())})
        job.raise_for_status()
        print("upload", upload["id"])
        print("job", job.json()["id"], job.json().get("stage"))


if __name__ == "__main__":
    main()
