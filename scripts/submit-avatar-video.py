"""Upload walk-around videos of a person through the avatar API and queue an avatar build for each.

Credentials come from ROOM_ADMIN_USERNAME / ROOM_ADMIN_PASSWORD (environment or the project .env).
Usage: python scripts/submit-avatar-video.py [--no-build] VIDEO [VIDEO ...]
"""
import argparse
import os
from pathlib import Path
from urllib.parse import quote

import httpx

TYPES = {".mov": "video/quicktime", ".mp4": "video/mp4", ".webm": "video/webm"}


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
    parser.add_argument("videos", nargs="+", type=Path)
    parser.add_argument("--no-build", action="store_true", help="only save the video; build later from the Avatar library")
    parser.add_argument("--api", default="http://127.0.0.1:5173")
    args = parser.parse_args()
    for path in args.videos:
        if path.suffix.lower() not in TYPES:
            raise SystemExit(f"{path.name}: use an MP4, MOV or WebM video")
    # Mutating requests need a trusted browser Origin (CSRF guard in JwtAuthenticationFilter).
    with httpx.Client(base_url=args.api, timeout=900, headers={"Origin": args.api}) as api:
        api.post("/v1/rooms/auth/login", json={"username": env("ROOM_ADMIN_USERNAME", "admin"),
                                               "password": env("ROOM_ADMIN_PASSWORD")}).raise_for_status()
        for path in args.videos:
            with path.open("rb") as source:
                saved = api.post("/v1/photo-captures/video", content=source,
                                 headers={"Content-Type": TYPES[path.suffix.lower()], "Content-Length": str(path.stat().st_size),
                                          "X-File-Name": quote(path.name)[:200]})
            if saved.status_code != 201:
                raise SystemExit(f"{path.name}: {saved.status_code} {saved.text[:300]}")
            capture = saved.json()["id"]
            print("capture", capture, path.name, flush=True)
            if not args.no_build:
                job = api.post(f"/v1/photo-captures/{capture}/generate")
                job.raise_for_status()
                print("job", capture, job.json()["state"], flush=True)


if __name__ == "__main__":
    main()
