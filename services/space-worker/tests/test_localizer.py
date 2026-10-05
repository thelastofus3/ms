import math
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pycolmap

from room_worker.localizer import LocalizationError, attempt_directory, copy_reference_database, floor_homography, metric_geometry, rank_reference_names, register_image, solve_pose, validated_registration


class CopyLease:
    def __init__(self):
        self.observations = []
    def check(self):
        pass
    def progress(self, completed, total, unit, activity, force=False):
        self.observations.append((completed, total))


class ReferenceDatabaseTests(unittest.TestCase):
    def test_private_backup_keeps_committed_rows_in_nonempty_wal(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source.db"
            destination = root / "copy" / "database.db"
            destination.parent.mkdir()
            with sqlite3.connect(source) as writer:
                writer.execute("PRAGMA journal_mode=WAL")
                writer.execute("PRAGMA wal_autocheckpoint=0")
                writer.execute("CREATE TABLE test (value TEXT)")
                writer.execute("INSERT INTO test VALUES ('committed WAL row')")
                writer.commit()
                self.assertGreater(Path(str(source) + "-wal").stat().st_size, 0)
                lease = CopyLease()
                copy_reference_database(source, destination, lease)
                with sqlite3.connect(destination) as copied:
                    self.assertEqual(copied.execute("SELECT value FROM test").fetchall(), [("committed WAL row",)])
                self.assertEqual(lease.observations[-1][0], lease.observations[-1][1])

    def test_checkpointed_map_copy_reports_monotonic_pages_and_preserves_source(self):
        import hashlib
        import sqlite3
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.db"
            destination = Path(folder) / "database.db"
            with sqlite3.connect(source) as writer:
                writer.execute("CREATE TABLE test (value BLOB)")
                writer.execute("INSERT INTO test VALUES (?)", (b"x" * (5 * 1024 * 1024),))
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            lease = CopyLease()
            copy_reference_database(source, destination, lease)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)
            counts = [item[0] for item in lease.observations]
            self.assertEqual(counts, sorted(counts))
            self.assertGreater(len(counts), 1)
            self.assertEqual(lease.observations[-1][0], lease.observations[-1][1])


class LocalizerGeometryTests(unittest.TestCase):
    def setUp(self):
        self.camera = pycolmap.Camera(model="SIMPLE_RADIAL", width=640, height=480,
                                     params=[500., 320., 240., 0.01])
        # Camera right/down/forward looking along world -Z from above the floor.
        self.rotation = np.diag([1., -1., -1.])
        self.center = np.array([2., 1.5, 3.])
        self.pose = pycolmap.Rigid3d(pycolmap.Rotation3d(self.rotation), -self.rotation @ self.center)
        self.manifest = {"worldFromReconstruction": np.eye(4).flatten(order="F").tolist(),
                         "navigation": {"floorY": 0., "boundary": [[0, 0], [4, 0], [4, 4], [0, 4]]}}

    def geometry(self, manifest=None):
        return metric_geometry(self.camera, self.pose, manifest or self.manifest, (1280, 960), 80, 0.7)

    def test_column_major_metric_transform_and_original_live_intrinsics(self):
        theta = .3
        rotation = np.array([[math.cos(theta), 0, math.sin(theta)], [0, 1, 0],
                             [-math.sin(theta), 0, math.cos(theta)]])
        transform = np.eye(4)
        transform[:3, :3] = 2 * rotation
        transform[:3, 3] = [-1, .2, 1]
        manifest = {**self.manifest, "worldFromReconstruction": transform.flatten(order="F").tolist()}
        geometry = self.geometry(manifest)
        np.testing.assert_allclose(list(geometry["center"].values()), 2 * rotation @ self.center + transform[:3, 3])
        np.testing.assert_allclose(np.array(geometry["worldFromCamera"]).reshape(3, 3), rotation @ self.rotation.T)
        self.assertEqual(geometry["intrinsics"], {"fx": 1000., "fy": 1000., "cx": 640., "cy": 480., "k1": .01, "k2": 0.})

    def test_undistorted_image_homography_hits_metric_floor(self):
        geometry = self.geometry()
        homography = np.array(floor_homography(geometry, 0., 1280, 960)).reshape(3, 3)
        world = np.array([1.2, 0., .5])
        camera_point = self.rotation @ (world - self.center)
        image = np.array([(1000 * camera_point[0] / camera_point[2] + 640) / 1280,
                          (1000 * camera_point[1] / camera_point[2] + 480) / 960, 1])
        projected = homography @ image
        np.testing.assert_allclose(projected[:2] / projected[2], world[[0, 2]], atol=1e-9)

    def test_nonuniform_or_reflected_world_transform_is_rejected(self):
        for linear in (np.diag([1., 2., 1.]), np.diag([-1., 1., 1.])):
            transform = np.eye(4)
            transform[:3, :3] = linear
            with self.assertRaises(LocalizationError):
                self.geometry({**self.manifest, "worldFromReconstruction": transform.flatten(order="F").tolist()})

    def test_camera_below_floor_is_rejected(self):
        pose = pycolmap.Rigid3d(pycolmap.Rotation3d(self.rotation), -self.rotation @ np.array([2, -.2, 3]))
        with self.assertRaises(LocalizationError):
            metric_geometry(self.camera, pose, self.manifest, (640, 480), 80, .7)

    def test_focal_aware_solver_recovers_known_pose_and_radial_lens(self):
        import json
        pycolmap.set_random_seed(0)
        points = np.random.default_rng(8).normal(size=(60, 3))
        points[:, 2] += 6
        pixels = self.camera.img_from_cam(points)
        with tempfile.TemporaryDirectory() as folder:
            source, target = Path(folder) / "input.npz", Path(folder) / "result.json"
            np.savez(source, image_points=pixels, room_points=points, size=[640, 480], focal=470., max_error=4.)
            solve_pose(source, target)
            result = json.loads(target.read_text())
        np.testing.assert_allclose(result["pose"], np.column_stack((np.eye(3), [0, 0, 0])), atol=1e-5)
        np.testing.assert_allclose(result["params"], self.camera.params, atol=1e-3)
        self.assertEqual(sum(result["inliers"]), 60)

    def test_exact_published_attempt_and_calibrated_manifest_use_same_map(self):
        job = "11111111-1111-1111-1111-111111111111"
        token = "22222222-2222-2222-2222-222222222222"
        with tempfile.TemporaryDirectory() as temporary:
            scratch = Path(temporary)
            for name in ("manifest.json", "manifest-v3-abcdef.json"):
                self.assertEqual(attempt_directory(f"outputs/{job}/{token}/{name}", job, scratch), scratch / job / token)

    def test_unrecognized_or_wrong_job_manifest_cannot_select_arbitrary_scratch(self):
        job = "11111111-1111-1111-1111-111111111111"
        token = "22222222-2222-2222-2222-222222222222"
        for key in (f"outputs/../{token}/manifest.json", f"outputs/{token}/{token}/manifest.json", "/scratch/x"):
            with self.assertRaises(LocalizationError):
                attempt_directory(key, job, Path("/scratch"))


