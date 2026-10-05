"""Bounded CPU recovery for cross-camera room localization.

Only fixed, registered source cameras triangulate new background points. The
submitted frame supplies feature associations, never triangulation rays or an
update to the room map. Every returned camera passes the normal pose gates.
"""
import collections
import itertools
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
import time

import numpy as np
import pycolmap
from PIL import Image
from scipy.optimize import least_squares

from . import localizer as loc
from .localizer_models import DEFAULT_TORCH_HOME, ensure_localizer_models


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def reference(image, camera, scale):
    matrix = np.asarray(image.cam_from_world.matrix())
    rotation, translation = matrix[:, :3], matrix[:, 3]
    return {'name': image.name, 'camera': camera, 'matrix': matrix, 'rotation': rotation,
            'translation': translation, 'center': -rotation.T @ translation, 'scale': scale}


def observation(ref, pixels):
    pixels = np.asarray(pixels, dtype=float)
    normalized = np.asarray(ref['camera'].cam_from_img(pixels.reshape(1, 2)))[0]
    ray = ref['rotation'].T @ np.r_[normalized, 1.]
    ray /= np.linalg.norm(ray)
    return {'reference': ref, 'pixels': pixels, 'normalized': normalized, 'ray': ray}


def separated_pairs(observations):
    result = []
    for a, b in itertools.combinations(range(len(observations)), 2):
        first, second = observations[a], observations[b]
        baseline = float(np.linalg.norm(first['reference']['center']-second['reference']['center'])) * first['reference']['scale']
        angle = math.degrees(math.acos(float(np.clip(first['ray'] @ second['ray'], -1, 1))))
        if baseline >= .15 and 2 <= angle <= 150:
            result.append((angle, baseline, a, b))
    return sorted(result, reverse=True)


def pair_point(first, second):
    rows = []
    for item in (first, second):
        x, y = item['normalized']
        matrix = item['reference']['matrix']
        rows.extend((x*matrix[2]-matrix[0], y*matrix[2]-matrix[1]))
    _, _, right = np.linalg.svd(rows)
    homogeneous = right[-1]
    if abs(homogeneous[3]) < 1e-10:
        return None
    point = homogeneous[:3]/homogeneous[3]
    return point if np.isfinite(point).all() else None


def residuals(point, observations):
    residual = []
    for item in observations:
        ref = item['reference']
        position = ref['rotation'] @ point + ref['translation']
        if position[2]*ref['scale'] <= .01 or position[2]*ref['scale'] > 50:
            residual.extend((1000., 1000.))
        else:
            projected = np.asarray(ref['camera'].img_from_cam(position.reshape(1, 3)))[0]
            residual.extend(projected-item['pixels'])
    return np.asarray(residual)


def triangulate_track(observations, deadline):
    if len(observations) < 3:
        return None
    best = None
    for angle, baseline, a, b in separated_pairs(observations)[:96]:
        if time.monotonic() >= deadline:
            raise loc.LocalizationError('Additional room matching timed out. Show more static room background and retry.')
        point = pair_point(observations[a], observations[b])
        if point is None:
            continue
        error = np.linalg.norm(residuals(point, observations).reshape(-1, 2), axis=1)
        inliers = np.flatnonzero(error <= 3.)
        if len(inliers) < 3:
            continue
        score = (len(inliers), -float(np.median(error[inliers])), angle)
        if best is None or score > best[0]:
            best = score, point, inliers
    if best is None:
        return None
    _, point, inliers = best
    for _ in range(3):
        supported = [observations[i] for i in inliers]
        point = least_squares(residuals, point, args=(supported,), loss='soft_l1', f_scale=1.,
                              max_nfev=45, xtol=1e-8, ftol=1e-8, gtol=1e-8).x
        error = np.linalg.norm(residuals(point, observations).reshape(-1, 2), axis=1)
        updated = np.flatnonzero(error <= 3.)
        if len(updated) < 3:
            return None
        if np.array_equal(inliers, updated):
            break
        inliers = updated
    if not separated_pairs([observations[i] for i in inliers]):
        return None
    return point


def distinct_union(*sets):
    pixels, points = [], []
    for image_points, room_points in sets:
        for pixel, point in zip(image_points, room_points):
            # Different detectors must not inflate support for one image corner.
            if pixels and np.min(np.linalg.norm(np.asarray(pixels)-pixel, axis=1)) < 3.:
                continue
            pixels.append(pixel)
            points.append(point)
    return np.asarray(pixels).reshape(-1, 2), np.asarray(points).reshape(-1, 3)


