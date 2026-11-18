import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from room_worker import gpu_batch


class FakeLab(threading.Thread):
    """The LHC side of the protocol: runs <dir>/run when gpu-request is touched, stops it on gpu-stop, writes status.json."""

    def __init__(self, root, state, refuse=0):
        super().__init__(daemon=True)
        self.root, self.state, self.refuse, self.done, self.runs = root, state, refuse, threading.Event(), 0

    def status(self, **values):
        (self.root / "status.json").write_text(json.dumps(values))

    def run(self):
        seen = None
        while not self.done.is_set():
            request = self.state / "gpu-request"
            stamp = request.stat().st_mtime_ns if request.exists() else None
            if stamp and stamp != seen:
                seen = stamp
                if self.refuse:
                    self.refuse -= 1
                    self.status(state="refused_gpu_busy", free_vram_mib=2000)
                    continue
                self.runs += 1
                self.status(state="running")
                stop = self.state / "gpu-stop"
                stopped_at = stop.stat().st_mtime_ns if stop.exists() else None
                process = subprocess.Popen(["bash", str(self.root / "run")])
                while process.poll() is None:
                    if stop.exists() and stop.stat().st_mtime_ns != stopped_at:
                        process.kill()
                    time.sleep(.05)
                code = process.returncode
                self.status(state="finished", exit_code="exited" if code >= 0 else "killed", exit_status=str(abs(code)),
                            service_result="success" if code == 0 else "exit-code" if code > 0 else "signal")
            time.sleep(.05)


class GpuBatchTest(unittest.TestCase):
    def setUp(self):
        temp = Path(tempfile.mkdtemp())
        self.root, self.state, self.work = temp / "gpu", temp / "state", temp / "work"
        for path in (self.root, self.state, self.work):
            path.mkdir()
        patcher = mock.patch.dict(os.environ, {"ROOM_GPU_BATCH": str(self.root), "ROOM_GPU_STATE": str(self.state),
                                               "ROOM_S3_SECRET_KEY": "do-not-leak"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def lab(self, **options):
        lab = FakeLab(self.root, self.state, **options)
        lab.start()
        self.addCleanup(lab.done.set)
        return lab

    def test_runs_the_command_in_its_directory_and_returns_its_status(self):
        self.lab()
        log = self.work / "logs" / "tool.log"
        result = gpu_batch.run(["sh", "-c", "pwd; echo $AVATAR_WORK; exit 3"], self.work, log, env={"AVATAR_WORK": "here"}, poll=.05)
        self.assertEqual(result.returncode, 3)
        self.assertEqual(result.outcome, "exit-code")
        lines = log.read_text().splitlines()
        self.assertEqual(lines[-2:], [str(self.work), "here"])
        self.assertNotIn("do-not-leak", (self.root / "run").read_text())

    def test_waits_while_the_shared_card_is_busy(self):
        lab = self.lab(refuse=2)
        reasons = []
        result = gpu_batch.run(["true"], self.work, self.work / "true.log", waiting=reasons.append, poll=.05, busy_retry=.1)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(reasons, ["busy", "busy"])
        self.assertEqual(lab.runs, 1)

    def test_a_cancel_stops_the_job_and_is_raised(self):
        self.lab()
        started = time.monotonic()
        def tick():
            if time.monotonic() - started > .5:
                raise InterruptedError("Cancelled")
        with self.assertRaises(InterruptedError):
            gpu_batch.run(["sleep", "30"], self.work, self.work / "sleep.log", tick=tick, poll=.05)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(json.loads((self.root / "status.json").read_text())["state"], "finished")

    def test_avatar_stage_output_is_read_from_the_job_log(self):
        import importlib.util, sys
        script = Path(__file__).resolve().parents[2] / "avatar" / "multiview" / "avatar_worker.py"
        spec = importlib.util.spec_from_file_location("avatar_worker_under_test", script)
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
        self.assertIs(worker.gpu_batch, gpu_batch)
        self.lab()
        lines, stage = [], {"label": "Masks"}
        code = "print('PROGRESS {\"fraction\": 0.5, \"message\": \"Ünïcode half\"}'); print('ERROR no person'); print('tail', end=''); raise SystemExit(2)"
        original = gpu_batch.run
        with mock.patch.object(worker.gpu_batch, "run", side_effect=lambda *a, **k: original(*a, **{**k, "poll": .05})):
            returncode = worker.run_batch([sys.executable, "-c", code], self.work, "masks", {"AVATAR_WORK": str(self.work)},
                                          lines.append, self.work, stage, lambda: None)
        self.assertEqual(returncode, 2)
        self.assertEqual([line for line in lines if not line.startswith("== batch job")],
                         ['PROGRESS {"fraction": 0.5, "message": "Ünïcode half"}\n', "ERROR no person\n", "tail\n"])

    def test_reports_when_batch_jobs_are_not_enabled(self):
        with self.assertRaisesRegex(RuntimeError, "did not start"):
            gpu_batch.run(["true"], self.work, self.work / "true.log", poll=.05, start_timeout=.3)


if __name__ == "__main__":
    unittest.main()
