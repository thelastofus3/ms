import { Matrix4, Quaternion, Vector3 } from "three";

export interface RigData {
  parents: number[];
  names: string[];
  rest_joints: number[][];
  canonical_axis_angles: number[][];
}
export interface GaussianManifest {
  schema_version: 1;
  representation: "gaussian-rig";
  name: string;
  source: string;
  num_splats: number;
  model: "avatar.splat";
  indices: "indices.bin";
  weights: "weights.bin";
  rig: RigData;
  sha256: Record<string, string>;
}

function vector(value: unknown): value is number[] {
  return (
    Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
  );
}
export function validateManifest(value: unknown): GaussianManifest {
  const m = value as GaussianManifest;
  if (
    !m ||
    m.schema_version !== 1 ||
    m.representation !== "gaussian-rig" ||
    !Number.isInteger(m.num_splats) ||
    m.num_splats < 1 ||
    m.num_splats > 2_000_000 ||
    m.model !== "avatar.splat" ||
    m.indices !== "indices.bin" ||
    m.weights !== "weights.bin" ||
    !m.sha256 ||
    [m.model, m.indices, m.weights].some(
      (file) => !/^[a-f0-9]{64}$/.test(m.sha256[file]),
    )
  ) {
    throw Error("Некорректный пакет Gaussian-аватара");
  }
  new GaussianRig(m.rig);
  return m;
}

export class GaussianRig {
  private inverseCanonical: Matrix4[];
  constructor(readonly data: RigData) {
    const n = data?.parents?.length;
    if (
      !n ||
      n > 256 ||
      data.names?.length !== n ||
      data.rest_joints?.length !== n ||
      data.canonical_axis_angles?.length !== n ||
      data.parents.some(
        (p, i) =>
          !Number.isInteger(p) || (i === 0 ? p !== -1 : p < 0 || p >= i),
      ) ||
      !data.rest_joints.every(vector) ||
      !data.canonical_axis_angles.every(vector)
    ) {
      throw Error("Некорректная иерархия костей");
    }
    this.inverseCanonical = this.world(data.canonical_axis_angles).map((m) =>
      m.invert(),
    );
  }
  private world(angles: number[][]): Matrix4[] {
    if (angles.length !== this.data.parents.length || !angles.every(vector))
      throw Error("Некорректная поза");
    const matrices: Matrix4[] = [];
    for (let i = 0; i < angles.length; i++) {
      const parent = this.data.parents[i];
      const position = new Vector3().fromArray(this.data.rest_joints[i]);
      if (parent >= 0)
        position.sub(new Vector3().fromArray(this.data.rest_joints[parent]));
      const axis = new Vector3().fromArray(angles[i]),
        angle = axis.length();
      const rotation =
        angle > 0
          ? new Quaternion().setFromAxisAngle(axis.divideScalar(angle), angle)
          : new Quaternion();
      const local = new Matrix4().compose(
        position,
        rotation,
        new Vector3(1, 1, 1),
      );
      matrices.push(
        parent >= 0 ? matrices[parent].clone().multiply(local) : local,
      );
    }
    return matrices;
  }
  matrices(angles: number[][]): Matrix4[] {
    return this.world(angles).map((world, index) =>
      world.multiply(this.inverseCanonical[index]),
    );
  }
}

export type Motion = "idle" | "wave" | "walk" | "canonical";
export function demoPose(
  rig: RigData,
  motion: Motion,
  seconds: number,
  arms: number,
): number[][] {
  if (motion === "canonical")
    return rig.canonical_axis_angles.map((v) => [...v]);
  const pose = rig.parents.map(() => [0, 0, 0]);
  const set = (name: string, x: number, y: number, z: number) => {
    const index = rig.names.indexOf(name);
    if (index >= 0) pose[index] = [x, y, z];
  };
  const lower = 1.25 * (1 - arms);
  set("left_shoulder", 0, 0, -lower);
  set("right_shoulder", 0, 0, lower);
  set("spine3", 0.015 * Math.sin(seconds * 1.4), 0, 0);
  set("head", 0, 0.06 * Math.sin(seconds * 0.7), 0);
  if (motion === "wave") {
    set("left_shoulder", 0, 0, 0.35);
    set("left_elbow", 0.15, 0, 1.45 + 0.25 * Math.sin(seconds * 3));
    set("left_wrist", 0, 0, 0.25 * Math.sin(seconds * 5));
  } else if (motion === "walk") {
    const swing = Math.sin(seconds * 4);
    set("left_hip", 0.35 * swing, 0, 0);
    set("right_hip", -0.35 * swing, 0, 0);
    set("left_knee", Math.max(0, -swing) * 0.55, 0, 0);
    set("right_knee", Math.max(0, swing) * 0.55, 0, 0);
    set("left_shoulder", -0.22 * swing, 0, -lower);
    set("right_shoulder", 0.22 * swing, 0, lower);
  }
  return pose;
}
