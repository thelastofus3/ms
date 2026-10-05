import os
import signal
import subprocess
import time
from pathlib import Path
from .settings import MAX_SCRATCH_BYTES


def run(args, work: Path, lease, timeout=7200):
    """No shell; capture tool diagnostics and kill the complete process group on interruption."""
    lease.check()
    work.mkdir(parents=True, exist_ok=True)
    logs = work / "logs"
    logs.mkdir(exist_ok=True)
    path = logs / f"{time.time_ns()}-{Path(str(args[0])).name}.log"
    started = time.monotonic()
    with path.open("wb") as log:
        process = subprocess.Popen([str(x) for x in args], stdout=log, stderr=subprocess.STDOUT,
                                   stdin=subprocess.DEVNULL, start_new_session=True, cwd=work)
        try:
            tick = 0
            while process.poll() is None:
                lease.check()
                if time.monotonic() - started > timeout:
                    raise RuntimeError(f"{Path(str(args[0])).name} exceeded its stage time limit")
                if tick % 15 == 0:
                    size = sum(p.stat().st_size for p in work.rglob("*") if p.is_file())
                    if size > MAX_SCRATCH_BYTES or path.stat().st_size > 64 * 1024**2:
                        raise RuntimeError("Reconstruction exceeded scratch/log storage limit")
                tick += 1
                time.sleep(1)
            if process.returncode:
                with path.open("rb") as error_log:
                    error_log.seek(max(0, path.stat().st_size-16384))
                    tail = error_log.read().decode(errors="replace")
                if "out of memory" in tail.lower():
                    raise RuntimeError("GPU memory exhausted. Use the local profile or a GPU with more VRAM.")
                if "patch_match_options.depth_min > 0" in tail:
                    raise RuntimeError("Depth estimation found an invalid camera depth range. "
                                       "The camera model contains degenerate views; retry with the updated worker.")
                raise RuntimeError(f"{Path(str(args[0])).name} failed; see the worker log for details")
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
    if not 3 <= duration <= 300 or stream["width"] * stream["height"] > 40_000_000:
        raise ValueError("Video must be 3–300 seconds and no more than 40 megapixels per frame")
    return duration
