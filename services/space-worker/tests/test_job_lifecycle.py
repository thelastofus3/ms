"""Exercise worker failure transitions without a GPU or a running PostgreSQL server."""
import importlib
import json
import sqlite3
import sys
import tempfile
import unittest
import uuid
from contextlib import nullcontext
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

from psycopg.types.json import Jsonb
from room_worker import jobs


class SqliteConnection:
    """Run the production failure UPDATE, adapting only driver placeholders/JSON."""
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def execute(self, statement, parameters):
        values = [json.dumps(value.obj) if isinstance(value, Jsonb) else value for value in parameters]
        return self.connection.execute(statement.replace("%s", "?"), values)


class JobFailureTests(unittest.TestCase):
    def setUp(self):
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        self.connection.create_function("now", 0, lambda: 100)
        self.connection.execute("""CREATE TABLE room_jobs (
            id TEXT PRIMARY KEY, state TEXT, lease_token TEXT, lease_until INTEGER,
            cancel_requested INTEGER, error TEXT, diagnostics TEXT, updated_at INTEGER)""")
        self.connection.execute("INSERT INTO room_jobs VALUES ('room', 'RUNNING', 'attempt', 101, 0, NULL, '{}', 90)")
        self.job = {"id": "room", "lease_token": "attempt", "profile": "local"}
        self.connect = patch.object(jobs, "connect", return_value=SqliteConnection(self.connection))
        self.connect.start()
        self.addCleanup(self.connect.stop)
        self.addCleanup(self.connection.close)

    def row(self):
        return dict(self.connection.execute("SELECT * FROM room_jobs").fetchone())

    def test_active_tool_failure_marks_failed_and_releases_lease(self):
        jobs.fail(self.job, "Invalid capture", {"workerError": "ValueError"})
        row = self.row()
        self.assertEqual(row["state"], "FAILED")
        self.assertEqual(row["error"], "Invalid capture")
        self.assertEqual(json.loads(row["diagnostics"]), {"workerError": "ValueError"})
        self.assertIsNone(row["lease_token"])
        self.assertIsNone(row["lease_until"])

    def test_expired_worker_cannot_prevent_attempt_recovery(self):
        for expired in (99, 100):
            with self.subTest(lease_until=expired):
                self.connection.execute("""UPDATE room_jobs SET state='RUNNING', lease_token='attempt',
                    lease_until=?, error=NULL, diagnostics='{}', updated_at=90""", (expired,))
                before = self.row()
                jobs.fail(self.job, "Worker interrupted", {"workerError": "Stopped"})
                self.assertEqual(self.row(), before)

    def test_superseded_worker_cannot_fail_replacement_attempt(self):
        self.connection.execute("UPDATE room_jobs SET lease_token='replacement'")
        before = self.row()
        jobs.fail(self.job, "Old attempt failed", {})
        self.assertEqual(self.row(), before)

    def test_published_job_is_not_overwritten_by_late_failure(self):
        self.connection.execute("UPDATE room_jobs SET state='NEEDS_CALIBRATION'")
        before = self.row()
        jobs.fail(self.job, "Late failure", {})
        self.assertEqual(self.row(), before)

    def test_requested_cancellation_settles_without_an_error(self):
        self.connection.execute("UPDATE room_jobs SET cancel_requested=1")
        jobs.fail(self.job, "Interrupted", {})
        row = self.row()
        self.assertEqual(row["state"], "CANCELLED")
        self.assertIsNone(row["error"])
        self.assertIsNone(row["lease_token"])

    def test_expired_cancelled_attempt_leaves_settlement_to_queue_recovery(self):
        self.connection.execute("UPDATE room_jobs SET cancel_requested=1, lease_until=99")
        before = self.row()
        jobs.fail(self.job, "Interrupted", {})
        self.assertEqual(self.row(), before)

    def run_interrupted_worker(self):
        # These startup dependencies are not used by the interrupted pipeline.
        # The real worker loop and failure UPDATE still execute below.
        pipeline = ModuleType("room_worker.pipeline")
        pipeline.reconstruct = lambda *_: (_ for _ in ()).throw(jobs.Stopped("Lease lost"))
        boto3 = ModuleType("boto3")
        boto3.client = lambda *_args, **_kwargs: SimpleNamespace()
        botocore = ModuleType("botocore")
        config = ModuleType("botocore.config")
        config.Config = lambda **_kwargs: None
        torch = ModuleType("torch")
        torch.cuda = SimpleNamespace(is_available=lambda: True, get_device_name=lambda _: "Test GPU")

        class EndIteration(Exception):
            pass

        with patch.dict(sys.modules, {"room_worker.pipeline": pipeline, "boto3": boto3,
                                     "botocore": botocore, "botocore.config": config, "torch": torch}):
            sys.modules.pop("room_worker.__main__", None)
            worker = importlib.import_module("room_worker.__main__")
            try:
                with (
                    tempfile.TemporaryDirectory() as directory,
                    patch.object(worker, "SCRATCH", Path(directory)),
                    patch.object(worker, "claim", return_value=self.job),
                    patch.object(worker, "Lease", return_value=nullcontext(SimpleNamespace())),
                    patch.object(worker.shutil, "which", return_value="available"),
                    patch.object(worker.time, "sleep", side_effect=EndIteration),
                    patch.object(worker.logging, "info"),
                    patch.object(worker.logging, "exception"),
                    self.assertRaises(EndIteration),
                ):
                    worker.main()
            finally:
                sys.modules.pop("room_worker.__main__", None)

    def test_lease_interruption_keeps_attempt_for_automatic_recovery(self):
        before = self.row()
        self.run_interrupted_worker()
        self.assertEqual(self.row(), before)

    def test_lease_interruption_honors_requested_cancellation(self):
        self.connection.execute("UPDATE room_jobs SET cancel_requested=1")
        self.run_interrupted_worker()
        self.assertEqual(self.row()["state"], "CANCELLED")
        self.assertIsNone(self.row()["error"])


