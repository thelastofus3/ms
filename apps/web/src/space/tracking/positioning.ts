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
function floorDetection(pose: PoseLandmark[], camera: CameraCalibration, navigation: Navigation): PositionResult {
  const h = camera.homography;
  if (!camera.geometry && (h.length !== 9 || !h.every(Number.isFinite) || !camera.points.length)) return { reason: "Locate this camera in the room before displaying positions." };
  const denominators = camera.points.map(p => h[6] * p.image.x + h[7] * p.image.y + h[8]);
  const reference = [...denominators].sort((a, b) => Math.abs(a) - Math.abs(b))[Math.floor(denominators.length / 2)];
  let reason = "Feet are hidden or not reliable enough to measure a floor position.";
  const map = (p: ImagePoint): WorldFloorPoint | undefined => {
    let mapped: WorldFloorPoint | undefined;
    if (camera.geometry) {
      const projected = rayFloor(camera, p, navigation.floorY); mapped = projected.point;
      if (!mapped) { reason = projected.reason!; return; }
    } else {
      const denominator = h[6] * p.x + h[7] * p.y + h[8];
      if (!Number.isFinite(reference) || reference === 0 || Math.sign(denominator) !== Math.sign(reference) || Math.abs(denominator) < Math.abs(reference) * 0.05) {
        reason = "The foot lies near or beyond the floor mapping's perspective horizon. Check the camera calibration."; return;
      }
      mapped = projectImageToFloor(h, p);
      if (!mapped) { reason = "The camera floor mapping is unstable at this foot. Spread the calibration references farther apart."; return; }
    }
    if (!insideBoundary(mapped, navigation.boundary)) { reason = "The projected person is outside the saved walking area. Check camera alignment and the room boundary."; return; }
    return mapped;
  };
  const feet: PositionDetection[] = [];
  for (const [heelIndex, toeIndex] of [[29, 31], [30, 32]]) {
    const heel = pose[heelIndex], toe = pose[toeIndex];
    if (!visible(heel) || !visible(toe)) continue;
    const a = map(heel), b = map(toe);
    if (!a || !b) continue;
    if (distance(a, b) > 0.7) { reason = "Heel and toe positions disagree. Check visibility and camera calibration."; continue; }
    feet.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, confidence: Math.min(heel.visibility!, toe.visibility!, heel.presence ?? 1, toe.presence ?? 1) });
  }
  if (!feet.length) return { reason };
  if (feet.length === 2 && distance(feet[0], feet[1]) > 1.5) return { reason: "The two feet project too far apart. Check camera calibration and landmark visibility." };
  const weight = feet.reduce((sum, foot) => sum + foot.confidence, 0);
  const result = feet.reduce((sum, foot) => ({ x: sum.x + foot.x * foot.confidence / weight, z: sum.z + foot.z * foot.confidence / weight }), { x: 0, z: 0 });
  if (!insideBoundary(result, navigation.boundary)) return { reason: "The person's floor position lies outside the walking area." };
  return { detection: { ...result, confidence: Math.min(0.9, Math.min(...feet.map(foot => foot.confidence)) * (feet.length === 1 ? 0.9 : 1)), positionMethod: "floor" } };
}

/** Monocular depth from visible bilateral landmarks and adult size priors. Always an estimate. */
function upperBodyEstimate(pose: PoseLandmark[], camera: CameraCalibration, navigation: Navigation): PositionResult {
  const geometry = camera.geometry;
  if (!geometry) return { reason: "Feet are hidden. Automatic camera alignment is needed to estimate an upper-body position; floor matches alone cannot measure depth." };
  type Candidate = { position: Point; uncertainty: number; confidence: number; source: string };
  const candidates: Candidate[] = [];
  let reason = "Show both shoulders or both eyes clearly to estimate a position when feet are hidden.";
  for (const pair of [{ a: 11, b: 12, width: 0.40, relative: 0.40, source: "shoulders" }, { a: 2, b: 5, width: 0.063, relative: 0.30, source: "eyes" }]) {
    const a = pose[pair.a], b = pose[pair.b];
    if (!visible(a, 0.75) || !visible(b, 0.75)) continue;
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
    if (!insideBoundary(position, navigation.boundary)) { reason = "The estimated person is outside the saved walking area. Check camera alignment and the room boundary."; continue; }
    candidates.push({ position, uncertainty, confidence: Math.min(a.visibility!, b.visibility!, a.presence ?? 1, b.presence ?? 1), source: pair.source });
  }
  if (!candidates.length) return { reason };
  if (candidates.length > 1 && distance(candidates[0].position, candidates[1].position) > Math.max(0.45, Math.min(candidates[0].uncertainty, candidates[1].uncertainty)))
    return { reason: "Shoulder and face distance estimates disagree. Face the camera or show the feet." };
  const weights = candidates.map(candidate => 1 / candidate.uncertainty ** 2), total = weights.reduce((sum, value) => sum + value, 0);
  const position = candidates.reduce((sum, candidate, i) => ({ x: sum.x + candidate.position.x * weights[i] / total, z: sum.z + candidate.position.z * weights[i] / total }), { x: 0, z: 0 });
  if (!insideBoundary(position, navigation.boundary)) return { reason: "The estimated floor position is outside the saved walking area." };
  // Size priors share a systematic error; multiple pairs must not falsely narrow uncertainty.
  const uncertaintyMeters = Math.max(0.25, ...candidates.map(candidate => candidate.uncertainty + distance(candidate.position, position)));
  const confidence = Math.min(0.65, Math.min(...candidates.map(candidate => candidate.confidence)) * 0.7);
  return { detection: { ...position, confidence, positionMethod: "estimated", uncertaintyMeters } };
}

export function locatePerson(pose: PoseLandmark[], camera: CameraCalibration, navigation: Navigation): PositionResult {
  const floor = floorDetection(pose, camera, navigation);
  if (floor.detection) return floor;
  // If foot contact is visible but projects incorrectly, do not hide a bad calibration behind a body-size estimate.
  const feetVisible = [[29, 31], [30, 32]].some(([a, b]) => visible(pose[a]) && visible(pose[b]));
  if (feetVisible) return floor;
  return upperBodyEstimate(pose, camera, navigation);
}
