from __future__ import annotations

import math
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

BONE_NAMES = (
    "hips",
    "spine",
    "chest",
    "neck",
    "head",
    "leftShoulder",
    "leftUpperArm",
    "leftLowerArm",
    "leftHand",
    "rightShoulder",
    "rightUpperArm",
    "rightLowerArm",
    "rightHand",
    "leftUpperLeg",
    "leftLowerLeg",
    "leftFoot",
    "rightUpperLeg",
    "rightLowerLeg",
    "rightFoot",
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class AvatarProfile(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    height_m: float = Field(default=1.75, ge=1.2, le=2.3)
    gender: float = Field(default=0.5, ge=0, le=1)
    age: float = Field(default=0.4, ge=0, le=1)
    muscle: float = Field(default=0.5, ge=0, le=1)
    weight: float = Field(default=0.5, ge=0, le=1)
    nose_width: float = Field(default=0, ge=-1, le=1)
    chin_width: float = Field(default=0, ge=-1, le=1)
    eye_size: float = Field(default=0, ge=-1, le=1)
    skin_color: str = Field(default="#b98970", pattern=r"^#[0-9a-fA-F]{6}$")
    clothing_color: str = Field(default="#375a91", pattern=r"^#[0-9a-fA-F]{6}$")
    hair_color: str = Field(default="#382923", pattern=r"^#[0-9a-fA-F]{6}$")
    clothing: Literal["casual"] = "casual"
    hair: Literal["short", "none"] = "short"
    references: list[str] = Field(default_factory=list, max_length=4)

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, value):
        if not value.strip():
            raise ValueError("Name must not be blank")
        return value.strip()


def quaternion(value):
    if len(value) != 4 or not all(math.isfinite(x) for x in value):
        raise ValueError("Quaternion must have four finite components")
    if abs(sum(x * x for x in value) - 1) > 0.02:
        raise ValueError("Quaternion must be normalized")
    return value


class BoneBinding(StrictModel):
    node: int = Field(ge=0)
    rest: tuple[float, float, float, float]
    basis: tuple[float, float, float, float]
    _rotations = field_validator("rest", "basis")(quaternion)


class Manifest(StrictModel):
    avatar_id: UUID
    version: int = Field(default=1, ge=1)
    schema_version: Literal["1.0"] = "1.0"
    representation: Literal["skinned-glb"] = "skinned-glb"
    model_file: Literal["avatar.glb"] = "avatar.glb"
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    height_m: float = Field(ge=1.2, le=2.3)
    coordinates: Literal["RH_Y_UP_METRES_FORWARD_Z"] = "RH_Y_UP_METRES_FORWARD_Z"
    rig: dict[str, BoneBinding] = Field(
        json_schema_extra={
            "minProperties": len(BONE_NAMES),
            "maxProperties": len(BONE_NAMES),
            "propertyNames": {"enum": list(BONE_NAMES)},
        }
    )
    generator: str = "mpfb"
    generator_revision: str = ""
    clips: list[str] = Field(default_factory=list)

    @field_validator("rig")
    @classmethod
    def required_bones(cls, value):
        if set(value) != set(BONE_NAMES):
            raise ValueError("Missing or unknown semantic bones")
        if len({v.node for v in value.values()}) != len(value):
            raise ValueError("Bone nodes must be unique")
        return value


class PoseFrame(StrictModel):
    sequence: int = Field(ge=0)
    timestamp_ms: float = Field(ge=0)
    position: tuple[float, float, float] = (0, 0, 0)
    rotation: tuple[float, float, float, float] = (0, 0, 0, 1)
    joints: dict[str, tuple[float, float, float, float]] = Field(default_factory=dict)
    confidence: float = Field(default=1, ge=0, le=1)
    tracking_state: Literal["TRACKED", "UNCERTAIN", "LOST"] = "TRACKED"
    _rotation = field_validator("rotation")(quaternion)

    @field_validator("joints")
    @classmethod
    def joints_valid(cls, value):
        if set(value) - set(BONE_NAMES):
            raise ValueError("Unknown joint")
        for q in value.values():
            quaternion(q)
        return value