class QueueKindTests(unittest.TestCase):
    def setUp(self):
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        connection.row_factory = sqlite3.Row
        connection.create_function("now", 0, lambda: 100)
        connection.executescript("""
            CREATE TABLE room_uploads(id TEXT PRIMARY KEY, media TEXT, owner TEXT,
                kind TEXT, sealed INTEGER, inputs_pinned INTEGER);
            CREATE TABLE room_quota_owners(owner TEXT PRIMARY KEY, initialized INTEGER);
            INSERT INTO room_quota_owners VALUES ('owner',1);
            CREATE TABLE room_jobs(id TEXT PRIMARY KEY, upload_id TEXT, kind TEXT, state TEXT,
                lease_until INTEGER, attempts INTEGER, cancel_requested INTEGER,
                error TEXT, lease_token TEXT, updated_at INTEGER, created_at INTEGER,
                stage TEXT, progress INTEGER, owner TEXT);
            INSERT INTO room_uploads VALUES ('upload', '[]', 'owner', 'capture', 1, 1);
            INSERT INTO room_jobs VALUES ('splat-queued','upload','splat','QUEUED',NULL,0,0,NULL,NULL,90,1,'queued',0,'owner');
            INSERT INTO room_jobs VALUES ('splat-expired','upload','splat','RUNNING',90,3,0,NULL,'old',90,2,'importing',0,'owner');
            INSERT INTO room_jobs VALUES ('capture','upload','capture','QUEUED',NULL,0,0,NULL,NULL,90,3,'queued',0,'owner');
        """)

        class Adapter:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def execute(self, statement, parameters=()):
                statement = statement.replace("%s", "?").replace("interval '120 seconds'", "120")
                statement = statement.replace("FOR UPDATE OF j SKIP LOCKED", "")
                cursor = connection.execute(statement, tuple(str(p) if isinstance(p, uuid.UUID) else p for p in parameters))
                return SimpleNamespace(fetchone=lambda: dict(row) if (row := cursor.fetchone()) else None)

        self.connection = connection
        self.connect = patch.object(jobs, "connect", return_value=Adapter())
        self.connect.start()
        self.addCleanup(self.connect.stop)

    def test_gpu_worker_skips_queued_and_expired_splat_imports(self):
        claimed = jobs.claim()
        self.assertEqual(claimed["id"], "capture")
        states = dict(self.connection.execute("SELECT id,state FROM room_jobs"))
        self.assertEqual(states["splat-queued"], "QUEUED")
        self.assertEqual(states["splat-expired"], "RUNNING")

    def test_gpu_worker_does_not_claim_unpinned_or_unsealed_uploads(self):
        for sealed, pinned in ((1, 0), (0, 0), (0, 1)):
            with self.subTest(sealed=sealed, inputs_pinned=pinned):
                self.connection.execute("UPDATE room_uploads SET sealed=?, inputs_pinned=?", (sealed, pinned))
                self.assertIsNone(jobs.claim())
                self.assertEqual(self.connection.execute("SELECT state FROM room_jobs WHERE id='capture'").fetchone()[0], "QUEUED")

    def test_gpu_worker_does_not_claim_another_owners_upload_or_a_splat_upload(self):
        for owner, kind in (("other", "capture"), ("owner", "splat")):
            with self.subTest(owner=owner, kind=kind):
                self.connection.execute("UPDATE room_uploads SET owner=?, kind=?", (owner, kind))
                self.assertIsNone(jobs.claim())

    def test_gpu_worker_waits_for_owner_storage_inventory_initialization(self):
        self.connection.execute("UPDATE room_quota_owners SET initialized=0")
        self.assertIsNone(jobs.claim())
        self.assertEqual(self.connection.execute("SELECT attempts FROM room_jobs WHERE id='capture'").fetchone()[0], 0)
        self.connection.execute("UPDATE room_quota_owners SET initialized=1")
        self.assertEqual(jobs.claim()["id"], "capture")


if __name__ == "__main__":
    unittest.main()
