import type { Navigation, Point } from "../types";
import { insideBoundary, projectImageToFloor } from "./geometry";
import type { CameraCalibration, CameraGeometry, ImagePoint, PoseLandmark, PositionQuality, WorldFloorPoint } from "./types";

export type PositionDetection = WorldFloorPoint & PositionQuality & { confidence: number };
export type PositionResult = { detection?: PositionDetection; reason?: string };
const distance = (a: WorldFloorPoint, b: WorldFloorPoint) => Math.hypot(a.x - b.x, a.z - b.z);
function visible(p: PoseLandmark | undefined, confidence = 0.65): p is PoseLandmark {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > 0.005 && p.x < 0.995 && p.y > 0.005 && p.y < 0.995
    && Number.isFinite(p.visibility) && p.visibility! >= confidence && p.visibility! <= 1
    && (p.presence === undefined || Number.isFinite(p.presence) && p.presence >= confidence && p.presence <= 1);
}

/** Invert SIMPLE_RADIAL/RADIAL distortion. Intrinsics are in the original live image pixels. */
function cameraSlope(camera: CameraCalibration, p: ImagePoint): [number, number] | undefined {
  const geometry = camera.geometry, k = geometry?.intrinsics;
  if (!geometry || !k || ![k.fx, k.fy, k.cx, k.cy, k.k1, k.k2, p.x, p.y].every(Number.isFinite) || k.fx <= 0 || k.fy <= 0) return;
  const xd = (p.x * camera.imageWidth - k.cx) / k.fx, yd = (p.y * camera.imageHeight - k.cy) / k.fy;
  const rd = Math.hypot(xd, yd);
  if (rd === 0) return [0, 0];
  let r = rd;
  for (let i = 0; i < 15; i++) {
    const r2 = r * r, factor = 1 + k.k1 * r2 + k.k2 * r2 * r2;
    const derivative = 1 + 3 * k.k1 * r2 + 5 * k.k2 * r2 * r2;
    if (!Number.isFinite(derivative) || derivative <= 0.1 || factor <= 0.1) return;
    const next = r - (r * factor - rd) / derivative;
    if (!Number.isFinite(next) || next < 0 || next > 5) return;
    if (Math.abs(next - r) < 1e-10) { r = next; break; }
    r = next;
  }
  const factor = 1 + k.k1 * r * r + k.k2 * r ** 4;
  if (Math.abs(r * factor - rd) > 1e-5) return;
  return [xd * r / rd, yd * r / rd];
}
function rotate(geometry: CameraGeometry, p: Point): Point | undefined {
  const r = geometry.worldFromCamera;
  if (r.length !== 9 || !r.every(Number.isFinite) || ![geometry.center.x, geometry.center.y, geometry.center.z].every(Number.isFinite)) return;
  const result = { x: r[0] * p.x + r[1] * p.y + r[2] * p.z, y: r[3] * p.x + r[4] * p.y + r[5] * p.z, z: r[6] * p.x + r[7] * p.y + r[8] * p.z };
  return Object.values(result).every(Number.isFinite) ? result : undefined;
}
function rayFloor(camera: CameraCalibration, p: ImagePoint, floorY: number): { point?: WorldFloorPoint; reason?: string } {
  const slope = cameraSlope(camera, p), geometry = camera.geometry;
  if (!slope || !geometry) return { reason: "Camera geometry is invalid. Automatically locate the camera again." };
  const direction = rotate(geometry, { x: slope[0], y: slope[1], z: 1 });
  if (!direction || Math.abs(direction.y) / Math.hypot(direction.x, direction.y, direction.z) < 0.025) return { reason: "Foot rays are too close to the camera horizon to measure a floor position." };
  const depth = (floorY - geometry.center.y) / direction.y;
  if (!Number.isFinite(depth) || depth <= 0 || depth > 20) return { reason: "Detected feet do not project onto the floor in front of this camera." };
  return { point: { x: geometry.center.x + direction.x * depth, z: geometry.center.z + direction.z * depth } };
}
/** Points slightly outside the walking area (landmark noise near walls/furniture) snap to its edge instead of vanishing. */
export function withinBoundary(p: WorldFloorPoint, boundary: [number, number][], margin: number): WorldFloorPoint | undefined {
  if (insideBoundary(p, boundary)) return p;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || boundary.length < 3) return;
  let best: WorldFloorPoint | undefined, bestDistance = margin;
  for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
    const [ax, az] = boundary[j], [bx, bz] = boundary[i], dx = bx - ax, dz = bz - az, squared = dx * dx + dz * dz;
    const t = squared > 0 ? Math.min(1, Math.max(0, ((p.x - ax) * dx + (p.z - az) * dz) / squared)) : 0;
    const closest = { x: ax + t * dx, z: az + t * dz }, gap = distance(p, closest);
    if (gap <= bestDistance) { best = closest; bestDistance = gap; }
  }
  return best;
}
const FOOT_VISIBILITY = 0.5, ANKLE_HEIGHT = 0.08;
// Per side: ankle, heel, foot index (toe). Heel/toe touch the floor; the ankle sits ~8 cm above it.
const FEET = [[27, 29, 31], [28, 30, 32]] as const;
const feetVisible = (pose: PoseLandmark[]) => FEET.some(side => side.some(index => visible(pose[index], FOOT_VISIBILITY)));
function floorDetection(pose: PoseLandmark[], camera: CameraCalibration, navigation: Navigation): PositionResult {
  const h = camera.homography;
  if (!camera.geometry && (h.length !== 9 || !h.every(Number.isFinite) || !camera.points.length)) return { reason: "Locate this camera in the room before displaying positions." };
  const denominators = camera.points.map(p => h[6] * p.image.x + h[7] * p.image.y + h[8]);
  const reference = [...denominators].sort((a, b) => Math.abs(a) - Math.abs(b))[Math.floor(denominators.length / 2)];
  let reason = "Feet are hidden or not reliable enough to measure a floor position.";
  const map = (p: ImagePoint, height: number): WorldFloorPoint | undefined => {
    let mapped: WorldFloorPoint | undefined;
    if (camera.geometry) {
      const projected = rayFloor(camera, p, navigation.floorY + height); mapped = projected.point;
      if (!mapped) { reason = projected.reason!; return; }
    } else {
      // A floor homography cannot place the raised ankle.
      if (height) return;
      const denominator = h[6] * p.x + h[7] * p.y + h[8];
      if (!Number.isFinite(reference) || reference === 0 || Math.sign(denominator) !== Math.sign(reference) || Math.abs(denominator) < Math.abs(reference) * 0.05) {
        reason = "The foot lies near or beyond the floor mapping's perspective horizon. Check the camera calibration."; return;
      }
      mapped = projectImageToFloor(h, p);
      if (!mapped) { reason = "The camera floor mapping is unstable at this foot. Spread the calibration references farther apart."; return; }
    }
    const inside = withinBoundary(mapped, navigation.boundary, 0.25);
    if (!inside) { reason = "The projected person is outside the saved walking area. Check camera alignment and the room boundary."; return; }
    return inside;
  };
  const feet: PositionDetection[] = [];
  for (const [ankleIndex, heelIndex, toeIndex] of FEET) {
    // Either floor contact is enough; a side view or an occluding object often hides one of them.
    const contacts = [pose[heelIndex], pose[toeIndex]].filter(p => visible(p, FOOT_VISIBILITY));
    const ankle = pose[ankleIndex];
    const points = contacts.length ? contacts.map(p => ({ p, height: 0 })) : visible(ankle, FOOT_VISIBILITY) ? [{ p: ankle, height: ANKLE_HEIGHT }] : [];
    if (!points.length) continue;
    const mapped = points.map(({ p, height }) => map(p, height));
    if (mapped.some(point => !point)) continue;
    const located = mapped as WorldFloorPoint[];
    if (located.length === 2 && distance(located[0], located[1]) > 0.7) { reason = "Heel and toe positions disagree. Check visibility and camera calibration."; continue; }
    const confidence = Math.min(...points.map(({ p }) => Math.min(p.visibility!, p.presence ?? 1))) * (contacts.length ? 1 : 0.8);
    feet.push({ x: located.reduce((sum, p) => sum + p.x, 0) / located.length, z: located.reduce((sum, p) => sum + p.z, 0) / located.length, confidence });
  }
  if (!feet.length) return { reason };
  if (feet.length === 2 && distance(feet[0], feet[1]) > 1.5) return { reason: "The two feet project too far apart. Check camera calibration and landmark visibility." };
  const weight = feet.reduce((sum, foot) => sum + foot.confidence, 0);
  const result = withinBoundary(feet.reduce((sum, foot) => ({ x: sum.x + foot.x * foot.confidence / weight, z: sum.z + foot.z * foot.confidence / weight }), { x: 0, z: 0 }), navigation.boundary, 0.25);
  if (!result) return { reason: "The person's floor position lies outside the walking area." };
  return { detection: { ...result, confidence: Math.min(0.9, Math.min(...feet.map(foot => foot.confidence)) * (feet.length === 1 ? 0.9 : 1)), positionMethod: "floor" } };
}

