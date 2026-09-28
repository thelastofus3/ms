"""Isolated Blender process. Only a validated package becomes visible at output."""

import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from .models import AvatarProfile
from .packages import write_package

ROOT = Path(__file__).resolve().parents[4]
MPFB_REVISION = "7fcc8df56f26776923e0a825f4551c3c3779befe"


def generate_avatar(
    profile: AvatarProfile,
    output: Path,
    *,
    blender: Path | None = None,
    cancelled: threading.Event | None = None,
    avatar_id: str | None = None,
    version: int = 1,
):
    if cancelled is not None and cancelled.is_set():
        raise RuntimeError("Generation cancelled")
    blender = blender or Path(
        os.getenv(
            "AVATAR_BLENDER",
            str(ROOT / ".tools/blender/blender-4.5.14-windows-x64/blender.exe"),
        )
    )
    if not blender.is_file():
        raise RuntimeError(f"Blender executable not found: {blender}")
    mpfb = Path(os.getenv("AVATAR_MPFB", str(ROOT / ".tools/mpfb2/src"))).resolve()
    assets = Path(
        os.getenv("AVATAR_ASSETS", str(ROOT / ".tools/system-assets"))
    ).resolve()
    if not (mpfb / "mpfb/blender_manifest.toml").is_file():
        raise RuntimeError(f"MPFB extension not found: {mpfb}")
    revision = subprocess.run(
        ["git", "-C", str(mpfb.parent), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if revision.returncode or revision.stdout.strip() != MPFB_REVISION:
        raise RuntimeError(
            "MPFB revision does not match the pinned toolchain; run scripts/bootstrap-avatar.ps1"
        )
    if not assets.is_dir():
        raise RuntimeError(f"MakeHuman system assets not found: {assets}")
    output = output.resolve()
    if output.exists():
        raise ValueError("Output already exists; choose a new version directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".avatar-", dir=output.parent))
    try:
        request = {
            "profile": profile.model_dump(),
            "mpfb": str(mpfb),
            "assets": str(assets),
            "output": str(staging),
        }
        (staging / "request.json").write_text(json.dumps(request), encoding="utf-8")
        env = dict(os.environ, BLENDER_USER_RESOURCES=str(staging / "blender-user"))
        command = [
            str(blender.resolve()),
            "--background",
            "--factory-startup",
            "--python-exit-code",
            "1",
            "--python",
            str(Path(__file__).with_name("blender_export.py")),
            "--",
            str(staging / "request.json"),
        ]
        with (staging / "blender.log").open("w", encoding="utf-8") as log:
            with subprocess.Popen(
                command, env=env, stdout=log, stderr=subprocess.STDOUT
            ) as process:
                deadline = time.monotonic() + 240
                while process.poll() is None:
                    if (
                        cancelled is not None and cancelled.is_set()
                    ) or time.monotonic() > deadline:
                        process.kill()
                        process.wait()
                        raise RuntimeError(
                            "Generation cancelled"
                            if cancelled is not None and cancelled.is_set()
                            else "Blender generation timed out after 240 seconds"
                        )
                    time.sleep(0.1)
                returncode = process.returncode
        if returncode:
            tail = (staging / "blender.log").read_text(
                encoding="utf-8", errors="replace"
            )[-6000:]
            raise RuntimeError(f"Blender failed ({returncode}):\n{tail}")
        rig = json.loads((staging / "rig.json").read_text(encoding="utf-8"))
        manifest = write_package(
            staging,
            profile,
            rig,
            revision=MPFB_REVISION,
            avatar_id=avatar_id,
            version=version,
        )
        # Internal paths and isolated preferences are not published.
        for name in ("request.json", "rig.json"):
            (staging / name).unlink()
        shutil.rmtree(staging / "blender-user", ignore_errors=True)
        if cancelled is not None and cancelled.is_set():
            raise RuntimeError("Generation cancelled")
        staging.rename(output)
        return manifest
    finally:
        if staging.exists():
            shutil.rmtree(staging)