class ProgressiveRegistrationTests(unittest.TestCase):
    """Exercise matching orchestration with real pose/coverage/metric validation.

    External feature extraction and its bounded solver subprocess are replaced
    by known numerical evidence, rather than performing SIFT in unit tests.
    """
    def setUp(self):
        self.camera = pycolmap.Camera(model="SIMPLE_RADIAL", width=640, height=480,
                                     params=[500., 320., 240., .01])
        self.manifest = {"worldFromReconstruction": np.eye(4).flatten(order="F").tolist(),
                         "navigation": {"floorY": 0., "boundary": [[0, 0], [4, 0], [4, 4], [0, 4]]}}
        self.pose = np.column_stack((np.diag([1., -1., -1.]), [-2., 1.5, 3.])).tolist()

    def points(self, count, narrow=False):
        pixels = np.random.default_rng(4).uniform([40, 40], [600, 440], size=(count, 2))
        if narrow:
            pixels = 300 + pixels * .02
        return pixels, np.zeros((count, 3))

    def registration(self, evidence, rms=1., failures=0):
        import json
        from PIL import Image
        import room_worker.localizer as localizer
        records = {"matched": [], "solves": 0}
        lease = CopyLease()
        lease.deadline = __import__("time").monotonic() + 600
        lease.stages = []
        lease.stage = lease.stages.append
        lease.progress = lambda completed, total, unit, activity, force=False: lease.observations.append((completed, total, activity))
        references = SimpleNamespace(images={i: SimpleNamespace(name=f"{i:05d}.jpg") for i in range(64)},
                                     cameras={1: self.camera})
        def command(args, temporary, active_lease, timeout, message):
            if args[1] == "matches_importer":
                records["matched"].extend((temporary / "pairs.txt").read_text().splitlines())
            elif "--solve-pose" in args:
                records["solves"] += 1
                if records["solves"] <= failures:
                    raise LocalizationError("An early candidate could not be solved")
                data = np.load(temporary / "pose-input.npz", allow_pickle=False)
                count = len(data["image_points"])
                (temporary / "pose-result.json").write_text(json.dumps({"pose": self.pose,
                    "params": self.camera.params.tolist(), "inliers": [True] * count, "errors": [rms] * count}))
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            query = root / "source.jpg"
            Image.new("RGB", (640, 480)).save(query)
            with patch.object(localizer, "copy_reference", return_value=(root / "database.db", references)), \
                 patch.object(localizer, "run_command", side_effect=command), \
                 patch.object(localizer, "correspondences", side_effect=evidence):
                result = register_image(root, query, self.manifest, (640, 480), root, lease)
        return result, records, lease

    def test_strong_broad_pose_finishes_without_claiming_all_views_checked(self):
        result, records, lease = self.registration([self.points(150)])
        self.assertEqual(len(records["matched"]), 4)
        self.assertEqual(records["solves"], 1)
        self.assertEqual(result["geometry"]["inliers"], 150)
        self.assertEqual(lease.observations[-1][:2], (4, 64))
        self.assertIn("sufficient", lease.observations[-1][2].lower())

    def test_weak_early_evidence_keeps_original_complete_search_thresholds(self):
        result, records, lease = self.registration([self.points(30)] * 4, rms=5.)
        self.assertEqual(len(records["matched"]), 64)
        self.assertEqual(len(set(records["matched"])), 64)
        self.assertEqual([item[0] for item in lease.observations if item[2] == "Comparing camera background with room viewpoints"],
                         [0, 4, 16, 32, 48, 64])
        self.assertEqual(records["solves"], 1)
        self.assertEqual(result["geometry"]["inliers"], 30)
        self.assertEqual(result["geometry"]["reprojectionErrorPx"], 5.)

    def test_narrow_early_hypotheses_keep_searching_until_broad_evidence(self):
        result, records, lease = self.registration([self.points(150, narrow=True)] * 3 + [self.points(150)])
        self.assertEqual(len(records["matched"]), 64)
        self.assertEqual(records["solves"], 4)
        self.assertEqual(result["geometry"]["inliers"], 150)

    def test_unsolved_early_candidate_does_not_abort_remaining_search(self):
        result, records, lease = self.registration([self.points(150)] * 2, failures=1)
        self.assertEqual(len(records["matched"]), 16)
        self.assertEqual(records["solves"], 2)
        self.assertEqual(result["geometry"]["inliers"], 150)

    def test_high_error_early_pose_continues_to_final_search(self):
        result, records, lease = self.registration([self.points(150)] * 4, rms=4.)
        self.assertEqual(len(records["matched"]), 64)
        self.assertEqual(records["solves"], 4)
        self.assertEqual(result["geometry"]["reprojectionErrorPx"], 4.)

    def test_low_inlier_ratio_is_rejected_early_but_final_ratio_point_two_survives(self):
        points, _ = self.points(150)
        result = {"pose": self.pose, "params": self.camera.params.tolist(),
                  "inliers": [True] * 30 + [False] * 120, "errors": [1.] * 30}
        final = validated_registration(result, points, self.manifest, (640, 480), (640, 480))
        self.assertEqual(final["geometry"]["inliers"], 30)
        with self.assertRaises(LocalizationError):
            validated_registration(result, points, self.manifest, (640, 480), (640, 480), strong=True)
        points, _ = self.points(300)
        result.update(inliers=[True] * 100 + [False] * 200, errors=[1.] * 100)
        with self.assertRaises(LocalizationError):
            validated_registration(result, points, self.manifest, (640, 480), (640, 480), strong=True)