def initial_references(database, model, query_name, limit=48):
    with sqlite3.connect(database) as db:
        query_id = db.execute('SELECT image_id FROM images WHERE name=?', (query_name,)).fetchone()[0]
        scores = {'two_view_geometries': [], 'matches': []}
        for image in model.images.values():
            pair = min(query_id, image.image_id)*loc.PAIR_BASE + max(query_id, image.image_id)
            for table in scores:
                row = db.execute(f'SELECT rows,cols,data FROM {table} WHERE pair_id=?', (pair,)).fetchone()
                mapped = 0
                if row and row[0] and row[1] == 2:
                    matches = np.frombuffer(row[2], np.uint32).reshape(-1, 2)
                    if query_id > image.image_id:
                        matches = matches[:, ::-1]
                    mapped = sum(i < len(image.points2D) and image.points2D[int(i)].has_point3D() and
                                 image.points2D[int(i)].point3D_id in model.points3D for i in matches[:, 1])
                scores[table].append((mapped, image.name))
    # Raw descriptor support provides retrieval even when pair geometry rejects
    # every view. It can never publish a pose without independent final checks.
    names = list(dict.fromkeys([name for count,name in sorted(scores['two_view_geometries'], reverse=True)[:4] if count] +
                              [name for count,name in sorted(scores['matches'], reverse=True)[:16] if count]))
    fallback = sorted(image.name for image in model.images.values())
    ordered = fallback[::max(1, len(fallback)//32)] + loc.rank_reference_names(database, model, query_name)
    return list(dict.fromkeys(names+ordered))[:limit]


def solve(pixels, points, folder, size, live_size):
    if len(pixels) < 12:
        return None
    scaling = max(live_size[0]/size[0], live_size[1]/size[1])
    np.savez(folder/'learned-pose-input.npz', image_points=pixels, room_points=points,
             size=size, focal=.9*max(size), max_error=min(4., 5/scaling))
    try:
        loc.solve_pose(folder/'learned-pose-input.npz', folder/'learned-pose.json')
    except loc.LocalizationError:
        return None
    return json.loads((folder/'learned-pose.json').read_text())


def plausible_hypothesis(pose, manifest, size, live_size):
    if not pose:
        return False
    count = sum(pose['inliers'])
    if count < 12 or count/len(pose['inliers']) < .25 or not pose['errors'] or np.sqrt(np.mean(np.asarray(pose['errors'])**2)) > 3:
        return False
    matrix = np.asarray(pose['pose'])
    camera = pycolmap.Camera(model='SIMPLE_RADIAL', width=size[0], height=size[1], params=pose['params'])
    try:
        loc.metric_geometry(camera, pycolmap.Rigid3d(pycolmap.Rotation3d(matrix[:, :3]), matrix[:, 3]),
                            manifest, live_size, count, 0.)
    except loc.LocalizationError:
        return False
    return True


def guided_raw(raw, hypothesis, size):
    pixels, points = raw
    if not len(pixels):
        return raw
    matrix = np.asarray(hypothesis['pose'])
    positions = points @ matrix[:, :3].T + matrix[:, 3]
    camera = pycolmap.Camera(model='SIMPLE_RADIAL', width=size[0], height=size[1], params=hypothesis['params'])
    projected = np.asarray(camera.img_from_cam(positions))
    mask = (positions[:, 2] > .01) & np.isfinite(projected).all(axis=1) & (np.linalg.norm(projected-pixels, axis=1) <= 4.)
    return pixels[mask], points[mask]


def improve_order(names, checked, model, hypothesis, scale):
    matrix = np.asarray(hypothesis['pose'])
    center, forward = -matrix[:, :3].T @ matrix[:, 3], matrix[:, :3].T @ np.array([0., 0., 1.])
    ranked = []
    for image in model.images.values():
        ref = reference(image, model.cameras[image.camera_id], scale)
        direction = ref['rotation'].T @ np.array([0., 0., 1.])
        ranked.append((np.linalg.norm(ref['center']-center)*scale+2*(1-direction@forward), image.name, ref['center']))
    extra, centers = [], []
    for _, name, location in sorted(ranked):
        if name not in names[:checked] and all(np.linalg.norm(location-c)*scale > .15 for c in centers):
            extra.append(name)
            centers.append(location)
            if len(extra) == 20:
                break
    return list(dict.fromkeys(names[:checked]+extra+names[checked:]))[:48]


def run(config_path, output_path, progress_path):
    config = json.loads(config_path.read_text())
    folder = output_path.parent
    deadline = time.monotonic()+225
    manifest, size, live_size = config['manifest'], tuple(config['size']), tuple(config['liveSize'])
    scale = np.linalg.norm(np.asarray(manifest['worldFromReconstruction']).reshape(4, 4, order='F')[:3, 0])
    model = pycolmap.Reconstruction(config['reference'])
    database = Path(config['database'])
    names = initial_references(database, model, config['queryName'])
    def progress(stage, completed, total, unit, activity):
        write_json(progress_path, {'stage': stage, 'completed': completed, 'total': total, 'unit': unit, 'activity': activity})
    progress('extract_features', 0, 1, 'camera frame', 'Finding additional static background details')
    # This environment and Torch hub selection are confined to the disposable
    # CPU process, leaving reconstruction's existing model cache unchanged.
    os.environ['TORCH_HOME'] = os.environ.get('ROOM_LOCALIZER_TORCH_HOME', DEFAULT_TORCH_HOME)
    weights = ensure_localizer_models()
    import torch
    from lightglue import ALIKED, LightGlue
    from lightglue.utils import load_image
    torch.set_num_threads(max(1, min(2, int(os.environ.get('ROOM_LOCALIZER_TORCH_THREADS', '2')))))
    torch.hub.set_dir(str(weights['aliked'].parent.parent))
    extractor = ALIKED(max_num_keypoints=2048).eval().cpu()
    matcher = LightGlue(features='aliked', flash=False).eval().cpu()
    with torch.inference_mode():
        query = extractor.extract(load_image(config['query']), resize=1024)
    query_pixels = query['keypoints'][0].numpy()
    tracks = collections.defaultdict(list)
    images = {image.name: image for image in model.images.values()}
    root = (Path(config['attempt'])/'dataset/images').resolve()
    masks = Path(config['attempt'])/'dataset/masks'
    pools = []
    for table in ('two_view_geometries', 'matches'):
        try:
            pools.append(loc.correspondences(database, model, config['queryName'], table=table, minimum=0))
        except loc.LocalizationError:
            pools.append((np.empty((0, 2)), np.empty((0, 3))))
    verified, raw = pools
    checked = 0
    while checked < len(names):
        if time.monotonic() >= deadline:
            raise loc.LocalizationError('Additional camera matching timed out. Retry with more static room background.')
        name = names[checked]
        image = images[name]
        camera = model.cameras[image.camera_id]
        path = (root/name).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise loc.LocalizationError('The room source images are unavailable. Reconstruct the room or use floor matching.')
        with torch.inference_mode():
            features = extractor.extract(load_image(path), resize=1024)
            matches = matcher({'image0': query, 'image1': features})['matches'][0].numpy()
        if not np.allclose(features['image_size'][0].numpy(), [camera.width, camera.height], atol=1):
            raise loc.LocalizationError('Room source image dimensions disagree with its camera map.')
        keypoints = features['keypoints'][0].numpy()
        mask_path = masks/Path(name).with_suffix('.png')
        mask = np.asarray(Image.open(mask_path).convert('L')) > 127 if mask_path.is_file() else None
        ref = reference(image, camera, scale)
        for qi, ri in matches:
            pixel = keypoints[ri]
            x, y = np.rint(pixel).astype(int)
            if mask is not None and (y < 0 or x < 0 or y >= mask.shape[0] or x >= mask.shape[1] or not mask[y, x]):
                continue
            item = observation(ref, pixel)
            if np.isfinite(item['ray']).all():
                tracks[int(qi)].append(item)
        checked += 1
        progress('match_room', checked, len(names), 'room views compared', 'Matching camera background using stronger image features')
        if checked not in (12, 24, 36, len(names)):
            continue
        progress('estimate_pose', 0, len(tracks), 'background tracks', 'Recovering static landmarks from registered room cameras')
        accepted = []
        for i, (qi, observations) in enumerate(tracks.items()):
            point = triangulate_track(observations, deadline)
            if point is not None:
                accepted.append((qi, point))
            if i % 32 == 0:
                progress('estimate_pose', i+1, len(tracks), 'background tracks', 'Recovering static landmarks from registered room cameras')
        learned = (query_pixels[[qi for qi,_ in accepted]], np.asarray([p for _,p in accepted]).reshape(-1, 3))
        hypothesis = solve(*learned, folder, size, live_size)
        sets = [distinct_union(verified, learned)]
        if plausible_hypothesis(hypothesis, manifest, size, live_size):
            sets.append(distinct_union(verified, guided_raw(raw, hypothesis, size), learned))
            names = improve_order(names, checked, model, hypothesis, scale)
        for pixels, points in sets:
            pose = solve(pixels, points, folder, size, live_size)
            if pose is None:
                continue
            try:
                loc.validated_registration(pose, pixels, manifest, size, live_size)
            except loc.LocalizationError:
                continue
            progress('validate_pose', sum(pose['inliers']), len(pose['inliers']), 'consistent background landmarks', 'Camera pose passed room, lens and background coverage checks')
            write_json(output_path, {'pose': pose, 'imagePoints': pixels.tolist(), 'referencesChecked': checked,
                                     'triangulatedPoints': len(accepted)})
            print(json.dumps({'cameraLocated': True, 'inliers': sum(pose['inliers']), 'referencesChecked': checked}), flush=True)
            return
    raise loc.LocalizationError('Static background could not validate a camera pose after additional feature matching. Keep the camera fixed, improve lighting and show more of this room before retrying.')


if __name__ == '__main__':
    try:
        run(*(Path(value) for value in sys.argv[1:4]))
    except Exception as error:
        print(f'Learned camera localization stopped: {type(error).__name__}', file=sys.stderr)
        sys.exit(1)
