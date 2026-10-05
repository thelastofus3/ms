from pathlib import Path
import numpy as np
import open3d as o3d
import pycolmap
import trimesh


def pose(image):
    value = image.cam_from_world
    if callable(value):
        value = value()
    result = np.eye(4)
    result[:3] = value.matrix()
    return result


def depth_map(path):
    with path.open("rb") as stream:
        header = bytearray()
        while header.count(b"&") < 3:
            byte = stream.read(1)
            if not byte or len(header) > 100:
                raise ValueError("Invalid COLMAP depth header")
            header.extend(byte)
        width, height, channels = [int(x) for x in header.decode().split("&")[:3]]
        if channels != 1 or width * height > 40_000_000:
            raise ValueError("Invalid COLMAP depth size")
        values = np.fromfile(stream, np.float32)
        if values.size != width * height:
            raise ValueError("Truncated depth map")
        return values.reshape((width, height), order="F").T.copy()


def triangulation_angles(reconstruction):
    centers = {image.image_id: np.linalg.inv(pose(image))[:3, 3]
               for image in reconstruction.images.values() if image.has_pose}
    angles = []
    for point in reconstruction.points3D.values():
        views = np.array([centers[element.image_id] for element in point.track.elements
                          if element.image_id in centers])
        if len(views) < 2 or not np.isfinite(point.xyz).all():
            continue
        # Axis extremes bound work for long tracks while including wide baselines.
        extremes = np.unique(np.concatenate((views.argmin(axis=0), views.argmax(axis=0))))
        rays = point.xyz - views[extremes]
        lengths = np.linalg.norm(rays, axis=1)
        rays = rays[lengths > 1e-12] / lengths[lengths > 1e-12, None]
        cosine = np.min(rays @ rays.T) if len(rays) >= 2 else 1.
        angles.append(float(np.degrees(np.arccos(np.clip(cosine, -1., 1.)))))
    return np.asarray(angles)


def validate_parallax(centers, angles, original_points, typical_depth):
    # Scale-independent checks: rotating in place cannot establish room depth.
    motion = float(np.linalg.norm(np.percentile(centers, 95, axis=0)-np.percentile(centers, 5, axis=0)))
    angle = float(np.median(angles)) if len(angles) else 0.
    if typical_depth <= 0 or motion / typical_depth < 0.01 or angle < 1.:
        raise ValueError("The camera stayed near one position or mostly rotated in place. "
                         "Different angles and a longer video do not establish reliable room depth. "
                         "Walk between several positions, keeping overlapping views of the same furniture and walls.")
    if len(angles) < max(100, int(original_points * 0.25)):
        raise ValueError("Too few points have reliable triangulation. Move the camera between positions "
                         "with overlapping views; stationary pans cannot produce a reliable walkable room.")
    return {"medianTriangulationAngleDegrees": angle, "cameraTranslationToDepthRatio": motion / typical_depth}


def filter_sparse_points(reconstruction):
    before = reconstruction.num_points3D()
    # COLMAP removes both the points and their image associations. In particular,
    # never leave near-camera or infinity points as splat initialization seeds.
    removed_observations = pycolmap.ObservationManager(reconstruction).filter_all_points3D(4., 1.)
    centers = {image.image_id: np.linalg.inv(pose(image))[:3, 3]
               for image in reconstruction.images.values() if image.has_pose}
    point_samples = []
    tracks = []
    for key, point in reconstruction.points3D.items():
        views = np.array([centers[element.image_id] for element in point.track.elements
                          if element.image_id in centers])
        if len(views) < 2:
            tracks.append((key, 0., 0.))
            continue
        distances = np.linalg.norm(point.xyz-views, axis=1)
        point_samples.append(float(np.median(distances)))
        tracks.append((key, float(np.min(distances)), float(np.linalg.norm(np.ptp(views, axis=0)))))
    typical_depth = float(np.median(point_samples)) if point_samples else 0.
    collapsed = [key for key, nearest, baseline in tracks
                 if nearest <= typical_depth * 1e-4 or baseline <= typical_depth * 1e-4]
    for key in collapsed:
        removed_observations += len(reconstruction.points3D[key].track.elements)
        reconstruction.delete_point3D(key)
    return {"filteredSparsePoints": before-reconstruction.num_points3D(),
            "filteredSparseObservations": removed_observations, "collapsedSparsePoints": len(collapsed)}


