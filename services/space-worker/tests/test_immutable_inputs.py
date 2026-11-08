"""Input identity checks must finish before any media decoding or checkpoint reuse."""
import hashlib
import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

from room_worker import preprocess
from room_worker.settings import PROFILES

KEY = "sealed-inputs/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002"


class Lease:
    def check(self): pass
    def progress(self, *args, **kwargs): pass
    def stage(self, *args): pass


class Storage:
    bucket = "test"
    def __init__(self, data):
        self.data = data
        self.requested = []
    def download_file(self, bucket, key, target, Callback):
        self.requested.append(key)
        Path(target).write_bytes(self.data[key])
        Callback(len(self.data[key]))


class ImmutableInputTests(unittest.TestCase):
    def media(self, **changes):
        return {"key": KEY, "stagingKey": "inputs/old", "size": 4,
                "sha256": hashlib.sha256(b"good").hexdigest(), "contentType": "video/mp4", **changes}

    def prepare_error(self, item, data):
        with tempfile.TemporaryDirectory() as directory:
            storage = Storage(data)
            # A decoder error proves successful verification reached decoding;
            # corruption must instead raise its own ValueError beforehand.
            with patch.object(preprocess, "inspect_video", side_effect=RuntimeError("decoder reached")):
                try:
                    preprocess.prepare([item], storage, Path(directory), PROFILES["local"], Lease())
                except Exception as error:
                    return error, storage
        self.fail("Expected rejection or controlled decoder boundary")

    def test_equal_size_corruption_is_rejected_before_video_decode(self):
        error, _ = self.prepare_error(self.media(), {KEY: b"evil"})
        self.assertIsInstance(error, ValueError)
        self.assertRegex(str(error), "SHA-256|checksum")

    def test_snapshot_is_read_even_if_staging_has_been_replaced(self):
        error, storage = self.prepare_error(self.media(), {KEY: b"good", "inputs/old": b"evil"})
        self.assertEqual(str(error), "decoder reached")
        self.assertEqual(storage.requested, [KEY])

    def test_invalid_identity_is_rejected_before_downloading(self):
        for changes in ({"key": "inputs/old"}, {"sha256": "bad"}, {"sha256": "A" * 64},
                        {"key": "sealed-inputs/../escape"}, {"key": "sealed-inputs/a/b"}):
            with self.subTest(changes=changes):
                item = self.media(**changes)
                error, storage = self.prepare_error(item, {item["key"]: b"good"})
                self.assertIsInstance(error, ValueError)
                self.assertEqual(storage.requested, [])

    def test_size_mismatch_is_rejected_before_decode(self):
        error, _ = self.prepare_error(self.media(), {KEY: b"longer"})
        self.assertIsInstance(error, ValueError)
        self.assertRegex(str(error), "size")

    def test_invalid_identity_cannot_recover_a_matching_checkpoint(self):
        export = ModuleType("room_worker.export")
        export.compress = lambda *_: None
        export.digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        with patch.dict(sys.modules, {"room_worker.export": export}):
            sys.modules.pop("room_worker.pipeline", None)
            pipeline = importlib.import_module("room_worker.pipeline")
        self.addCleanup(lambda: sys.modules.pop("room_worker.pipeline", None))
        item = self.media(key="inputs/old")
        job = {"media": [item], "profile": "local"}
        tools = {"nerfstudio": "1.1.5", "gsplat": "1.4.0", "colmap": "3.9.1", "pycolmap": "3.11.1"}
        fingerprint = hashlib.sha256(json.dumps({"media": [item], "profile": PROFILES["local"],
            "tools": tools, "pipelineRevision": pipeline.PIPELINE_REVISION}, sort_keys=True).encode()).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / "old"
            (old / "dataset").mkdir(parents=True)
            (old / "dataset" / "proof").write_bytes(b"cached")
            (old / "checkpoint.json").write_text(json.dumps({"fingerprint": fingerprint, "stage": "poses",
                "files": {"dataset": {"proof": export.digest(old / "dataset" / "proof")}}, "report": {}}))
            work = root / "new"
            work.mkdir()
            try:
                pipeline.reconstruct(job, Storage({}), work, Lease())
            except Exception as error:
                self.assertIsInstance(error, ValueError)
            else:
                self.fail("Invalid input reached reconstruction")
            self.assertFalse((work / "dataset").exists())

    def test_checkpoint_recovery_requires_the_same_snapshot_and_hash(self):
        export = ModuleType("room_worker.export")
        export.compress = lambda *_: None
        export.digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        with patch.dict(sys.modules, {"room_worker.export": export}):
            sys.modules.pop("room_worker.pipeline", None)
            pipeline = importlib.import_module("room_worker.pipeline")
        self.addCleanup(lambda: sys.modules.pop("room_worker.pipeline", None))
        tools = {"nerfstudio": "1.1.5", "gsplat": "1.4.0", "colmap": "3.9.1", "pycolmap": "3.11.1"}
        old_item = self.media()
        class RecoveryBoundary(Lease):
            def stage(self, name, progress):
                if name == "geometry":
                    raise RuntimeError("checkpoint recovered")
        cases = (({}, pipeline.PIPELINE_REVISION, "checkpoint recovered"),
                 ({"sha256": hashlib.sha256(b"evil").hexdigest()}, pipeline.PIPELINE_REVISION, "decoder reached"),
                 ({"key": KEY[:-1] + "3"}, pipeline.PIPELINE_REVISION, "decoder reached"),
                 ({}, "video-overlap-shared-intrinsics-parallax-v2", "decoder reached"))
        for changes, revision, expected in cases:
            with self.subTest(changes=changes, revision=revision), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                old = root / "old"
                (old / "dataset").mkdir(parents=True)
                (old / "dataset" / "proof").write_bytes(b"cached")
                fingerprint = hashlib.sha256(json.dumps({"media": [old_item], "profile": PROFILES["local"],
                    "tools": tools, "pipelineRevision": revision}, sort_keys=True).encode()).hexdigest()
                (old / "checkpoint.json").write_text(json.dumps({"fingerprint": fingerprint, "stage": "poses",
                    "files": {"dataset": {"proof": export.digest(old / "dataset" / "proof")}},
                    "report": {"capture": {"selectedFrames": 12}}}))
                work = root / "new"
                work.mkdir()
                item = self.media(**changes)
                payload = b"evil" if "sha256" in changes else b"good"
                with patch.object(preprocess, "inspect_video", side_effect=RuntimeError("decoder reached")):
                    with self.assertRaisesRegex(RuntimeError, expected):
                        pipeline.reconstruct({"media": [item], "profile": "local"},
                            Storage({item["key"]: payload}), work, RecoveryBoundary())
                self.assertEqual((work / "dataset" / "proof").exists(), expected == "checkpoint recovered")


if __name__ == "__main__":
    unittest.main()
