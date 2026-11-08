import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { GaussianRig, locomotionPose, type RigData } from "./rig";

// SMPL-24 hierarchy in a T-pose: y up, facing +z, x = the person's left (as rig.py exports).
const names = ["pelvis", "left_hip", "right_hip", "spine1", "left_knee", "right_knee", "spine2", "left_ankle", "right_ankle",
  "spine3", "left_foot", "right_foot", "neck", "left_collar", "right_collar", "head", "left_shoulder", "right_shoulder",
  "left_elbow", "right_elbow", "left_wrist", "right_wrist", "left_hand", "right_hand"];
const parents = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 20, 21];
const at: Record<string, number[]> = {
  pelvis: [0, 0.95, 0], left_hip: [0.09, 0.9, 0], right_hip: [-0.09, 0.9, 0], spine1: [0, 1.05, 0], left_knee: [0.1, 0.5, 0],
  right_knee: [-0.1, 0.5, 0], spine2: [0, 1.17, 0], left_ankle: [0.1, 0.08, 0], right_ankle: [-0.1, 0.08, 0], spine3: [0, 1.3, 0],
  left_foot: [0.1, 0.03, 0.12], right_foot: [-0.1, 0.03, 0.12], neck: [0, 1.45, 0], left_collar: [0.07, 1.42, 0],
  right_collar: [-0.07, 1.42, 0], head: [0, 1.6, 0], left_shoulder: [0.18, 1.42, 0], right_shoulder: [-0.18, 1.42, 0],
  left_elbow: [0.46, 1.42, 0], right_elbow: [-0.46, 1.42, 0], left_wrist: [0.71, 1.42, 0], right_wrist: [-0.71, 1.42, 0],
  left_hand: [0.79, 1.42, 0], right_hand: [-0.79, 1.42, 0],
};
const data: RigData = { parents, names, rest_joints: names.map(name => at[name]), canonical_axis_angles: names.map(() => [0, 0, 0]) };
const rig = new GaussianRig(data);
const joints = (pose: number[][]) => {
  const matrices = rig.matrices(pose);
  return Object.fromEntries(names.map((name, i) => [name, new Vector3().fromArray(at[name]).applyMatrix4(matrices[i])]));
};

describe("locomotionPose", () => {
  it("stands with the arms down along the body", () => {
    const j = joints(locomotionPose(data, 0, 0));
    for (const side of ["left", "right"]) {
      expect(j[`${side}_wrist`].y).toBeLessThan(j[`${side}_shoulder`].y - 0.3);
      expect(Math.abs(j[`${side}_wrist`].x)).toBeLessThan(0.45);
    }
    expect(j.left_ankle.z).toBeCloseTo(0, 6);
  });

  it("bends the forearms forward and alternates the legs while walking", () => {
    const quarter = joints(locomotionPose(data, -Math.PI / 2, 1)), threeQuarter = joints(locomotionPose(data, Math.PI / 2, 1));
    // Opposite gait phases put opposite feet forward (+z); each arm swings opposite to its own leg.
    expect(quarter.left_ankle.z - quarter.right_ankle.z).toBeGreaterThan(0.2);
    expect(threeQuarter.right_ankle.z - threeQuarter.left_ankle.z).toBeGreaterThan(0.2);
    expect(quarter.right_wrist.z).toBeGreaterThan(quarter.left_wrist.z);
    expect(threeQuarter.left_wrist.z).toBeGreaterThan(threeQuarter.right_wrist.z);
    for (const pose of [quarter, threeQuarter]) for (const side of ["left", "right"])
      expect(pose[`${side}_wrist`].z - pose[`${side}_elbow`].z).toBeGreaterThan(0.02);
  });
});
