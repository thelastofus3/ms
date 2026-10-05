import * as THREE from "three";
import type { Calibration, Point, RoomManifest } from "./types";

export const freshCalibration = (): Calibration => ({ measurement: [], meters: 0, floor: [], boundary: [], spawn: null, flipUp: false, reviewed: false, obstacles: [], dimensions: [] });
export const vector = (p: Point) => new THREE.Vector3(p.x, p.y, p.z);
export const point = (p: THREE.Vector3): Point => ({ x: p.x, y: p.y, z: p.z });
export const distance = (a: Point, b: Point) => vector(a).distanceTo(vector(b));
export function metersPerUnit(c: Calibration): number | undefined {
  if (c.measurement.length !== 2 || !Number.isFinite(c.meters) || c.meters < 0.05 || c.meters > 100) return;
  const length = distance(c.measurement[0], c.measurement[1]);
  const scale = c.meters / length;
  return length > 1e-6 && scale >= 1e-6 && scale <= 1e6 ? scale : undefined;
}
export function floorFrame(c: Calibration, m: RoomManifest) {
  if (c.floor.length !== 3) return;
  const origin = vector(c.floor[0]);
  const forward = vector(c.floor[1]).sub(origin);
  const up = forward.clone().cross(vector(c.floor[2]).sub(origin));
  if (forward.length() < 1e-6 || up.length() < 1e-6) return;
  forward.normalize(); up.normalize();
  const camera = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(m.previewCamera));
  if (up.dot(camera.sub(origin)) < 0) up.negate();
  if (c.flipUp) up.negate();
  const back = forward.clone().negate(), right = up.clone().cross(back).normalize();
  return { origin, forward, up, right, back };
}
export function previewTransform(c: Calibration, m: RoomManifest): THREE.Matrix4 {
  const frame = floorFrame(c, m);
  if (frame) {
    const scale = metersPerUnit(c) ?? (m.ready ? new THREE.Vector3().setFromMatrixScale(new THREE.Matrix4().fromArray(m.worldFromReconstruction)).x : 1);
    const { right, up, back, origin } = frame;
    return new THREE.Matrix4().set(
      right.x * scale, right.y * scale, right.z * scale, -origin.dot(right) * scale,
      up.x * scale, up.y * scale, up.z * scale, -origin.dot(up) * scale,
      back.x * scale, back.y * scale, back.z * scale, -origin.dot(back) * scale,
      0, 0, 0, 1);
  }
  if (m.ready) return new THREE.Matrix4().fromArray(m.worldFromReconstruction);
  // Uncalibrated COLMAP axes are arbitrary. Use the captured camera's up direction
  // until a floor plane supplies a better estimate; keep both assets in one frame.
  const up = new THREE.Vector3().setFromMatrixColumn(new THREE.Matrix4().fromArray(m.previewCamera), 1).normalize();
  if (c.flipUp) up.negate();
  return new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(0, 1, 0)));
}
export function calibrationFromManifest(m: RoomManifest): Calibration {
  if (m.calibration) return { ...structuredClone(m.calibration), dimensions: structuredClone(m.calibration.dimensions ?? []) };
  if (m.ready && m.navigation) {
    const inverse = new THREE.Matrix4().fromArray(m.worldFromReconstruction).invert();
    const raw = (x: number, y: number, z: number) => point(new THREE.Vector3(x, y, z).applyMatrix4(inverse));
    const n = m.navigation;
    return { measurement: [raw(0, 0, 0), raw(1, 0, 0)], meters: 1,
      floor: [raw(0, 0, 0), raw(0, 0, -1), raw(1, 0, 0)],
      boundary: n.boundary.map(([x, z]) => raw(x, n.floorY, z)), spawn: raw(...n.spawn), flipUp: false, reviewed: true,
      obstacles: n.obstacles.map(b => ({ a: raw(b.center[0] - b.size[0] / 2, b.center[1] - b.size[1] / 2, b.center[2] - b.size[2] / 2), b: raw(b.center[0] + b.size[0] / 2, b.center[1] + b.size[1] / 2, b.center[2] + b.size[2] / 2) })), dimensions: [] };
  }
  const c = freshCalibration(), p = m.floorProposal;
  if (p?.floorPoints?.length === 3) {
    c.floor = structuredClone(p.floorPoints);
    c.boundary = structuredClone(p.boundary ?? []);
    c.spawn = p.spawn ? { ...p.spawn } : null;
  }
  return c;
}
export function projectToFloor(p: Point, c: Calibration, m: RoomManifest): Point {
  const frame = floorFrame(c, m);
  if (!frame) return p;
  const v = vector(p);
  return point(v.addScaledVector(frame.up, -v.clone().sub(frame.origin).dot(frame.up)));
}
const finitePoint = (p: Point) => [p.x, p.y, p.z].every(Number.isFinite);
function editableFloor(c: Calibration, m: RoomManifest) {
  const frame = floorFrame(c, m);
  if (!frame || c.floor.some(p => !finitePoint(p)) || !finitePoint(point(frame.up)) || !finitePoint(point(frame.right))) {
    throw new Error("Choose three separate floor points before adjusting the floor.");
  }
  return frame;
}
function changedFloor(c: Calibration, m: RoomManifest, floor: Point[], expectedUp: THREE.Vector3): Calibration {
  if (floor.some(p => !finitePoint(p))) throw new Error("The floor adjustment is too large.");
  const changed = { ...c, floor, reviewed: false };
  const frame = floorFrame(changed, m);
  // floorFrame signs the normal against the captured camera, then applies flipUp.
  // Keep that choice stable when translating or slightly rotating the anchors.
  if (!frame || frame.up.dot(expectedUp) < 1 - 1e-6) {
    throw new Error("This would turn the floor upside down. Use a smaller adjustment or change the up direction first.");
  }
  return { ...changed, boundary: c.boundary.map(p => projectToFloor(p, changed, m)),
    spawn: c.spawn ? projectToFloor(c.spawn, changed, m) : null };
}
export function adjustFloor(c: Calibration, m: RoomManifest, adjustment: { height?: number; pitchDegrees?: number; rollDegrees?: number }): Calibration {
  const { height = 0, pitchDegrees = 0, rollDegrees = 0 } = adjustment;
  if (![height, pitchDegrees, rollDegrees].every(Number.isFinite)) throw new Error("Enter a finite floor height and tilt.");
  if (Math.abs(height) > 5 || Math.hypot(pitchDegrees, rollDegrees) > 15) {
    throw new Error("Adjust the floor by at most 5 metres or 15 degrees at a time.");
  }
  const frame = editableFloor(c, m), scale = metersPerUnit(c);
  if (height !== 0 && !scale) throw new Error("Set a known distance before adjusting floor height in metres.");
  const pitch = new THREE.Quaternion().setFromAxisAngle(frame.right, THREE.MathUtils.degToRad(pitchDegrees));
  const pitchedForward = frame.forward.clone().applyQuaternion(pitch);
  const roll = new THREE.Quaternion().setFromAxisAngle(pitchedForward, THREE.MathUtils.degToRad(rollDegrees));
  const rotation = roll.multiply(pitch);
  const expectedUp = frame.up.clone().applyQuaternion(rotation).normalize();
  // A rigid rotation preserves all three anchor distances. Height is along the
  // current floor normal; measurement endpoints and named dimensions stay put.
  const translation = frame.up.clone().multiplyScalar(height === 0 ? 0 : height / scale!);
  const floor = c.floor.map(p => point(vector(p).sub(frame.origin).applyQuaternion(rotation).add(frame.origin).add(translation)));
  return changedFloor(c, m, floor, expectedUp);
}
export function setFloorHeightAt(c: Calibration, m: RoomManifest, selected: Point): Calibration {
  if (!finitePoint(selected)) throw new Error("Choose a finite point on the floor.");
  const frame = editableFloor(c, m), scale = metersPerUnit(c);
  const offset = vector(selected).sub(frame.origin).dot(frame.up);
  const longestEdge = Math.max(distance(c.floor[0], c.floor[1]), distance(c.floor[1], c.floor[2]), distance(c.floor[2], c.floor[0]));
  const limit = scale ? 5 / scale : longestEdge * 5;
  if (!Number.isFinite(offset) || !Number.isFinite(limit) || Math.abs(offset) > limit) {
    throw new Error(scale ? "Choose a floor point within 5 metres of the current level." : "Choose a closer floor point or set a known distance first.");
  }
  const translation = frame.up.clone().multiplyScalar(offset);
  return changedFloor(c, m, c.floor.map(p => point(vector(p).add(translation))), frame.up);
}
export function calibrationIssues(c: Calibration, m: RoomManifest) {
  const frame = floorFrame(c, m), scale = metersPerUnit(c);
  const issues: Partial<Record<"floor" | "measurement" | "boundary" | "spawn" | "review", string>> = {};
  if (!frame) issues.floor = "Choose three separate floor points that form a triangle.";
  if (!scale) issues.measurement = "Pick A and B, then enter their real distance (5 cm to 100 m).";
  const transform = previewTransform(c, m);
  const boundary = c.boundary.map(p => vector(p).applyMatrix4(transform));
  const cross = (a: THREE.Vector3, b: THREE.Vector3, p: THREE.Vector3) => (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
  if (boundary.length < 3) issues.boundary = "Add at least three corners around the walking area.";
  else if (frame && scale) {
    if (boundary.some(p => Math.abs(p.y) > 0.15)) issues.boundary = "Keep every walking-area corner on the floor.";
    const area = boundary.reduce((a, p, i) => a + p.x * boundary[(i + 1) % boundary.length].z - boundary[(i + 1) % boundary.length].x * p.z, 0);
    if (Math.abs(area) < 0.5) issues.boundary = "The walking area needs at least 0.25 m².";
    for (let i = 0; i < boundary.length; i++) for (let j = i + 1; j < boundary.length; j++) {
      if (j === i + 1 || i === 0 && j === boundary.length - 1) continue;
      const a = boundary[i], b = boundary[(i + 1) % boundary.length], d = boundary[j], e = boundary[(j + 1) % boundary.length];
      if (cross(a, b, d) * cross(a, b, e) <= 0 && cross(d, e, a) * cross(d, e, b) <= 0 && Math.max(Math.min(a.x, b.x), Math.min(d.x, e.x)) <= Math.min(Math.max(a.x, b.x), Math.max(d.x, e.x)) && Math.max(Math.min(a.z, b.z), Math.min(d.z, e.z)) <= Math.min(Math.max(a.z, b.z), Math.max(d.z, e.z))) issues.boundary = "Corners cross each other. Undo a corner or draw them around the edge in order.";
    }
  }
  if (!c.spawn) issues.spawn = "Choose an open floor location inside the walking area.";
  else if (frame && scale && boundary.length >= 3) {
    const p = vector(c.spawn).applyMatrix4(transform);
    let inside = false;
    for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
      const a = boundary[i], b = boundary[j];
      if ((a.z > p.z) !== (b.z > p.z) && p.x < (b.x - a.x) * (p.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
    }
    if (!inside || Math.abs(p.y) > 0.15) issues.spawn = "Move the start marker inside the highlighted walking area.";
  }
  if (!c.reviewed) issues.review = "Check the floor, walking area and collisions before saving.";
  if (c.dimensions?.some(d => !d.name.trim() || d.name.length > 80 || scale && distance(d.a, d.b) * scale < 0.001)) issues.review = "Give each dimension a name and two separate endpoints before saving.";
  return issues;
}
export const draftKey = (m: RoomManifest) => `room-calibration-v2:${m.sceneId}:${m.version}`;
export function readDraft(m: RoomManifest): Calibration | undefined {
  try {
    const c = JSON.parse(localStorage.getItem(draftKey(m)) || "null") as Calibration | null;
    const valid = (p: unknown): p is Point => !!p && typeof p === "object" && ["x", "y", "z"].every(k => typeof (p as Record<string, unknown>)[k] === "number" && Number.isFinite((p as Record<string, number>)[k]));
    if (c && [c.measurement, c.floor, c.boundary].every(a => Array.isArray(a) && a.length <= 128 && a.every(valid)) && (!c.spawn || valid(c.spawn)) && typeof c.meters === "number" && Number.isFinite(c.meters) && typeof c.flipUp === "boolean" && typeof c.reviewed === "boolean" && Array.isArray(c.obstacles) && c.obstacles.length <= 100 && c.obstacles.every(b => valid(b.a) && valid(b.b)) && (!c.dimensions || Array.isArray(c.dimensions) && c.dimensions.length <= 100 && c.dimensions.every(d => typeof d.id === "string" && typeof d.name === "string" && valid(d.a) && valid(d.b)))) return c;
  } catch { /* A missing or corrupt local draft does not block opening the scene. */ }
}
