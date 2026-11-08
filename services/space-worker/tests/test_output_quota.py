"""Exercise worker output admission and failure logs without GPU or external services."""
import importlib
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

from psycopg.types.json import Jsonb
from room_worker import jobs
from room_worker import output_quota


class WorkerOutputQuotaTests(unittest.TestCase):
    def setUp(self):
        self.connection = sqlite3.connect(":memory:")
        self.addCleanup(self.connection.close)
        self.connection.row_factory = sqlite3.Row
        self.connection.create_function("now", 0, lambda: 100)
        self.connection.execute("""CREATE TABLE room_jobs(id TEXT PRIMARY KEY, state TEXT, lease_token TEXT,
            lease_until INTEGER, cancel_requested INTEGER, error TEXT, diagnostics TEXT, updated_at INTEGER, owner TEXT)""")
        self.connection.execute("INSERT INTO room_jobs VALUES ('room','RUNNING','attempt',101,0,NULL,'{}',90,'owner')")
        self.connection.execute("""CREATE TABLE room_storage_allocations(object_key TEXT PRIMARY KEY, owner TEXT,
            resource_kind TEXT, resource_id TEXT, maximum_bytes INTEGER, confirmed_bytes INTEGER, released_at INTEGER,updated_at INTEGER)""")
        self.job = {"id": "room", "lease_token": "attempt", "profile": "local"}
        self.objects = {}
        self.reservations = []
        self.reject = True
        self.lost = False
        self.reject_size_above = None
        self.published = False
        test = self

        class Database:
            def __enter__(self): return self
            def __exit__(self, error_type, *_):
                if error_type is None and getattr(self, "pending", None):
                    test.reservations.append(self.pending)
                    for key, size in self.pending.items():
                        test.connection.execute("INSERT OR IGNORE INTO room_storage_allocations VALUES(?,'owner','job','room',?,NULL,NULL,90)", (key,size))
                    self.pending = None
            def execute(self, statement, parameters):
                if "room_reserve_job_outputs" in statement:
                    if test.lost:
                        return SimpleNamespace(fetchone=lambda: {"result": "LEASE_LOST"})
                    if test.reject:
                        return SimpleNamespace(fetchone=lambda: {"result": "QUOTA_EXCEEDED"})
                    if test.reject_size_above is not None and sum(parameters[-1].obj.values()) > test.reject_size_above:
                        return SimpleNamespace(fetchone=lambda: {"result": "QUOTA_EXCEEDED"})
                    self.pending = parameters[-1].obj
                    return SimpleNamespace(fetchone=lambda: {"result": "RESERVED"})
                values = [json.dumps(p.obj) if isinstance(p, Jsonb) else p for p in parameters]
                return test.connection.execute(statement.replace("%s", "?"), values)
        self.database = patch.object(jobs, "connect", return_value=Database())
        self.database.start()
        self.addCleanup(self.database.stop)

    def run_worker(self, *, reconstruct_error=False, upload_error=False):
        test = self
        pipeline = ModuleType("room_worker.pipeline")
        def reconstruct(job, storage, work, lease):
            (work / "logs").mkdir()
            (work / "logs" / "tool.log").write_bytes(b"failure details")
            if reconstruct_error:
                raise ValueError("capture rejected")
            output = work / "output"
            output.mkdir()
            (output / "manifest.json").write_bytes(b'{"title":"room"}')
            (output / "asset.bin").write_bytes(b"asset")
            return output, {}
        pipeline.reconstruct = reconstruct
        class Storage:
            def upload_file(self, path, bucket, key, **kwargs):
                if not test.reject and not test.lost:
                    test.assertTrue(any(key in batch for batch in test.reservations), "Write preceded reservation commit")
                test.objects[key] = Path(path).read_bytes()
                if upload_error:
                    raise OSError("uncertain write")
        boto3 = ModuleType("boto3")
        boto3.client = lambda *_args, **_kwargs: Storage()
        botocore = ModuleType("botocore")
        config = ModuleType("botocore.config")
        config.Config = lambda **_kwargs: None
        torch = ModuleType("torch")
        torch.cuda = SimpleNamespace(is_available=lambda: True, get_device_name=lambda _: "Test GPU")
        class Lease:
            def __init__(self, job): pass
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def check(self): pass
            def stage(self, *_): pass
            def progress(self, *_args, **_kwargs): pass
            def publish(self, *_): test.published = True
        class EndIteration(Exception): pass
        with patch.dict(sys.modules, {"room_worker.pipeline": pipeline, "boto3": boto3,
            "botocore": botocore, "botocore.config": config, "torch": torch}):
            sys.modules.pop("room_worker.__main__", None)
            worker = importlib.import_module("room_worker.__main__")
            try:
                with tempfile.TemporaryDirectory() as directory, patch.object(worker, "SCRATCH", Path(directory)), \
                        patch.object(worker, "claim", side_effect=[self.job, None]), patch.object(worker, "Lease", Lease), \
                        patch.object(worker.shutil, "which", return_value="available"), \
                        patch.object(worker.time, "sleep", side_effect=EndIteration), \
                        patch.object(worker.logging, "info"), patch.object(worker.logging, "exception"), \
                        self.assertRaises(EndIteration):
                    worker.main()
            finally:
                sys.modules.pop("room_worker.__main__", None)

    def test_refused_output_reservation_prevents_assets_and_manifest_writes(self):
        self.run_worker()
        self.assertEqual(self.objects, {})
        self.assertFalse(self.published)
        row = self.connection.execute("SELECT state,error FROM room_jobs").fetchone()
        self.assertEqual(row["state"], "FAILED")
        self.assertIn("quota", row["error"].lower())

    def test_failure_logs_cannot_bypass_storage_quota(self):
        self.run_worker(reconstruct_error=True)
        self.assertEqual(self.objects, {})
        self.assertEqual(self.connection.execute("SELECT state FROM room_jobs").fetchone()[0], "FAILED")

    def test_exact_output_batch_is_reserved_before_write_and_publication(self):
        self.reject = False
        self.run_worker()
        self.assertTrue(self.published)
        self.assertEqual(self.reservations, [{"outputs/room/attempt/asset.bin": 5,
                                            "outputs/room/attempt/manifest.json": 16}])

    def test_partial_storage_failure_does_not_release_its_reservation(self):
        self.reject = False
        self.run_worker(upload_error=True)
        self.assertFalse(self.published)
        self.assertTrue(self.reservations)
        self.assertEqual(self.connection.execute("SELECT state FROM room_jobs").fetchone()[0], "FAILED")

    def test_lost_reservation_lease_prevents_writes_and_keeps_attempt_for_recovery(self):
        self.lost = True
        self.run_worker()
        self.assertEqual(self.objects, {})
        self.assertFalse(self.published)
        self.assertEqual(self.connection.execute("SELECT state FROM room_jobs").fetchone()[0], "RUNNING")

    def test_failure_logs_are_counted_against_prior_attempt_output_allocations(self):
        self.reject = False
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "failure.log"
            path.write_bytes(b"x")
            allocations = {"outputs/room/attempt/asset.bin": 2147483648}
            with self.assertRaisesRegex(jobs.StorageQuotaExceeded, "2 GiB"):
                output_quota.reserve_files(self.job, [path], "outputs/room/attempt/logs/", allocations)
        self.assertEqual(self.reservations, [])
        self.assertEqual(allocations, {"outputs/room/attempt/asset.bin": 2147483648})

    def test_output_quota_refusal_does_not_start_a_smaller_log_publication(self):
        self.reject = False
        self.reject_size_above = 15
        self.run_worker()
        self.assertEqual(self.objects, {})
        self.assertFalse(self.published)

    def test_uncertain_reservation_commit_remains_in_later_attempt_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            asset = Path(directory) / "asset.bin"
            asset.write_bytes(b"abc")
            allocations = {}
            with patch.object(output_quota, "reserve_outputs", side_effect=OSError("Commit acknowledgement lost")):
                with self.assertRaises(OSError):
                    output_quota.reserve_files(self.job, [asset], "outputs/room/attempt/", allocations)
            self.assertEqual(allocations, {"outputs/room/attempt/asset.bin": 3})

    def test_successful_output_writes_confirm_bytes_without_reducing_reservations(self):
        self.reject = False
        self.run_worker()
        rows = self.connection.execute("SELECT object_key,maximum_bytes,confirmed_bytes,released_at FROM room_storage_allocations ORDER BY object_key").fetchall()
        self.assertEqual([tuple(row) for row in rows], [
            ("outputs/room/attempt/asset.bin",5,5,None), ("outputs/room/attempt/manifest.json",16,16,None)])

    def test_successful_failure_log_write_confirms_its_retained_bytes(self):
        self.reject = False
        self.run_worker(reconstruct_error=True)
        row = self.connection.execute("SELECT maximum_bytes,confirmed_bytes,released_at FROM room_storage_allocations").fetchone()
        self.assertEqual(tuple(row), (15,15,None))

    def test_uncertain_storage_write_retains_unconfirmed_reserved_bytes(self):
        self.reject = False
        self.run_worker(upload_error=True)
        rows = self.connection.execute("SELECT maximum_bytes,confirmed_bytes,released_at FROM room_storage_allocations").fetchall()
        self.assertTrue(rows)
        self.assertTrue(all(row[0]>0 and row[1] is None and row[2] is None for row in rows))


if __name__ == "__main__": unittest.main()
