"""Stage 5: canonical frame, 24-joint skeleton, skinning weights and the browser `gaussian-rig` package.

* Frame: y up, the person faces +z, x is the person's left, feet on y = 0, metres. The scale assumes a body height of
  AVATAR_HEIGHT_M (default 1.75 m) because photos alone carry no absolute scale.
* Skeleton: the SMPL-24 joint *hierarchy* (names/parents only, no SMPL model or weights) placed from triangulated
  MediaPipe landmarks. Rest pose = T-pose (arms along ±x); canonical_axis_angles rotate it into the captured pose.
* Skinning: distance to each bone segment, normalised by that body part's thickness, then smoothed over neighbouring
  Gaussians so a sleeve does not tear from the torso; top four bones per Gaussian.
Output: AVATAR_WORK/rig/{manifest.json, avatar.splat, indices.bin, weights.bin}, AVATAR_WORK/rig-report.json
"""
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

import numpy as np
from plyfile import PlyData
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation

from progress import report as progress

WORK = Path(os.environ.get("AVATAR_WORK", "/work"))
HEIGHT = float(os.environ.get("AVATAR_HEIGHT_M", "1.75"))
SH_C0 = 0.28209479177387814
NAMES = ["pelvis", "left_hip", "right_hip", "spine1", "left_knee", "right_knee", "spine2", "left_ankle", "right_ankle",
         "spine3", "left_foot", "right_foot", "neck", "left_collar", "right_collar", "head", "left_shoulder",
         "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist", "left_hand", "right_hand"]
PARENTS = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 20, 21]
J = {name: index for index, name in enumerate(NAMES)}


def fail(message):
    print(f"ERROR {message}", flush=True)
    sys.exit(1)


def unit(vector):
    return vector / np.linalg.norm(vector)


def rotation_between(a, b):
    """Shortest rotation taking direction a to direction b, as an axis-angle vector."""
    a, b = unit(a), unit(b)
    axis = np.cross(a, b)
    sine, cosine = np.linalg.norm(axis), float(np.clip(a @ b, -1, 1))
    if sine < 1e-9:
        return np.zeros(3) if cosine > 0 else np.pi * unit(np.cross(a, [0, 0, 1] if abs(a[2]) < 0.9 else [0, 1, 0]))
    return axis / sine * np.arctan2(sine, cosine)


def t_pose(captured):
    """Rest T-pose (arm chains straightened along ±x, everything else as captured) and the per-joint
    axis-angles that bend it back into the captured pose, in the viewer's FK convention (rig.ts)."""
    rest, angles = captured.copy(), np.zeros((len(captured), 3))
    for side, sign in (("left", 1.0), ("right", -1.0)):
        chain = [J[f"{side}_{name}"] for name in ("shoulder", "elbow", "wrist", "hand")]
        axis = np.array([sign, 0.0, 0.0])
        accumulated = np.eye(3)
        for parent, child in zip(chain, chain[1:]):
            rest[child] = rest[parent] + np.linalg.norm(captured[child] - captured[parent]) * axis
            # Local rotation (in the already-rotated parent frame) that bends this bone into the captured direction.
            local = rotation_between(axis, accumulated.T @ (captured[child] - captured[parent]))
            angles[parent] = local
            accumulated = accumulated @ Rotation.from_rotvec(local).as_matrix()
    return rest, angles


def forward_kinematics(rest, angles):
    """World joint positions for a pose, exactly as GaussianRig.world() in apps/web/src/gaussian/rig.ts."""
    rotations, positions = [], []
    for i, parent in enumerate(PARENTS):
        local = Rotation.from_rotvec(angles[i]).as_matrix()
        if parent < 0:
            rotations.append(local); positions.append(rest[i].copy())
        else:
            positions.append(positions[parent] + rotations[parent] @ (rest[i] - rest[parent]))
            rotations.append(rotations[parent] @ local)
    return np.asarray(positions)


