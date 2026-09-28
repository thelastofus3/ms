import math

import pytest

from avatar_service.gaussian_rig import forward_joints, recover_rest_joints

IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
TURN = [[0, -1, 0], [1, 0, 0], [0, 0, 1]]


def test_forward_kinematics_rotates_descendant_around_parent():
    joints = forward_joints(
        [[0, 0, 0], [1, 0, 0], [2, 0, 0]], [TURN, IDENTITY, IDENTITY], [-1, 0, 1]
    )
    assert joints == [[0, 0, 0], [0, 1, 0], [0, 2, 0]]


def test_recover_rest_offsets_from_posed_joints():
    rest = recover_rest_joints(
        [[0, 0, 0], [0, 1, 0], [-1, 1, 0]], [TURN, TURN, IDENTITY], [-1, 0, 1]
    )
    assert rest == [[0, 0, 0], [1, 0, 0], [2, 0, 0]]


@pytest.mark.parametrize("parents", [[-1, 2, 1], [-1, -1, 0], [-1, 0]])
def test_invalid_hierarchy_is_rejected(parents):
    with pytest.raises(ValueError):
        recover_rest_joints([[0, 0, 0]] * 3, [IDENTITY] * 3, parents)


def test_nonfinite_data_is_rejected():
    with pytest.raises(ValueError):
        recover_rest_joints([[math.nan, 0, 0]], [IDENTITY], [-1])
