import os
import math
from pathlib import Path

DATABASE = os.environ.get("ROOM_DATABASE_DSN", "postgresql://rooms:rooms-local@room-db:5432/rooms")
BUCKET = os.environ.get("ROOM_S3_BUCKET", "rooms")
SCRATCH = Path(os.environ.get("ROOM_SCRATCH", "/scratch")).resolve()
PROFILES = {
    "local": {"frames": 180, "max_video_frames": 360, "resolution": 1280, "steps": 15000, "split_until": 6000, "gradient": 0.0012, "sh": 2},
    "quality": {"frames": 400, "max_video_frames": 600, "resolution": 1920, "steps": 30000, "split_until": 15000, "gradient": 0.0008, "sh": 3},
}


def training_schedule(profile, registered_frames):
    ratio = max(1., min(registered_frames, profile["max_video_frames"]) / profile["frames"])
    return {"steps": math.ceil(profile["steps"] * ratio),
            "split_until": math.ceil(profile["split_until"] * ratio)}


MAX_SCRATCH_BYTES = int(os.environ.get("ROOM_MAX_SCRATCH_GIB", "30")) * 1024**3
MAX_SPLATS = int(os.environ.get("ROOM_MAX_SPLATS", "2500000"))
