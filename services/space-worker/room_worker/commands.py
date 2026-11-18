import os
import signal
import subprocess
import time
from pathlib import Path
from . import gpu_batch
from .settings import MAX_SCRATCH_BYTES

# Tools that need the graphics card; with ROOM_GPU_BATCH set they run as batch jobs (see gpu_batch).
BATCH_TOOLS = {"colmap", "ns-train", "ns-export"}


def run(args, work: Path, lease, timeout=7200):
    """No shell; capture tool diagnostics and kill the complete process group on interruption."""
    lease.check()
    work.mkdir(parents=True, exist_ok=True)
    logs = work / "logs"
    logs.mkdir(exist_ok=True)
    path = logs / f"{time.time_ns()}-{Path(str(args[0])).name}.log"
    started = time.monotonic()
    if gpu_batch.enabled() and Path(str(args[0])).name in BATCH_TOOLS:
        return _run_batch(args, work, lease, timeout, path, started)
    with path.open("wb") as log:
        process = subprocess.Popen([str(x) for x in args], stdout=log, stderr=subprocess.STDOUT,
                                   stdin=subprocess.DEVNULL, start_new_session=True, cwd=work)
        try:
            tick = 0
            while process.poll() is None:
                lease.check()
                if time.monotonic() - started > timeout:
                    raise RuntimeError(f"This step ran longer than its {timeout // 60} minute limit on this computer. "
                                       "Finished work is saved: press Continue reconstruction, or use fewer or shorter clips.")
                if tick % 15 == 0:
                    size = sum(p.stat().st_size for p in work.rglob("*") if p.is_file())
                    if size > MAX_SCRATCH_BYTES or path.stat().st_size > 64 * 1024**2:
                        raise RuntimeError("Reconstruction exceeded scratch/log storage limit")
                tick += 1
                time.sleep(1)
            if process.returncode:
                _failed(args, path, process.returncode == -signal.SIGKILL)
        finally:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                except ProcessLookupError:
                    pass


def _limits(work, path, started, timeout):
    if time.monotonic() - started > timeout:
        raise RuntimeError(f"This step ran longer than its {timeout // 60} minute limit on this computer. "
                           "Finished work is saved: press Continue reconstruction, or use fewer or shorter clips.")
    size = sum(p.stat().st_size for p in work.rglob("*") if p.is_file())
    if size > MAX_SCRATCH_BYTES or (path.exists() and path.stat().st_size > 64 * 1024**2):
        raise RuntimeError("Reconstruction exceeded scratch/log storage limit")


def _failed(args, path, killed):
    tail = ""
    if path.exists():
        with path.open("rb") as error_log:
            error_log.seek(max(0, path.stat().st_size-16384))
            tail = error_log.read().decode(errors="replace")
    if "out of memory" in tail.lower():
        raise RuntimeError("The graphics card ran out of memory. Choose Standard detail, or close other programs that use the GPU and continue.")
    if killed:
        raise RuntimeError("The computer ran out of memory during this step. Finished work is saved: close other programs and press Continue reconstruction.")
    if "patch_match_options.depth_min > 0" in tail:
        raise RuntimeError("Depth estimation found an invalid camera depth range. "
                           "The camera model contains degenerate views; retry with the updated worker.")
    raise RuntimeError(f"{Path(str(args[0])).name} failed; see the worker log for details")


def _run_batch(args, work, lease, timeout, path, started):
    """The same command as a GPU batch job (only it sees the card); the worker keeps the lease and the limits meanwhile."""
    ticks = 0
    def tick():
        nonlocal ticks
        lease.check()
        if ticks % 15 == 0:
            _limits(work, path, started, timeout)
        ticks += 1
    def waiting(reason):
        lease.progress("Waiting for the graphics card", "The shared graphics card is busy with other work; this step starts when it is free"
                       if reason == "busy" else "Another build is using the graphics card; this step starts after it")
    restarts = 0
    while True:
        result = gpu_batch.run(args, work, path, tick=tick, waiting=waiting)
        # A batch job ends after 8 hours. COLMAP skips depth maps that are already written, so depth estimation goes on in a
        # new job (a map cut off mid-write is empty and removed first); anything else resumes from its checkpoint.
        if result.timed_out and len(args) > 1 and str(args[1]) == "patch_match_stereo" and restarts < 4:
            stereo = Path(str(args[args.index("--workspace_path") + 1])) / "stereo"
            for map_path in [p for folder in ("depth_maps", "normal_maps", "consistency_graphs") for p in (stereo/folder).glob("*.bin")]:
                if not map_path.stat().st_size:
                    map_path.unlink()
            restarts += 1
            continue
        break
    if result.timed_out:
        raise RuntimeError("This step reached the 8 hour limit of the shared graphics card. Finished work is saved: press Continue reconstruction.")
    if result.returncode:
        _failed(args, path, result.out_of_memory or result.returncode == -signal.SIGKILL)


def inspect_video(path):
    import json
    result = subprocess.run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
                            capture_output=True, timeout=30, check=True)
    metadata = json.loads(result.stdout)
    streams = [s for s in metadata.get("streams", []) if s.get("codec_type") == "video"]
    if len(streams) != 1:
        raise ValueError("Upload a video with one video stream")
    duration = float(metadata.get("format", {}).get("duration", 0))
    stream = streams[0]
    if not 3 <= duration <= 1200 or stream["width"] * stream["height"] > 40_000_000:
        raise ValueError("Video must be 3–1200 seconds and no more than 40 megapixels per frame")
    return duration