def model_report(model_path, image_count, reconstruction=None):
    if reconstruction is None:
        reconstruction = pycolmap.Reconstruction(str(model_path))
    points = np.array([p.xyz for p in reconstruction.points3D.values()])
    cameras = [np.linalg.inv(pose(image)) for image in reconstruction.images.values() if image.has_pose]
    if points.shape[0] < 100 or len(cameras) < max(10, int(image_count * 0.65)):
        raise ValueError("Too few camera poses could be reconstructed. Add overlapping views with camera movement.")
    errors = [p.error for p in reconstruction.points3D.values()]
    if not np.isfinite(points).all() or np.median(errors) > 3:
        raise ValueError("Camera reconstruction is inconsistent. Capture more slowly with stable lighting.")
    positions = np.array([c[:3, 3] for c in cameras])
    distances = [np.linalg.norm(point.xyz-positions[0]) for point in reconstruction.points3D.values()]
    parallax = validate_parallax(positions, triangulation_angles(reconstruction),
                                 len(points), float(np.median(distances)))
    extent = float(np.linalg.norm(np.percentile(points, 95, axis=0)-np.percentile(points, 5, axis=0)))
    if extent < 1e-6 or np.linalg.norm(np.ptp(positions, axis=0)) < extent * 0.005:
        raise ValueError("The camera barely translated. Walk around the room rather than recording a stationary pan.")
    first = sorted((image for image in reconstruction.images.values() if image.has_pose), key=lambda image: image.name)[0]
    camera = np.linalg.inv(pose(first))
    # OpenGL camera axes, with the original COLMAP world frame unchanged.
    camera[:3, 1:3] *= -1
    return {**parallax, "registeredFrames": len(cameras), "medianReprojectionError": float(np.median(errors)),
            "extent": extent, "previewCamera": camera.T.flatten().tolist()}


def sanitize_camera_depths(model_path: Path, image_count: int):
    """Reject numerically collapsed camera solutions before MVS and splat training."""
    reconstruction = pycolmap.Reconstruction(str(model_path))
    original_points = reconstruction.num_points3D()
    original_names = [image.name for image in reconstruction.images.values() if image.has_pose]
    filtered = {"filteredSparsePoints": 0, "filteredSparseObservations": 0, "collapsedSparsePoints": 0}
    excluded = []
    # Point filtering can leave a registered camera without usable observations.
    # Deregistration can then remove further point tracks. Iterate to a stable map.
    for _ in range(4):
        removed = filter_sparse_points(reconstruction)
        for key in filtered:
            filtered[key] += removed[key]
        stats = []
        for image in reconstruction.images.values():
            if not image.has_pose:
                continue
            ids = [point.point3D_id for point in image.points2D
                   if point.has_point3D() and point.point3D_id in reconstruction.points3D]
            points = np.array([reconstruction.points3D[key].xyz for key in ids])
            camera = pose(image)
            depths = points @ camera[2, :3] + camera[2, 3] if len(points) else np.array([])
            positive = depths[np.isfinite(depths) & (depths > 0)]
            stats.append((image.image_id, image.name, positive))
        medians = [float(np.median(depths)) for _, _, depths in stats if len(depths) >= 10]
        typical_depth = float(np.median(medians)) if medians else 0.
        rejected = [(image_id, name) for image_id, name, depths in stats if len(depths) < 10 or
                    float(np.median(depths)) <= typical_depth * 1e-4]
        remaining = len(stats)-len(rejected)
        if remaining < max(10, int(image_count * 0.65)):
            raise ValueError(f"Only {remaining}/{image_count} views have reliable camera depths. "
                             "Record overlapping views from different positions; rotating in place cannot establish room depth.")
        if not rejected:
            break
        for image_id, name in rejected:
            excluded.append(name)
            reconstruction.deregister_image(image_id)
    else:
        raise ValueError("Camera depth filtering did not converge. Capture overlapping views while moving between positions.")
    if reconstruction.num_points3D() < max(100, int(original_points * 0.25)):
        raise ValueError("Most reconstructed points have unreliable depth. Record overlapping views "
                         "from different camera positions; more time rotating in place cannot fix this.")
    report = model_report(model_path, image_count, reconstruction)
    changed = bool(excluded or filtered["filteredSparsePoints"] or filtered["filteredSparseObservations"])
    if changed:
        backup = model_path.parent.parent / "camera-model-before-depth-filter"
        if not backup.exists():
            backup.mkdir()
            pycolmap.Reconstruction(str(model_path)).write(str(backup))
        reconstruction.write(str(model_path))
    report.update(filtered)
    report["excludedDepthViews"] = sorted(excluded)
    report["unregisteredFrames"] = image_count - reconstruction.num_reg_images()
    # Any changed track may contribute to another view's cached stereo solution.
    return report, original_names if changed else []