class ReferenceRankingTests(unittest.TestCase):
    def ranking(self, query, descriptors):
        import sqlite3
        references = SimpleNamespace(images={3: SimpleNamespace(name="c.jpg"),
                                             1: SimpleNamespace(name="a.jpg"),
                                             2: SimpleNamespace(name="b.jpg")})
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / "database.db"
            with sqlite3.connect(database) as writer:
                writer.execute("CREATE TABLE images (image_id INTEGER, name TEXT)")
                writer.execute("CREATE TABLE descriptors (image_id INTEGER, rows INTEGER, cols INTEGER, data BLOB)")
                writer.execute("INSERT INTO images VALUES (99, 'query.jpg')")
                for key, data in [(99, query)] + list(descriptors.items()):
                    if data is not None:
                        writer.execute("INSERT INTO descriptors VALUES (?,?,?,?)", (key, *data.shape, data.tobytes()))
            before = database.read_bytes()
            result = rank_reference_names(database, references, "query.jpg")
            self.assertEqual(database.read_bytes(), before)
            return result

    def test_identical_query_descriptor_summary_ranks_its_reference_first(self):
        query = np.zeros((10, 128), np.uint8)
        query[:, 7] = 100
        other = np.zeros((10, 128), np.uint8)
        other[:, 9] = 100
        self.assertEqual(self.ranking(query, {1: other, 2: query, 3: None}), ["b.jpg", "a.jpg", "c.jpg"])

    def test_missing_or_zero_query_has_stable_complete_fallback(self):
        for query in (None, np.zeros((10, 128), np.uint8)):
            self.assertEqual(self.ranking(query, {}), ["a.jpg", "b.jpg", "c.jpg"])

    def test_degenerate_reference_and_tied_scores_remain_in_complete_order(self):
        query = np.ones((10, 128), np.uint8)
        self.assertEqual(self.ranking(query, {1: query, 2: query, 3: np.zeros((10, 128), np.uint8)}),
                         ["a.jpg", "b.jpg", "c.jpg"])


if __name__ == "__main__":
    unittest.main()
