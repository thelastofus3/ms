"""Forward/inverse joint kinematics, independent of licensed body templates."""

import math

SMPL_PARENTS = [
    -1,
    0,
    0,
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    9,
    9,
    12,
    13,
    14,
    16,
    17,
    18,
    19,
    20,
    21,
]
SMPL_NAMES = [
    "pelvis",
    "left_hip",
    "right_hip",
    "spine1",
    "left_knee",
    "right_knee",
    "spine2",
    "left_ankle",
    "right_ankle",
    "spine3",
    "left_foot",
    "right_foot",
    "neck",
    "left_collar",
    "right_collar",
    "head",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hand",
    "right_hand",
]


def _validate(joints, rotations, parents):
    if not joints or len(joints) != len(rotations) or len(joints) != len(parents):
        raise ValueError("Joint, rotation and parent counts must match")
    for index, parent in enumerate(parents):
        if (index == 0 and parent != -1) or (index > 0 and not 0 <= parent < index):
            raise ValueError("Parents must form an ordered, single-root hierarchy")
        if (
            len(joints[index]) != 3
            or len(rotations[index]) != 3
            or any(len(row) != 3 for row in rotations[index])
        ):
            raise ValueError("Expected 3D joints and 3x3 rotations")
        if not all(
            math.isfinite(v) for v in [*joints[index], *sum(rotations[index], [])]
        ):
            raise ValueError("Non-finite joint/rotation")


def _multiply(a, b):
    return [
        [sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)
    ]


def _rotate(rotation, vector):
    return [sum(row[k] * vector[k] for k in range(3)) for row in rotation]


def recover_rest_joints(posed, rotations, parents):
    """Invert FK for observed joint positions and local body rotations."""
    _validate(posed, rotations, parents)
    rest, world_rotations = [], []
    for index, parent in enumerate(parents):
        if parent < 0:
            rest.append(list(posed[index]))
            world_rotations.append(rotations[index])
        else:
            inverse = [list(row) for row in zip(*world_rotations[parent])]
            delta = [posed[index][axis] - posed[parent][axis] for axis in range(3)]
            offset = _rotate(inverse, delta)
            rest.append([rest[parent][axis] + offset[axis] for axis in range(3)])
            world_rotations.append(_multiply(world_rotations[parent], rotations[index]))
    return rest


def forward_joints(rest, rotations, parents):
    _validate(rest, rotations, parents)
    posed, world_rotations = [], []
    for index, parent in enumerate(parents):
        if parent < 0:
            posed.append(list(rest[index]))
            world_rotations.append(rotations[index])
        else:
            offset = [rest[index][axis] - rest[parent][axis] for axis in range(3)]
            delta = _rotate(world_rotations[parent], offset)
            posed.append([posed[parent][axis] + delta[axis] for axis in range(3)])
            world_rotations.append(_multiply(world_rotations[parent], rotations[index]))
    return posed
