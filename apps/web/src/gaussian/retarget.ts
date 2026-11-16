import { Quaternion, Vector3 } from "three";
import type { RigData } from "./rig";

/** MediaPipe pose body in room axes (y up), metres, hip-centred; `visibility` per landmark (0–1). */
export type BodyPoints = { points: [number, number, number][]; visibility: number[]; hipHeight?: number };
/** Per-joint axis-angles (rig convention, T-pose relative); null = not observed, use the fallback pose. */
export type Retargeted = { yaw: number; angles: (number[] | null)[] };

const UP = new Vector3(0, 1, 0);
// Below about 0.65 the pose model is guessing a limb it cannot see, and the avatar bent into shapes nobody was making.
const MIN_VISIBILITY = 0.65, LEG_VISIBILITY = 0.8, TORSO_VISIBILITY = 0.5;

/** Rotates MediaPipe world landmarks (camera axes: x right, y down, z away) into room axes with the camera rotation. */
export function bodyInRoom(world: { x: number; y: number; z?: number; visibility?: number }[], worldFromCamera: number[]): BodyPoints | undefined {
  if (world.length < 33 || worldFromCamera.length !== 9 || !worldFromCamera.every(Number.isFinite)) return;
  const r = worldFromCamera;
  const points = world.map(({ x, y, z = NaN }) => [r[0] * x + r[1] * y + r[2] * z, r[3] * x + r[4] * y + r[5] * z, r[6] * x + r[7] * y + r[8] * z] as [number, number, number]);
  if (!points.every(p => p.every(Number.isFinite))) return;
  return { points, visibility: world.map(p => Number.isFinite(p.visibility) ? p.visibility! : 0) };
}

const rotationBetween = (from: Vector3, to: Vector3) => new Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
const axisAngle = (q: Quaternion) => {
  const w = Math.min(1, Math.max(-1, q.w)), angle = 2 * Math.acos(w), s = Math.sqrt(1 - w * w);
  return s < 1e-8 ? [0, 0, 0] : [q.x / s * angle, q.y / s * angle, q.z / s * angle];
};

/**
 * Joint rotations that make the avatar's bones point like the observed person's. Each driven joint gets the
 * shortest rotation from its rest bone direction to the observed one, expressed in its parent's posed frame.
 * Twist about a bone is not observable from points and stays zero.
 */
