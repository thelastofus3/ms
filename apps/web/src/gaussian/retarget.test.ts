import { describe, expect, it } from "vitest";
import { Matrix4, Vector3 } from "three";
import { GaussianRig, type RigData } from "./rig";
import { bodyInRoom, PoseFollower, retargetBody, type BodyPoints } from "./retarget";

const names = ["pelvis", "left_hip", "right_hip", "spine1", "left_knee", "right_knee", "spine2", "left_ankle", "right_ankle",
  "spine3", "left_foot", "right_foot", "neck", "left_collar", "right_collar", "head", "left_shoulder", "right_shoulder",
  "left_elbow", "right_elbow", "left_wrist", "right_wrist", "left_hand", "right_hand"];
const parents = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 20, 21];
const at: Record<string, number[]> = {
  pelvis: [0, 0.95, 0], left_hip: [0.09, 0.9, 0], right_hip: [-0.09, 0.9, 0], spine1: [0, 1.05, 0], left_knee: [0.1, 0.5, 0.01],
  right_knee: [-0.1, 0.5, 0.01], spine2: [0, 1.17, 0], left_ankle: [0.1, 0.08, 0], right_ankle: [-0.1, 0.08, 0], spine3: [0, 1.3, 0],
  left_foot: [0.1, 0.03, 0.12], right_foot: [-0.1, 0.03, 0.12], neck: [0, 1.45, 0], left_collar: [0.07, 1.42, 0],
  right_collar: [-0.07, 1.42, 0], head: [0, 1.6, 0.02], left_shoulder: [0.18, 1.42, 0], right_shoulder: [-0.18, 1.42, 0],
  left_elbow: [0.46, 1.42, 0], right_elbow: [-0.46, 1.42, 0], left_wrist: [0.71, 1.42, 0], right_wrist: [-0.71, 1.42, 0],
  left_hand: [0.79, 1.42, 0], right_hand: [-0.79, 1.42, 0],
};
const rig: RigData = { parents, names, rest_joints: names.map(name => at[name]), canonical_axis_angles: names.map(() => [0, 0, 0]) };
const model = new GaussianRig(rig);
const J = (name: string) => names.indexOf(name);
const posed = (angles: number[][], yaw = 0) => {
  const turn = new Matrix4().makeRotationY(yaw);
  return model.matrices(angles).map((m, i) => new Vector3().fromArray(at[names[i]]).applyMatrix4(m).applyMatrix4(turn));
};
/** MediaPipe landmark indices filled from rig joints (head points approximate the skull). */
function landmarks(joints: Vector3[], hide: number[] = []): BodyPoints {
  const points: [number, number, number][] = Array.from({ length: 33 }, () => [0, 0, 0]);
  const put = (i: number, v: Vector3) => { points[i] = [v.x, v.y, v.z]; };
  const head = joints[J("head")];
  put(0, head); put(7, head.clone().add(new Vector3(0.07, 0, 0))); put(8, head.clone().add(new Vector3(-0.07, 0, 0)));
  // Ears follow the head's own sideways axis: shoulders' left direction.
  const left = joints[J("left_shoulder")].clone().sub(joints[J("right_shoulder")]).normalize();
  put(7, head.clone().addScaledVector(left, 0.07)); put(8, head.clone().addScaledVector(left, -0.07));
  for (const [i, name] of [[11, "left_shoulder"], [12, "right_shoulder"], [13, "left_elbow"], [14, "right_elbow"], [15, "left_wrist"],
    [16, "right_wrist"], [17, "left_hand"], [19, "left_hand"], [18, "right_hand"], [20, "right_hand"], [23, "left_hip"],
    [24, "right_hip"], [25, "left_knee"], [26, "right_knee"], [27, "left_ankle"], [28, "right_ankle"], [31, "left_foot"], [32, "right_foot"]] as const)
    put(i, joints[J(name)]);
  return { points, visibility: points.map((_, i) => hide.includes(i) ? 0.1 : 0.95) };
}
const direction = (joints: Vector3[], a: string, b: string) => joints[J(b)].clone().sub(joints[J(a)]).normalize();

describe("retargetBody", () => {
  const truth = names.map(() => [0, 0, 0]);
  truth[J("left_shoulder")] = [0, 0, 1.2];       // left arm raised above shoulder height
  truth[J("right_shoulder")] = [0, 0, 1.25];     // right arm down
  truth[J("right_elbow")] = [0, 1.3, 0];         // right forearm bent forward
  truth[J("left_hip")] = [-0.5, 0, 0];           // left leg stepping forward
  truth[J("left_knee")] = [0.6, 0, 0];
  truth[J("spine1")] = [0.2, 0, 0];              // slight forward lean
  const yaw = 0.7;
  const observed = posed(truth, yaw);

  it("recovers the facing direction and every observed bone direction", () => {
    const result = retargetBody(rig, landmarks(observed.map(v => v.clone())))!;
    expect(result.yaw).toBeCloseTo(yaw, 5);
    const angles = result.angles.map(a => a ?? [0, 0, 0]);
    const rebuilt = posed(angles, result.yaw);
    for (const [a, b] of [["left_shoulder", "left_elbow"], ["left_elbow", "left_wrist"], ["right_shoulder", "right_elbow"],
      ["right_elbow", "right_wrist"], ["left_hip", "left_knee"], ["left_knee", "left_ankle"], ["right_hip", "right_knee"]])
      expect(direction(rebuilt, a, b).dot(direction(observed, a, b))).toBeGreaterThan(0.999);
    // The torso is measured hips→shoulders, while the rig bends at spine1 above the hips: within a few degrees.
    expect(direction(rebuilt, "spine1", "spine2").dot(direction(observed, "spine1", "spine2"))).toBeGreaterThan(0.995);
  });

  it("marks a hidden arm as unknown instead of guessing it", () => {
    const result = retargetBody(rig, landmarks(observed, [13, 15, 17, 19]))!;
    expect(result.angles[J("left_shoulder")]).toBeNull();
    expect(result.angles[J("left_elbow")]).toBeNull();
    expect(result.angles[J("right_elbow")]).not.toBeNull();
  });

  it("needs both hips to orient the body", () => {
    expect(retargetBody(rig, landmarks(observed, [24]))).toBeUndefined();
  });
});

describe("bodyInRoom and PoseFollower", () => {
  it("rotates camera-axis points into the room", () => {
    // Camera looking along room +z, image down = room −y: x right → room −x (as rig.py/positioning conventions).
    const world = Array.from({ length: 33 }, () => ({ x: 0, y: -1, z: 0, visibility: 0.9 }));
    const body = bodyInRoom(world, [-1, 0, 0, 0, -1, 0, 0, 0, 1])!;
    body.points[0].forEach((value, i) => expect(value).toBeCloseTo([0, 1, 0][i], 9));
  });

  it("converges smoothly to a new pose", () => {
    const follower = new PoseFollower(0.1);
    follower.update([[0, 0, 0]], 0, 0.016);
    const half = follower.update([[0, 0, 1]], 1, 0.0693);
    expect(half.angles[0][2]).toBeCloseTo(0.5, 2);
    expect(half.yaw).toBeCloseTo(0.5, 2);
    let last = half;
    for (let i = 0; i < 60; i++) last = follower.update([[0, 0, 1]], 1, 0.05);
    expect(last.angles[0][2]).toBeCloseTo(1, 4);
  });
});
