import tempfile
import shutil
import unittest
from pathlib import Path

import cv2
import numpy as np
import pycolmap
from PIL import Image

from room_worker import preprocess, geometry
from room_worker import settings
from room_worker.settings import PROFILES


class CaptureQualityTests(unittest.TestCase):
    def test_more_usable_views_receive_proportional_bounded_training(self):
        schedule = getattr(settings, "training_schedule", None)
        self.assertIsNotNone(schedule)
        short = schedule(PROFILES["local"], 131)
        long = schedule(PROFILES["local"], 300)
        self.assertGreater(long["steps"], short["steps"])
        self.assertGreater(long["split_until"], short["split_until"])
        self.assertLess(long["split_until"], long["steps"])
        self.assertEqual(schedule(PROFILES["local"], 1000)["steps"], 30000)

    def test_long_video_retains_more_views_with_bounded_work(self):
        budget = getattr(preprocess, "video_frame_budget", lambda duration, profile: profile["frames"])
        self.assertGreater(budget(266, PROFILES["local"]), budget(114, PROFILES["local"]))
        self.assertLessEqual(budget(300, PROFILES["local"]), 360)

    def test_overlapping_bridge_is_kept_instead_of_only_sharp_endpoints(self):
        selector = getattr(preprocess, "select_video_frames", None)
        self.assertIsNotNone(selector, "Need overlap-aware video selection")
        rng = np.random.default_rng(9)
        texture = rng.integers(0, 256, (192, 700), dtype=np.uint8)
        frames = [preprocess.Frame(i, 100 + (100 if i in [0, 8] else 0), Path(str(i)), texture[:, i*30:i*30+256])
                  for i in range(9)]
        selected, report = selector(frames, 5)
        self.assertEqual(selected[0].index, 0)
        self.assertEqual(selected[-1].index, 8)
        self.assertTrue(any(2 <= frame.index <= 6 for frame in selected))
        self.assertLessEqual(len(selected), 5)
        self.assertGreater(report["overlapChecks"], 0)

    def test_photo_selection_is_not_subject_to_video_motion_filtering(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "sources"
            source.mkdir()
            media = []
            for index in range(12):
                path = source / f"{index}.png"
                Image.new("RGB", (320, 320), (index, 128, 128)).save(path)
                media.append({"key": str(path), "size": path.stat().st_size, "contentType": "image/png"})
            class Storage:
                bucket = "test"
                def download_file(self, bucket, key, target, Callback):
                    shutil.copyfile(key, target)
                    Callback(Path(key).stat().st_size)
            class Lease:
                def check(self): pass
                def progress(self, *args, **kwargs): pass
            (root / "work").mkdir()
            dataset, report = preprocess.prepare(media, Storage(), root / "work", PROFILES["local"], Lease())
            self.assertEqual(len(list((dataset / "images").glob("*.jpg"))), 12)
            self.assertEqual(report["selectedFrames"], 12)


class SparseQualityTests(unittest.TestCase):
    def test_camera_losing_its_support_after_point_filtering_is_not_kept_for_training(self):
        r = pycolmap.synthesize_dataset(pycolmap.SyntheticDatasetOptions(num_images=12, num_points3D=150))
        camera = next(iter(r.cameras.values()))
        points = np.column_stack((np.linspace(-.2, .2, 12), np.zeros(12), np.full(12, 2.)))
        for image_id, x in [(101, 0.), (102, 1e-8)]:
            pose = pycolmap.Rigid3d(pycolmap.Rotation3d(), np.array([-x, 0., 0.]))
            pixels = np.asarray(camera.img_from_cam(points + [-x, 0., 0.]))
            r.add_image(pycolmap.Image(f"unsupported-{image_id}.jpg", [pycolmap.Point2D(pixel) for pixel in pixels],
                                      pose, camera.camera_id, image_id))
            r.register_image(image_id)
        for index, point in enumerate(points):
            r.add_point3D(point, pycolmap.Track([pycolmap.TrackElement(101, index), pycolmap.TrackElement(102, index)]))
        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory) / "colmap" / "sparse" / "0"
            model.mkdir(parents=True)
            r.write(str(model))
            report, invalidated = geometry.sanitize_camera_depths(model, 14)
            loaded = pycolmap.Reconstruction(str(model))
            self.assertEqual(loaded.num_reg_images(), 12)
            self.assertIn("unsupported-101.jpg", report["excludedDepthViews"])
            self.assertTrue(invalidated)

    def test_collapsed_local_cluster_is_removed_even_with_good_reprojection_and_angle(self):
        r = pycolmap.synthesize_dataset(pycolmap.SyntheticDatasetOptions(num_images=12, num_points3D=150))
        camera = next(iter(r.cameras.values()))
        point = np.array([0., 0., 1e-7])
        track = []
        for image_id, x in [(101, 0.), (102, 1e-8)]:
            pose = pycolmap.Rigid3d(pycolmap.Rotation3d(), np.array([-x, 0., 0.]))
            pixel = np.asarray(camera.img_from_cam(pose * point)).reshape(2)
            image = pycolmap.Image(f"tiny-{image_id}.jpg", [pycolmap.Point2D(pixel)],
                                  pose, camera.camera_id, image_id)
            r.add_image(image)
            r.register_image(image_id)
            track.append(pycolmap.TrackElement(image_id, 0))
        point_id = r.add_point3D(point, pycolmap.Track(track))
        result = geometry.filter_sparse_points(r)
        self.assertNotIn(point_id, r.points3D)
        self.assertGreaterEqual(result["collapsedSparsePoints"], 1)
        self.assertFalse(r.images[101].points2D[0].has_point3D())

    def test_stationary_rotation_has_no_usable_triangulation(self):
        validate = getattr(geometry, "validate_parallax", None)
        self.assertIsNotNone(validate, "Need a parallax gate before dense reconstruction")
        centers = np.zeros((12, 3))
        with self.assertRaisesRegex(ValueError, "position|stationary|translation"):
            validate(centers, np.full(120, 0.01), 120, 10.)

    def test_translating_capture_passes_parallax_gate_at_any_scale(self):
        validate = getattr(geometry, "validate_parallax", None)
        self.assertIsNotNone(validate)
        centers = np.column_stack((np.linspace(0, 2, 12), np.zeros((12, 2))))
        for scale in [0.01, 1., 100.]:
            result = validate(centers * scale, np.full(120, 5.), 120, 10. * scale)
            self.assertAlmostEqual(result["medianTriangulationAngleDegrees"], 5.)

    def test_near_zero_baseline_points_are_removed_with_image_observations(self):
        clean = getattr(geometry, "filter_sparse_points", None)
        self.assertIsNotNone(clean, "Need triangulation filtering before splat initialization")
        reconstruction = pycolmap.synthesize_dataset(pycolmap.SyntheticDatasetOptions(num_images=12, num_points3D=150))
        point = next(iter(reconstruction.points3D.values()))
        observations = [(element.image_id, element.point2D_idx) for element in point.track.elements]
        # Force this point near infinity: rays to it become almost parallel.
        point.xyz = np.array([1e9, 1e9, 1e9])
        before = reconstruction.num_points3D()
        result = clean(reconstruction)
        self.assertLess(reconstruction.num_points3D(), before)
        self.assertGreaterEqual(result["filteredSparsePoints"], 1)
        for image_id, point_index in observations:
            self.assertFalse(reconstruction.images[image_id].points2D[point_index].has_point3D())


if __name__ == "__main__":
    unittest.main()