export function retargetBody(rig: RigData, body: BodyPoints): Retargeted | undefined {
  const index = (name: string) => rig.names.indexOf(name);
  const seen = (...ids: number[]) => ids.every(i => (body.visibility[i] ?? 0) >= MIN_VISIBILITY);
  // Hips and shoulders set which way the person faces and are rarely far wrong; held to the limbs' stricter limit, someone
  // seated behind a chair back lost the whole pose and their avatar stood up.
  const torso = (...ids: number[]) => ids.every(i => (body.visibility[i] ?? 0) >= TORSO_VISIBILITY);
  const point = (i: number) => new Vector3(...body.points[i]);
  const mid = (a: number, b: number) => point(a).add(point(b)).multiplyScalar(0.5);
  if (!torso(23, 24)) return;
  // Facing: hip and shoulder lines give the person's left (averaged — single-line depth is noisy);
  // forward = left × up (avatar: +x left, +z forward).
  const left = point(23).sub(point(24));
  if (torso(11, 12)) left.add(point(11).sub(point(12)));
  left.addScaledVector(UP, -left.dot(UP));
  if (left.length() < 0.05) return;
  left.normalize();
  const forward = new Vector3().crossVectors(left, UP).normalize();
  const yaw = Math.atan2(forward.x, forward.z);
  const unyaw = new Quaternion().setFromAxisAngle(UP, -yaw);
  // Observed bone direction in the avatar's own frame, or undefined when its landmarks are unreliable.
  const bone = (from: () => Vector3, to: () => Vector3, ids: number[], sure = seen) => sure(...ids) ? to().sub(from()).applyQuaternion(unyaw) : undefined;
  const P = point;
  // Legs under a desk are not seen, yet the pose model still returns points for them, often flung out sideways or upwards,
  // and reports them as fairly visible. Believe a leg only when the model is sure of it. For a person the camera measured
  // as seated (hips well below standing height), unseen legs sit: thighs forward, shins down.
  const sure = (...ids: number[]) => ids.every(i => (body.visibility[i] ?? 0) >= LEG_VISIBILITY);
  const pelvis = rig.rest_joints[0]?.[1] ?? 1, seated = body.hipHeight !== undefined && body.hipHeight < 0.75 * pelvis;
  const leg = (from: number, to: number, sitting: Vector3) => sure(from, to) ? P(to).sub(P(from)).applyQuaternion(unyaw) : seated ? sitting : undefined;
  const thigh = new Vector3(0, -0.12, 1), shin = new Vector3(0, -1, 0.05), foot = new Vector3(0, -0.25, 1);
  const targets: Record<string, [string, Vector3 | undefined]> = {
    spine1: ["spine2", bone(() => mid(23, 24), () => mid(11, 12), [11, 12, 23, 24], torso)],
    neck: ["head", bone(() => mid(11, 12), () => mid(7, 8), [7, 8, 11, 12])],
    left_shoulder: ["left_elbow", bone(() => P(11), () => P(13), [11, 13])],
    right_shoulder: ["right_elbow", bone(() => P(12), () => P(14), [12, 14])],
    left_elbow: ["left_wrist", bone(() => P(13), () => P(15), [13, 15])],
    right_elbow: ["right_wrist", bone(() => P(14), () => P(16), [14, 16])],
    left_wrist: ["left_hand", bone(() => P(15), () => mid(17, 19), [15, 17, 19])],
    right_wrist: ["right_hand", bone(() => P(16), () => mid(18, 20), [16, 18, 20])],
    left_hip: ["left_knee", leg(23, 25, thigh)],
    right_hip: ["right_knee", leg(24, 26, thigh)],
    left_knee: ["left_ankle", leg(25, 27, shin)],
    right_knee: ["right_ankle", leg(26, 28, shin)],
    left_ankle: ["left_foot", leg(27, 31, foot)],
    right_ankle: ["right_foot", leg(28, 32, foot)],
  };
  const world: Quaternion[] = [], known: boolean[] = [], angles: (number[] | null)[] = [];
  for (let i = 0; i < rig.parents.length; i++) {
    const parent = rig.parents[i], parentWorld = parent >= 0 ? world[parent] : new Quaternion();
    const parentKnown = parent < 0 || known[parent];
    const target = targets[rig.names[i]];
    let local = new Quaternion();
    if (target && target[1] && parentKnown && index(target[0]) >= 0) {
      const rest = new Vector3().fromArray(rig.rest_joints[index(target[0])]).sub(new Vector3().fromArray(rig.rest_joints[i]));
      local = rotationBetween(rest, target[1].clone().applyQuaternion(parentWorld.clone().invert()));
      angles.push(axisAngle(local)); known.push(true);
    } else if (target) {
      // Observation missing (or its parent is unknown): this joint and its chain fall back to the base pose.
      angles.push(null); known.push(false);
    } else {
      // Undriven joints (pelvis, spine2/3, collars, head, feet, hands) stay at rest relative to their parent.
      angles.push(parentKnown ? [0, 0, 0] : null); known.push(parentKnown);
    }
    world.push(parentWorld.clone().multiply(local));
  }
  return { yaw, angles };
}

/** Legs of a seated person for an avatar whose body could not be read at all (hips hidden or seen edge-on); the rest stays as animated. */
export function seatedPose(rig: RigData): (number[] | null)[] | undefined {
  const at = (name: string) => rig.rest_joints[rig.names.indexOf(name)];
  const joints: [number, string][] = [[23, "left_hip"], [24, "right_hip"], [11, "left_shoulder"], [12, "right_shoulder"]];
  if (joints.some(([, name]) => !at(name))) return;
  const points: [number, number, number][] = Array.from({ length: 33 }, () => [0, 0, 0]), visibility = Array.from({ length: 33 }, () => 0);
  for (const [i, name] of joints) { points[i] = at(name) as [number, number, number]; visibility[i] = 1; }
  const legs = new Set(["left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle"]);
  return retargetBody(rig, { points, visibility, hipHeight: 0 })?.angles.map((angles, i) => legs.has(rig.names[i]) ? angles : null);
}

/** Smoothly follows target joint rotations and yaw (exponential slerp), so detector jitter does not shake the avatar. */
export class PoseFollower {
  private current: Quaternion[] = [];
  private yaw: number | undefined;
  constructor(private timeConstant = 0.1) {}
  update(target: number[][], targetYaw: number, elapsed: number): { angles: number[][]; yaw: number } {
    const t = this.current.length ? 1 - Math.exp(-Math.max(0, elapsed) / this.timeConstant) : 1;
    const angles = target.map((axis, i) => {
      const vector = new Vector3().fromArray(axis), angle = vector.length();
      const goal = angle > 1e-9 ? new Quaternion().setFromAxisAngle(vector.divideScalar(angle), angle) : new Quaternion();
      this.current[i] = (this.current[i] ?? goal.clone()).slerp(goal, t);
      return axisAngle(this.current[i]);
    });
    if (this.yaw === undefined) this.yaw = targetYaw;
    else this.yaw += Math.atan2(Math.sin(targetYaw - this.yaw), Math.cos(targetYaw - this.yaw)) * t;
    return { angles, yaw: this.yaw };
  }
  reset() { this.current = []; this.yaw = undefined; }
}
