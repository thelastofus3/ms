"""Commands on a graphics card that only a batch job can see (the LHC server, docs: GPU_STUDENT_GUIDE).

The worker itself runs where the network is (database, storage); a command that needs the card is written to `<dir>/run`
and started by touching `<state>/gpu-request`. The job sees the same data disk, has no network, at most 8 hours, 12 GB RAM
and 6 CPUs, starts only when 10 GB of the shared card are free, and reports in `<dir>/status.json`. One job at a time:
the room and avatar workers take `<dir>/dispatch.lock` around each command. Stdlib only (both workers import it).
"""
import fcntl
import json
import os
import re
import shlex
import time
from dataclasses import dataclass
from pathlib import Path

FINAL = {"finished", "refused_gpu_busy", "missing_run_script", "gpu_unavailable"}
# What a command may need from the worker's environment; database and storage secrets stay out of the job script.
PASSED = re.compile(r"^(PATH|LD_LIBRARY_PATH|PYTHONPATH|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE|TORCH_HOME|U2NET_HOME|HF_HOME|"
                    r"XDG_CACHE_HOME|MPLBACKEND|QT_QPA_PLATFORM|OMP_NUM_THREADS|OPENBLAS_NUM_THREADS|AVATAR_\w+)$")


def directory():
    value = os.environ.get("ROOM_GPU_BATCH", "")
    return Path(value) if value else None


def enabled():
    return directory() is not None


@dataclass
class Result:
    returncode: int  # the command's exit status; negative = killed by that signal
    outcome: str     # the batch service's result: success, exit-code, timeout (8 h limit), oom-kill, signal, ...

    @property
    def timed_out(self):
        return self.outcome == "timeout"

    @property
    def out_of_memory(self):
        return self.outcome == "oom-kill"


def device():
    """Name and memory of the card the last job saw, for reports (the worker's own process has no card)."""
    root = directory()
    try:
        name, mib = (root / "device.csv").read_text().strip().splitlines()[0].rsplit(",", 1)
        return {"name": name.strip(), "vramBytes": int(float(mib)) * 1024**2}
    except (TypeError, OSError, ValueError, IndexError):
        return {"name": "batch GPU", "vramBytes": 0}


def _script(root, args, cwd, log, env):
    values = {key: value for key, value in os.environ.items() if PASSED.match(key)}
    values.update({key: str(value) for key, value in (env or {}).items()})
    values.setdefault("PYTHONUNBUFFERED", "1")
    lines = ["#!/bin/bash", "# Written by the room/avatar worker for one command; replaced by the next one."]
    lines += [f"export {key}={shlex.quote(value)}" for key, value in sorted(values.items())]
    lines += [f"cd {shlex.quote(str(cwd))} || exit 97",
              f"nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits > {shlex.quote(str(root / 'device.csv'))} 2>/dev/null",
              f"echo \"== batch job $(date -Is) on $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null)\" >> {shlex.quote(str(log))}",
              f"exec {' '.join(shlex.quote(str(arg)) for arg in args)} >> {shlex.quote(str(log))} 2>&1", ""]
    temporary = root / "run.tmp"
    temporary.write_text("\n".join(lines))
    temporary.chmod(0o700)
    temporary.replace(root / "run")


def _sleep(seconds, tick, poll):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if tick:
            tick()
        time.sleep(min(poll, max(0., end - time.monotonic())))


def run(args, cwd, log, env=None, tick=None, waiting=None, poll=2., busy_retry=60., start_timeout=300.):
    """Run one command in a batch job and wait for it. `tick()` is called every `poll` seconds while waiting or running;
    whatever it raises stops the job (gpu-stop) and is raised again. `waiting(reason)` reports a queue: "turn" while the
    other worker's command runs, "busy" while the shared card lacks free memory."""
    root, state = directory(), Path(os.environ.get("ROOM_GPU_STATE", "/state/student2"))
    root.mkdir(parents=True, exist_ok=True)
    Path(log).parent.mkdir(parents=True, exist_ok=True)
    with open(root / "dispatch.lock", "a") as lock:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if waiting:
                    waiting("turn")
                _sleep(poll, tick, poll)
        while True:
            _script(root, args, cwd, log, env)
            status = _request(root, state, tick, poll, start_timeout)
            if status["state"] == "refused_gpu_busy":
                if waiting:
                    waiting("busy")
                _sleep(busy_retry, tick, poll)
                continue
            if status["state"] != "finished":
                raise RuntimeError({"missing_run_script": "The GPU job script was not accepted.",
                                    "gpu_unavailable": "The server's graphics card is unavailable; the administrator has to check it."}
                                   .get(status["state"], f"The GPU job ended in state {status['state']}."))
            code, kind = str(status.get("exit_status", "")), str(status.get("exit_code", "exited"))
            returncode = int(code) if code.lstrip("-").isdigit() else 1
            return Result(returncode if kind == "exited" else -abs(returncode) or -9, str(status.get("service_result", "")))


def _request(root, state, tick, poll, start_timeout):
    status_path = root / "status.json"
    status_path.unlink(missing_ok=True)
    (state / "gpu-request").touch()
    requested, stopping, stop_error, stop_deadline = time.monotonic(), False, None, 0.
    while True:
        try:
            status = json.loads(status_path.read_text())
        except (OSError, ValueError):
            status = None
        if status and status.get("state") in FINAL:
            if stop_error:
                raise stop_error
            return status
        if not status and not stopping and time.monotonic() - requested > start_timeout:
            raise RuntimeError("The GPU job did not start: GPU jobs may not be enabled for this account (see GPU_STUDENT_GUIDE).")
        if stopping and time.monotonic() > stop_deadline:
            raise stop_error
        if not stopping and tick:
            try:
                tick()
            except BaseException as error:  # cancel, lease loss, a limit: stop the job, then report the cause
                (state / "gpu-stop").touch()
                stopping, stop_error, stop_deadline = True, error, time.monotonic() + 120
        time.sleep(poll)
