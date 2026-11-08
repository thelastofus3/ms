"""Rig math checks (run in the avatar-multiview image: python -m pytest /code/test_rig.py or python /code/test_rig.py)."""
import numpy as np

from rig import J, NAMES, forward_kinematics, rotation_between, t_pose


def a_pose():
    rng = np.random.default_rng(1)
    joints = rng.normal(0, 0.02, (24, 3)) + np.linspace([0, 0.9, 0], [0, 1.6, 0], 24)
    for side, sign in (("left", 1), ("right", -1)):
        shoulder = np.array([0.18 * sign, 1.42, 0.0])
        joints[J[f"{side}_shoulder"]] = shoulder
        joints[J[f"{side}_elbow"]] = shoulder + [0.2 * sign, -0.18, 0.03]
        joints[J[f"{side}_wrist"]] = joints[J[f"{side}_elbow"]] + [0.15 * sign, -0.2, 0.08]
        joints[J[f"{side}_hand"]] = joints[J[f"{side}_wrist"]] + [0.04 * sign, -0.06, 0.01]
    return joints


def test_t_pose_arms_are_horizontal_and_fk_returns_the_captured_pose():
    captured = a_pose()
    rest, angles = t_pose(captured)
    for side, sign in (("left", 1), ("right", -1)):
        for name in ("elbow", "wrist", "hand"):
            offset = rest[J[f"{side}_{name}"]] - rest[J[f"{side}_shoulder"]]
            assert offset[0] * sign > 0 and abs(offset[1]) < 1e-9 and abs(offset[2]) < 1e-9
    # The viewer renders Gaussians in the captured pose when given canonical_axis_angles.
    assert np.allclose(forward_kinematics(rest, angles), captured, atol=1e-9)
    # Zero angles reproduce the rest pose itself.
    assert np.allclose(forward_kinematics(rest, np.zeros((24, 3))), rest)


def test_rotation_between_handles_opposite_and_equal_directions():
    assert np.allclose(rotation_between([1, 0, 0], [1, 0, 0]), 0)
    vector = rotation_between([1, 0, 0], [-1, 0, 0])
    assert np.isclose(np.linalg.norm(vector), np.pi)
    assert len(NAMES) == 24


if __name__ == "__main__":
    test_t_pose_arms_are_horizontal_and_fk_returns_the_captured_pose()
    test_rotation_between_handles_opposite_and_equal_directions()
    print("rig tests passed")