/** Monocular depth from visible bilateral landmarks and adult size priors. Always an estimate. */
function upperBodyEstimate(pose: PoseLandmark[], camera: CameraCalibration, navigation: Navigation): PositionResult {
  const geometry = camera.geometry;
  if (!geometry) return { reason: "Feet are hidden. Automatic camera alignment is needed to estimate an upper-body position; floor matches alone cannot measure depth." };
  type Candidate = { position: Point; uncertainty: number; confidence: number; source: string };
  const candidates: Candidate[] = [];
  let reason = "Show the shoulders and hips, both shoulders or both eyes clearly to estimate a position when feet are hidden.";
  const torso = torsoEstimate(pose, camera, geometry, navigation);
  if (torso.candidate) candidates.push(torso.candidate); else if (torso.reason) reason = torso.reason;
  for (const pair of [{ a: 11, b: 12, width: 0.40, relative: 0.40, source: "shoulders" }, { a: 2, b: 5, width: 0.063, relative: 0.30, source: "eyes" }]) {
    const a = pose[pair.a], b = pose[pair.b];
    if (!visible(a, 0.75) || !visible(b, 0.75)) continue;
    // A body turned sideways shrinks the apparent shoulder width and would place the person too far away.
    if (pair.source === "shoulders" && Number.isFinite(a.z) && Number.isFinite(b.z) && Math.abs(a.z! - b.z!) > 0.6 * Math.abs(a.x - b.x)) continue;
    // Facial yaw shrinks apparent eye spacing; don't use a strongly turned face as a frontal size measurement.
    if (pair.source === "eyes") {
      const nose = pose[0];
      if (!visible(nose, 0.75)) continue;
      const dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
      const fraction = squared > 0 ? ((nose.x - a.x) * dx + (nose.y - a.y) * dy) / squared : 0;
      if (fraction < 0.2 || fraction > 0.8) { reason = "The face is turned too far to estimate depth from eye spacing."; continue; }
    }
    const left = cameraSlope(camera, a), right = cameraSlope(camera, b);
    if (!left || !right) continue;
    const span = Math.hypot(right[0] - left[0], right[1] - left[1]);
    const pixelSpan = Math.hypot((a.x - b.x) * camera.imageWidth, (a.y - b.y) * camera.imageHeight);
    if (span < 0.007 || pixelSpan < (pair.source === "eyes" ? 12 : 30)) { reason = "The person is too small in the image for a useful upper-body distance estimate."; continue; }
    const depth = pair.width / span;
    if (!Number.isFinite(depth) || depth < 0.25 || depth > 8) { reason = "The upper-body depth estimate is outside the supported 0.25–8 m camera range."; continue; }
    const offset = rotate(geometry, { x: (left[0] + right[0]) * 0.5 * depth, y: (left[1] + right[1]) * 0.5 * depth, z: depth });
    if (!offset) continue;
    const position = { x: geometry.center.x + offset.x, y: geometry.center.y + offset.y, z: geometry.center.z + offset.z };
    // Allow sitting/standing, but reject anatomically impossible size/pose estimates.
    const elevation = position.y - navigation.floorY;
    if (elevation < (pair.source === "eyes" ? 0.55 : 0.4) || elevation > 2.25) { reason = "The estimated body height is inconsistent with the saved floor. Check camera alignment."; continue; }
    const horizontalRange = Math.hypot(offset.x, offset.z);
    const uncertainty = Math.max(0.25, horizontalRange * pair.relative + 0.2 + depth * (4 + geometry.reprojectionErrorPx) / Math.min(geometry.intrinsics.fx, geometry.intrinsics.fy));
    if (!Number.isFinite(uncertainty) || uncertainty > 1.5) { reason = "The upper-body position is too uncertain. Move closer or show the feet for a floor measurement."; continue; }
    if (!withinBoundary(position, navigation.boundary, 0.4)) { reason = "The estimated person is outside the saved walking area. Check camera alignment and the room boundary."; continue; }
    candidates.push({ position, uncertainty, confidence: Math.min(a.visibility!, b.visibility!, a.presence ?? 1, b.presence ?? 1), source: pair.source });
  }
  if (!candidates.length) return { reason };
  // Keep the estimates consistent with the most certain one; one outlier must not discard the rest.
  const anchor = candidates.reduce((best, candidate) => candidate.uncertainty < best.uncertainty ? candidate : best);
  const agreeing = candidates.filter(candidate => distance(candidate.position, anchor.position) <= Math.max(0.45, Math.min(candidate.uncertainty, anchor.uncertainty)));
  const weights = agreeing.map(candidate => 1 / candidate.uncertainty ** 2), total = weights.reduce((sum, value) => sum + value, 0);
  const position = withinBoundary(agreeing.reduce((sum, candidate, i) => ({ x: sum.x + candidate.position.x * weights[i] / total, z: sum.z + candidate.position.z * weights[i] / total }), { x: 0, z: 0 }), navigation.boundary, 0.4);
  if (!position) return { reason: "The estimated floor position is outside the saved walking area." };
  // Size priors share a systematic error; multiple pairs must not falsely narrow uncertainty.
  const uncertaintyMeters = Math.max(0.25, ...agreeing.map(candidate => candidate.uncertainty + distance(candidate.position, position)));
  const confidence = Math.min(0.65, Math.min(...agreeing.map(candidate => candidate.confidence)) * 0.7);
  return { detection: { ...position, confidence, positionMethod: "estimated", uncertaintyMeters } };
}

