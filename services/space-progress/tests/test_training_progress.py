import json
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

import monitor


class TrainingProgressTests(unittest.TestCase):
    def test_percent_uses_actual_schedule_instead_of_base_profile_steps(self):
        with tempfile.TemporaryDirectory() as directory:
            old_scratch = monitor.SCRATCH
            monitor.SCRATCH = Path(directory)
            try:
                root = monitor.SCRATCH / "test-job" / "test-attempt"
                (root / "logs").mkdir(parents=True)
                (root / "logs" / f"{time.time_ns()}-ns-train.log").write_text("Restored checkpoint step-15000.ckpt")
                (root / "checkpoint.json").write_text(json.dumps({"report": {"trainingSchedule": {"steps": 25000}}}))
                progress = monitor.observe({"id": "test-job", "lease_token": "test-attempt", "stage": "training",
                                            "profile": "local", "updated_at": datetime.now(timezone.utc)})
                self.assertEqual(progress["total"], 25000)
                self.assertEqual(progress["completed"], 15000)
                self.assertEqual(progress["percent"], 60.)
            finally:
                monitor.SCRATCH = old_scratch
                monitor.training_steps.pop("test-attempt", None)


if __name__ == "__main__":
    unittest.main()
