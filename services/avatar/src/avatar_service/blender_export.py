"""Executed by Blender's Python, never imported by the API process."""

import json
import math
import struct
import sys
from pathlib import Path

import addon_utils
import bpy
from mathutils import Quaternion, Vector

BONES = {
    "hips": "pelvis",
    "spine": "spine_01",
    "chest": "spine_03",
    "neck": "neck_01",
    "head": "head",
    "leftShoulder": "clavicle_l",
    "leftUpperArm": "upperarm_l",
    "leftLowerArm": "lowerarm_l",
    "leftHand": "hand_l",
    "rightShoulder": "clavicle_r",
    "rightUpperArm": "upperarm_r",
    "rightLowerArm": "lowerarm_r",
    "rightHand": "hand_r",
    "leftUpperLeg": "thigh_l",
    "leftLowerLeg": "calf_l",
    "leftFoot": "foot_l",
    "rightUpperLeg": "thigh_r",
    "rightLowerLeg": "calf_r",
    "rightFoot": "foot_r",
}


def flat_material(obj, color):
    # Explicit Principled material works in glTF without Blender-specific shader groups.
    rgb = [int(color[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    material = bpy.data.materials.new(obj.name + "_PBR")
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*linear, 1)
    shader.inputs["Roughness"].default_value = 0.75
    obj.data.materials.clear()
    obj.data.materials.append(material)


def main():
    request = json.loads(
        Path(sys.argv[sys.argv.index("--") + 1]).read_text(encoding="utf-8")
    )
    profile, output, assets = (
        request["profile"],
        Path(request["output"]),
        Path(request["assets"]),
    )
    bpy.context.preferences.extensions.repos.new(
        name="Avatar", module="avatar", custom_directory=request["mpfb"]
    )
    addon_utils.enable("bl_ext.avatar.mpfb", default_set=True)
    from bl_ext.avatar.mpfb.services.exportservice import ExportService
    from bl_ext.avatar.mpfb.services.humanservice import HumanService
    from bl_ext.avatar.mpfb.services.objectservice import ObjectService
    from bl_ext.avatar.mpfb.services.targetservice import TargetService

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    macro = TargetService.get_default_macro_info_dict()
    macro.update({key: profile[key] for key in ("gender", "age", "muscle", "weight")})
    body = HumanService.create_human(macro_detail_dict=macro)
    body.name = "Body"
    targets = Path(request["mpfb"]) / "mpfb/data/targets"
    for key, paths in {
        "nose_width": ["nose/nose-scale-horiz"],
        "chin_width": ["chin/chin-width"],
        "eye_size": ["eyes/l-eye-scale", "eyes/r-eye-scale"],
    }.items():
        value = profile[key]
        if value:
            for path in paths:
                TargetService.load_target(
                    body,
                    str(
                        targets
                        / (path + ("-incr" if value > 0 else "-decr") + ".target.gz")
                    ),
                    weight=abs(value),
                )
    flat_material(body, profile["skin_color"])
    HumanService.add_builtin_rig(body, "game_engine")
    catalog = [
        ("eyes/low-poly/low-poly.mhclo", "Eyes", None),
        (
            "clothes/male_casualsuit01/male_casualsuit01.mhclo",
            "Clothes",
            profile["clothing_color"],
        ),
    ]
    if profile["hair"] == "short":
        catalog.append(("hair/short02/short02.mhclo", "Hair", profile["hair_color"]))
    for relative, kind, color in catalog:
        path = assets / relative
        if not path.is_file():
            raise RuntimeError(f"Required licensed asset not found: {relative}")
        obj = HumanService.add_mhclo_asset(
            str(path),
            body,
            asset_type=kind,
            material_type="GAMEENGINE",
            subdiv_levels=0,
        )
        if color:
            flat_material(obj, color)

    root = ExportService.create_character_copy(body, name_suffix="_export")
    export_body = ObjectService.find_object_of_type_amongst_nearest_relatives(
        root, "Basemesh"
    )
    objects = [root, *ObjectService.get_list_of_children(root)]
    for obj in objects:
        if obj.type == "MESH" and obj.data.shape_keys:
            mixed = obj.shape_key_add(name="BakedProfile", from_mix=True)
            coordinates = [point.co.copy() for point in mixed.data]
            obj.shape_key_clear()
            for vertex, coordinate in zip(obj.data.vertices, coordinates):
                vertex.co = coordinate
    ExportService.bake_modifiers_remove_helpers(
        export_body, bake_masks=True, bake_subdiv=True, remove_helpers=True
    )
    # Get the true visible body height after removing MPFB helper geometry.
    bpy.context.view_layer.update()
    points = [export_body.matrix_world @ v.co for v in export_body.data.vertices]
    low, high = min(v.z for v in points), max(v.z for v in points)
    scale = profile["height_m"] / (high - low)
    root.scale *= scale
    root.location.z = (root.location.z - low) * scale
    bpy.context.view_layer.update()
    rig = (
        root
        if root.type == "ARMATURE"
        else next(o for o in objects if o.type == "ARMATURE")
    )

    # In-place clips: world locomotion belongs exclusively to the controller.
    scene = bpy.context.scene
    scene.render.fps = 30
    for name in ("idle", "walk"):
        rig.animation_data_create()
        rig.animation_data.action = bpy.data.actions.new(name)
        for frame in range(1, 32, 5):
            phase = (frame - 1) / 30 * 2 * math.pi
            for semantic, bone_name in BONES.items():
                bone = rig.pose.bones[bone_name]
                angle = 0.0
                if name == "walk" and semantic in (
                    "leftUpperLeg",
                    "rightUpperLeg",
                    "leftUpperArm",
                    "rightUpperArm",
                ):
                    sign = 1 if semantic.startswith("left") else -1
                    angle = math.sin(phase) * 0.28 * sign
                    if "Arm" in semantic:
                        angle *= -1
                elif name == "idle" and semantic == "chest":
                    angle = math.sin(phase) * 0.012
                bone.rotation_mode = "QUATERNION"
                bone.rotation_quaternion = Quaternion(Vector((1, 0, 0)), angle)
                bone.keyframe_insert(
                    "rotation_quaternion", frame=frame, group=bone_name
                )
        action = rig.animation_data.action
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 1, action)
        rig.animation_data.action = None
        track.mute = True
    for bone in rig.pose.bones:
        bone.rotation_quaternion = (1, 0, 0, 0)
    scene.frame_set(1)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(
        filepath=str(output / "avatar.glb"),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_skins=True,
        export_all_influences=False,
        export_morph=False,
    )
    raw = (output / "avatar.glb").read_bytes()
    length = struct.unpack_from("<I", raw, 12)[0]
    doc = json.loads(raw[20 : 20 + length])
    by_name = {node.get("name"): i for i, node in enumerate(doc["nodes"])}
    parents = {
        child: i
        for i, node in enumerate(doc["nodes"])
        for child in node.get("children", [])
    }

    def world_rotation(index):
        rotation = doc["nodes"][index].get("rotation", [0, 0, 0, 1])
        local = Quaternion((rotation[3], *rotation[:3]))
        return world_rotation(parents[index]) @ local if index in parents else local

    bindings = {}
    for semantic, name in BONES.items():
        index = by_name[name]
        node = doc["nodes"][index]
        basis = world_rotation(index).inverted().normalized()
        bindings[semantic] = {
            "node": index,
            "rest": node.get("rotation", [0, 0, 0, 1]),
            "basis": [basis.x, basis.y, basis.z, basis.w],
        }
    (output / "rig.json").write_text(json.dumps(bindings), encoding="utf-8")


if __name__ == "__main__":
    main()