const TORSO_HEIGHT = 0.5;
/**
 * Shoulder-to-hip height is unchanged when a person turns, unlike shoulder width or eye spacing,
 * so this works for side and back views. Solves t_s·r_s − t_h·r_h = (0, L, 0) for an upright torso.
 */
function torsoEstimate(pose: PoseLandmark[], camera: CameraCalibration, geometry: CameraGeometry, navigation: Navigation): { candidate?: { position: Point; uncertainty: number; confidence: number; source: string }; reason?: string } {
  const sides = [[11, 23], [12, 24]].filter(([s, h]) => visible(pose[s], 0.6) && visible(pose[h], 0.6));
  if (!sides.length) return {};
  const mean = (index: 0 | 1) => ({ x: sides.reduce((sum, side) => sum + pose[side[index]].x, 0) / sides.length, y: sides.reduce((sum, side) => sum + pose[side[index]].y, 0) / sides.length });
  const shoulderSlope = cameraSlope(camera, mean(0)), hipSlope = cameraSlope(camera, mean(1));
  if (!shoulderSlope || !hipSlope) return {};
  const pixelSpan = Math.hypot((mean(0).x - mean(1).x) * camera.imageWidth, (mean(0).y - mean(1).y) * camera.imageHeight);
  if (pixelSpan < 25) return { reason: "The person is too small in the image for a useful torso distance estimate." };
  const rs = rotate(geometry, { x: shoulderSlope[0], y: shoulderSlope[1], z: 1 }), rh = rotate(geometry, { x: hipSlope[0], y: hipSlope[1], z: 1 });
  if (!rs || !rh) return {};
  // Least squares for [rs, −rh]·[ts, th]ᵀ = (0, L, 0).
  const a11 = rs.x * rs.x + rs.y * rs.y + rs.z * rs.z, a12 = -(rs.x * rh.x + rs.y * rh.y + rs.z * rh.z), a22 = rh.x * rh.x + rh.y * rh.y + rh.z * rh.z;
  const b1 = rs.y * TORSO_HEIGHT, b2 = -rh.y * TORSO_HEIGHT, determinant = a11 * a22 - a12 * a12;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) return {};
  const ts = (b1 * a22 - a12 * b2) / determinant, th = (a11 * b2 - a12 * b1) / determinant;
  if (!(ts > 0.25 && th > 0.25 && ts < 10 && th < 10)) return { reason: "The torso distance estimate is outside the supported camera range." };
  const residual = Math.hypot(ts * rs.x - th * rh.x, ts * rs.y - th * rh.y - TORSO_HEIGHT, ts * rs.z - th * rh.z);
  if (residual > 0.35 * TORSO_HEIGHT) return { reason: "The torso is leaning too far to estimate its distance. Show the feet for a floor measurement." };
  const hip = { x: geometry.center.x + th * rh.x, y: geometry.center.y + th * rh.y, z: geometry.center.z + th * rh.z };
  const elevation = hip.y - navigation.floorY;
  if (elevation < 0.25 || elevation > 1.3) return { reason: "The estimated hip height is inconsistent with the saved floor. Check camera alignment." };
  const range = Math.hypot(hip.x - geometry.center.x, hip.z - geometry.center.z);
  const uncertainty = Math.max(0.25, range * 0.22 + 0.15 + residual + th * (4 + geometry.reprojectionErrorPx) / Math.min(geometry.intrinsics.fx, geometry.intrinsics.fy));
  if (!Number.isFinite(uncertainty) || uncertainty > 1.5) return { reason: "The torso position is too uncertain. Move closer or show the feet for a floor measurement." };
  if (!withinBoundary(hip, navigation.boundary, 0.4)) return { reason: "The estimated person is outside the saved walking area. Check camera alignment and the room boundary." };
  const confidence = Math.min(...sides.flat().map(index => Math.min(pose[index].visibility!, pose[index].presence ?? 1)));
  return { candidate: { position: hip, uncertainty, confidence, source: "torso" } };
}

export function locatePerson(pose: PoseLandmark[], camera: CameraCalibration, navigation: Navigation): PositionResult {
  const floor = floorDetection(pose, camera, navigation);
  if (floor.detection) return floor;
  // Feet that project badly (e.g. behind furniture) fall back to the body estimate, which is labelled as estimated.
  const estimate = upperBodyEstimate(pose, camera, navigation);
  return estimate.detection || !feetVisible(pose) ? estimate : floor;
}