def load_gaussians():
    vertex = PlyData.read(str(WORK / "export/person.ply"))["vertex"]
    get = lambda *names: np.column_stack([np.asarray(vertex[name], dtype=np.float64) for name in names])
    return {"xyz": get("x", "y", "z"), "dc": get("f_dc_0", "f_dc_1", "f_dc_2"), "opacity": np.asarray(vertex["opacity"], np.float64),
            "scale": get("scale_0", "scale_1", "scale_2"), "rot": get("rot_0", "rot_1", "rot_2", "rot_3")}


def main():
    skeleton = json.loads((WORK / "skeleton.json").read_text())
    transforms = json.loads(next((WORK / "training").rglob("dataparser_transforms.json")).read_text())
    # COLMAP world → trained (nerfstudio) frame, where the exported Gaussians live.
    T, s = np.asarray(transforms["transform"]), transforms["scale"]
    L = {int(k): s * (T[:, :3] @ np.asarray(v) + T[:, 3]) for k, v in skeleton["landmarks"].items()}
    g = load_gaussians()
    alpha = 1 / (1 + np.exp(-g["opacity"]))
    solid = g["xyz"][alpha > 0.3]
    progress(0.1, "Standing the person upright")

    mid = lambda a, b: (L[a] + L[b]) / 2
    up = unit(mid(11, 12) - mid(27, 28))
    left = L[23] - L[24]
    left = unit(left - (left @ up) * up)
    forward = np.cross(left, up)
    # MediaPipe "left" is the person's own left; the nose must then be in front of the ears.
    if (L[0] - mid(7, 8)) @ forward < 0:
        fail("The body orientation is inconsistent (front/back). Retake with the whole body visible.")
    R = np.vstack([left, up, forward])  # rows: canonical axes in trained coordinates
    heights = solid @ up
    floor = min(np.percentile(heights, 0.2), min(L[i] @ up for i in (29, 30, 31, 32) if i in L))
    top = np.percentile(heights, 99.8)
    scale = HEIGHT / (top - floor)
    feet = mid(27, 28)
    origin = feet - ((feet @ up) - floor) * up

    def canonical(points):
        return scale * (np.asarray(points) - origin) @ R.T

    C = {k: canonical(v) for k, v in L.items()}
    cm = lambda a, b: (C[a] + C[b]) / 2
    xyz = canonical(g["xyz"])

    # --- Joints in the captured pose (SMPL-24 hierarchy; positions from landmarks) ---
    pelvis = cm(23, 24)
    neck = cm(11, 12) + 0.2 * (cm(7, 8) - cm(11, 12))
    joints = {
        "pelvis": pelvis, "left_hip": C[23], "right_hip": C[24],
        "spine1": pelvis + 0.25 * (neck - pelvis), "spine2": pelvis + 0.5 * (neck - pelvis), "spine3": pelvis + 0.75 * (neck - pelvis),
        "left_knee": C[25], "right_knee": C[26], "left_ankle": C[27], "right_ankle": C[28],
        "neck": neck, "head": cm(7, 8),
        "left_collar": neck + 0.35 * (C[11] - neck), "right_collar": neck + 0.35 * (C[12] - neck),
        "left_shoulder": C[11], "right_shoulder": C[12], "left_elbow": C[13], "right_elbow": C[14],
        "left_wrist": C[15], "right_wrist": C[16],
    }
    for side, (wrist, pinky, index, ankle, toe) in {"left": (15, 17, 19, 27, 31), "right": (16, 18, 20, 28, 32)}.items():
        knuckles = (C[pinky] + C[index]) / 2 if pinky in C and index in C else C[wrist] + 0.08 * unit(C[wrist] - joints[f"{side}_elbow"])
        joints[f"{side}_hand"] = C[wrist] + 0.6 * (knuckles - C[wrist])
        tip = C[toe] if toe in C else C[ankle] + np.array([0, -0.05, 0.12])
        joints[f"{side}_foot"] = C[ankle] + 0.75 * (tip - C[ankle])
    captured = np.array([joints[name] for name in NAMES])

    rest, angles = t_pose(captured)

    # --- Skinning: distance to bone segments, scaled by part thickness ---
    progress(0.4, "Binding the surface to the skeleton")
    head_top = captured[J["head"]] + np.array([0, 0.14, 0])
    segments = [  # (owning joint, start, end, thickness in metres)
        ("pelvis", "pelvis", "spine1", 0.15), ("pelvis", "pelvis", "left_hip", 0.12), ("pelvis", "pelvis", "right_hip", 0.12),
        ("spine1", "spine1", "spine2", 0.16), ("spine2", "spine2", "spine3", 0.16), ("spine3", "spine3", "neck", 0.15),
        ("left_collar", "left_collar", "left_shoulder", 0.08), ("right_collar", "right_collar", "right_shoulder", 0.08),
        ("neck", "neck", "head", 0.07), ("head", "head", head_top, 0.11),
        ("left_hip", "left_hip", "left_knee", 0.085), ("right_hip", "right_hip", "right_knee", 0.085),
        ("left_knee", "left_knee", "left_ankle", 0.065), ("right_knee", "right_knee", "right_ankle", 0.065),
        ("left_ankle", "left_ankle", "left_foot", 0.055), ("right_ankle", "right_ankle", "right_foot", 0.055),
        ("left_foot", "left_foot", captured[J["left_foot"]] + 0.6 * (captured[J["left_foot"]] - captured[J["left_ankle"]]), 0.05),
        ("right_foot", "right_foot", captured[J["right_foot"]] + 0.6 * (captured[J["right_foot"]] - captured[J["right_ankle"]]), 0.05),
        ("left_shoulder", "left_shoulder", "left_elbow", 0.065), ("right_shoulder", "right_shoulder", "right_elbow", 0.065),
        ("left_elbow", "left_elbow", "left_wrist", 0.05), ("right_elbow", "right_elbow", "right_wrist", 0.05),
        ("left_wrist", "left_wrist", "left_hand", 0.045), ("right_wrist", "right_wrist", "right_hand", 0.045),
        ("left_hand", "left_hand", captured[J["left_hand"]] + 1.2 * (captured[J["left_hand"]] - captured[J["left_wrist"]]), 0.045),
        ("right_hand", "right_hand", captured[J["right_hand"]] + 1.2 * (captured[J["right_hand"]] - captured[J["right_wrist"]]), 0.045),
    ]
    point = lambda value: captured[J[value]] if isinstance(value, str) else value
    score = np.full((len(xyz), 24), np.inf)
    for owner, start, end, thickness in segments:
        a, b = point(start), point(end)
        t = np.clip(((xyz - a) @ (b - a)) / max((b - a) @ (b - a), 1e-12), 0, 1)
        distance = np.linalg.norm(xyz - (a + t[:, None] * (b - a)), axis=1) / thickness
        score[:, J[owner]] = np.minimum(score[:, J[owner]], distance)
    weights = np.exp(-2.0 * (score - score.min(axis=1, keepdims=True)) ** 2)
    weights /= weights.sum(axis=1, keepdims=True)
    # Smooth over close neighbours only (2.5 cm), so the left and right thighs never blend.
    tree = cKDTree(xyz)
    neighbours = tree.query(xyz, k=12, distance_upper_bound=0.025)[1]
    for _ in range(4):
        padded = np.vstack([weights, np.zeros((1, 24))])
        valid = neighbours < len(xyz)
        summed = padded[np.where(valid, neighbours, len(xyz))].sum(axis=1)
        weights = 0.5 * weights + 0.5 * summed / valid.sum(axis=1, keepdims=True)
    order = np.argsort(-weights, axis=1)[:, :4]
    selected = np.take_along_axis(weights, order, axis=1)
    retained = selected.sum(axis=1)
    selected = (selected / retained[:, None]).astype("<f4")
    selected[:, 0] += 1 - selected.sum(axis=1)  # exact float32 normalisation for the browser check

    # --- Gaussians into the canonical frame (position, scale, rotation, colour) ---
    progress(0.75, "Writing the animatable avatar")
    frame = Rotation.from_matrix(R)
    rotation = g["rot"][:, [1, 2, 3, 0]]  # PLY (w,x,y,z) → scipy (x,y,z,w)
    rotation = (frame * Rotation.from_quat(rotation / np.linalg.norm(rotation, axis=1, keepdims=True))).as_quat()[:, [3, 0, 1, 2]]
    rotation *= np.where(rotation[:, :1] < 0, -1, 1)
    rgba = np.column_stack([np.clip(0.5 + SH_C0 * g["dc"], 0, 1), alpha])
    records = np.concatenate([
        xyz.astype("<f4").view("u1").reshape(-1, 12),
        (np.exp(g["scale"]) * scale).astype("<f4").view("u1").reshape(-1, 12),
        np.clip(rgba * 255, 0, 255).round().astype("u1"),
        np.clip(rotation * 128 + 128, 0, 255).round().astype("u1"),
    ], axis=1)
    output = WORK / "rig"
    shutil.rmtree(output, ignore_errors=True); output.mkdir()
    files = {"avatar.splat": records.tobytes(), "indices.bin": order.astype("u1").tobytes(), "weights.bin": selected.tobytes()}
    for name, data in files.items():
        (output / name).write_bytes(data)
    left_arm = np.linalg.norm(captured[J["left_wrist"]] - captured[J["left_shoulder"]])
    right_arm = np.linalg.norm(captured[J["right_wrist"]] - captured[J["right_shoulder"]])
    left_leg = np.linalg.norm(captured[J["left_ankle"]] - captured[J["left_hip"]])
    right_leg = np.linalg.norm(captured[J["right_ankle"]] - captured[J["right_hip"]])
    report = {"assumedHeightM": HEIGHT, "metresPerTrainedUnit": scale, "gaussians": len(xyz),
              "armLengthM": [round(left_arm, 3), round(right_arm, 3)], "legLengthM": [round(left_leg, 3), round(right_leg, 3)],
              "armAsymmetry": abs(left_arm - right_arm) / max(left_arm, right_arm),
              "legAsymmetry": abs(left_leg - right_leg) / max(left_leg, right_leg),
              "retainedWeightMass": {"min": float(retained.min()), "median": float(np.median(retained))},
              "dominantBoneShare": {NAMES[i]: round(float(np.mean(order[:, 0] == i)), 3) for i in range(24)}}
    manifest = {
        "schema_version": 1, "representation": "gaussian-rig", "name": "Reconstructed avatar",
        "source": "Multi-view Gaussian reconstruction with triangulated MediaPipe skeleton",
        "num_splats": len(xyz), "model": "avatar.splat", "indices": "indices.bin", "weights": "weights.bin", "weight_count": 4,
        "rig": {"parents": PARENTS, "names": NAMES, "rest_joints": rest.round(5).tolist(), "canonical_axis_angles": angles.round(5).tolist()},
        "frame": {"up": "+y", "forward": "+z", "left": "+x", "units": "metres", "floorY": 0.0, "assumedHeightM": HEIGHT},
        "sha256": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=1))
    (WORK / "rig-report.json").write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1))
    if report["armAsymmetry"] > 0.15 or report["legAsymmetry"] > 0.15:
        print("WARNING limb lengths differ by more than 15 %; check skeleton.json", flush=True)
    progress(1.0, f"24-joint skeleton, {len(xyz):,} Gaussians bound (height set to {HEIGHT:.2f} m)",
             armAsymmetry=round(report["armAsymmetry"], 3), legAsymmetry=round(report["legAsymmetry"], 3))


if __name__ == "__main__":
    main()