def select_room_model(sparse: Path, image_count: int, work: Path):
    """Keep a dominant, quality-checked component; preserve outliers outside the dataset."""
    components = []
    for path in sorted(sparse.iterdir()):
        if path.is_dir():
            reconstruction = pycolmap.Reconstruction(str(path))
            components.append((path, reconstruction.num_reg_images(), reconstruction.num_points3D()))
    if not components:
        raise ValueError("No camera solution was reconstructed. Add overlapping views with camera movement.")
    components.sort(key=lambda item: (item[1], item[2]), reverse=True)
    selected, registered, _ = components[0]
    minimum = max(10, int(image_count * 0.65))
    if registered < minimum:
        sizes = ", ".join(str(count) for _, count, _ in components)
        raise ValueError(f"Camera views are disconnected: largest group has {registered}/{image_count} views "
                         f"(groups: {sizes}); at least {minimum} connected views are required. "
                         "Walk slowly through one room with overlapping views and camera movement.")
    report, _ = sanitize_camera_depths(selected, image_count)
    report["components"] = [{"model": path.name, "registeredFrames": count, "points": points,
                              "selected": path == selected} for path, count, points in components]
    report["unregisteredFrames"] = image_count - report["registeredFrames"]
    rejected = work / "discarded-camera-models"
    for path, _, _ in components[1:]:
        rejected.mkdir(exist_ok=True)
        path.rename(rejected / path.name)
    if selected.name != "0":
        selected.rename(sparse / "0")
    return report


def build_collision(dense: Path, output: Path, report, lease):
    reconstruction = pycolmap.Reconstruction(str(dense / "sparse"))
    extent = report["extent"]
    voxel = extent / 350
    volume = o3d.pipelines.integration.ScalableTSDFVolume(voxel_length=voxel, sdf_trunc=voxel*4,
                                                         color_type=o3d.pipelines.integration.TSDFVolumeColorType.NoColor)
    integrated = 0
    images = list(reconstruction.images.values())
    for index, image in enumerate(images):
        lease.check()
        lease.progress("Collision depths", "Integrating depth into collision surfaces", index, len(images), "depth views processed")
        depth_path = dense / "stereo" / "depth_maps" / (image.name+".geometric.bin")
        if not depth_path.exists():
            continue
        depth = depth_map(depth_path)
        depth[~np.isfinite(depth) | (depth <= 0) | (depth > extent*3)] = 0
        camera = reconstruction.cameras[image.camera_id]
        k = camera.calibration_matrix().copy()
        height, width = depth.shape
        k[0] *= width/camera.width
        k[1] *= height/camera.height
        intrinsic = o3d.camera.PinholeCameraIntrinsic(width, height, k[0, 0], k[1, 1], k[0, 2], k[1, 2])
        blank = np.zeros((height, width, 3), dtype=np.uint8)
        rgbd = o3d.geometry.RGBDImage.create_from_color_and_depth(o3d.geometry.Image(blank), o3d.geometry.Image(depth),
                                                               depth_scale=1.0, depth_trunc=extent*3, convert_rgb_to_intensity=False)
        volume.integrate(rgbd, intrinsic, pose(image))
        integrated += 1
    lease.progress("Collision mesh", "Extracting collision surfaces", force=True)
    mesh = volume.extract_triangle_mesh()
    mesh.remove_duplicated_vertices()
    mesh.remove_duplicated_triangles()
    mesh.remove_degenerate_triangles()
    mesh.remove_unreferenced_vertices()
    if integrated < 5 or len(mesh.triangles) < 100:
        raise ValueError("Not enough reliable depth for collisions. Capture the floor, walls and obstacles from more viewpoints.")
    labels, counts, _ = mesh.cluster_connected_triangles()
    labels, counts = np.asarray(labels), np.asarray(counts)
    mesh.remove_triangles_by_mask(counts[labels] < max(20, int(len(mesh.triangles)*0.0005)))
    mesh.remove_unreferenced_vertices()
    lease.progress("Collision mesh", "Simplifying collision triangles", force=True)
    mesh = mesh.simplify_quadric_decimation(target_number_of_triangles=60000)
    vertices = np.asarray(mesh.vertices)
    if not np.isfinite(vertices).all() or len(mesh.triangles) == 0:
        raise ValueError("Collision mesh is empty or invalid")
    scene = trimesh.Trimesh(vertices=vertices, faces=np.asarray(mesh.triangles), process=False)
    (output / "collision.glb").write_bytes(scene.export(file_type="glb"))
    # Suggest a floor; never silently treat a guessed plane as a reviewed floor.
    cloud = mesh.sample_points_uniformly(min(50000, len(mesh.triangles)*3))
    camera_poses = [np.linalg.inv(pose(image)) for image in reconstruction.images.values()]
    up = np.mean([-c[:3, 1] for c in camera_poses], axis=0)
    up /= max(np.linalg.norm(up), 1e-9)
    positions = np.array([c[:3, 3] for c in camera_poses])
    floor = None
    lease.progress("Floor proposal", "Finding a possible floor and walking boundary", force=True)
    for _ in range(6):
        lease.check()
        if len(cloud.points) < 100:
            break
        plane, inliers = cloud.segment_plane(distance_threshold=voxel*3, ransac_n=3, num_iterations=500)
        normal = np.array(plane[:3]); d = plane[3]
        if normal @ up < 0:
            normal, d = -normal, -d
        if normal @ up > 0.75 and np.median(positions @ normal+d) > extent*0.005:
            support = np.asarray(cloud.points)[inliers]
            center = np.median(support, axis=0)
            center -= normal * (normal @ center+d)
            forward = camera_poses[0][:3, 2].copy()
            forward -= normal * (normal @ forward)
            if np.linalg.norm(forward) < 1e-6:
                forward = np.cross(normal, [1, 0, 0])
                if np.linalg.norm(forward) < 1e-6:
                    forward = np.cross(normal, [0, 0, 1])
            forward /= np.linalg.norm(forward)
            right = np.cross(normal, forward)
            coordinates = np.column_stack(((support-center) @ right, (support-center) @ forward))
            low, high = np.percentile(coordinates, [2, 98], axis=0)
            coordinates = coordinates[np.all((coordinates >= low) & (coordinates <= high), axis=1)]
            from scipy.spatial import ConvexHull, QhullError
            try:
                hull = ConvexHull(coordinates)
                vertices_2d = coordinates[hull.vertices]
                if len(vertices_2d) > 64:
                    vertices_2d = vertices_2d[np.linspace(0, len(vertices_2d)-1, 64).astype(int)]
                boundary = [center+right*x+forward*z for x, z in vertices_2d]
                def point(value):
                    return dict(zip(("x", "y", "z"), map(float, value)))
                floor = {"normal": normal.tolist(), "point": center.tolist(), "supportPoints": len(inliers),
                         "floorPoints": [point(center), point(center+forward*extent*0.1), point(center+right*extent*0.1)],
                         "boundary": [point(p) for p in boundary], "spawn": point(center), "requiresReview": True}
            except QhullError:
                floor = {"normal": normal.tolist(), "point": center.tolist(), "supportPoints": len(inliers)}
            break
        cloud = cloud.select_by_index(inliers, invert=True)
    return {"triangles": len(mesh.triangles), "integratedDepthViews": integrated, "floorProposal": floor,
            "voxelSizeInReconstructionUnits": voxel, "requiresReview": True}
