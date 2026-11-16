import type { Navigation, Point } from "../types";
import { insideBoundary, projectImageToFloor } from "./geometry";
import type { CameraCalibration, CameraGeometry, ImageDetection, ImagePoint, PoseLandmark, PositionQuality, WorldFloorPoint } from "./types";

export type PositionDetection = WorldFloorPoint & PositionQuality & { confidence: number };
export type PositionResult = { detection?: PositionDetection; reason?: string };
/** Eye height above the floor, measured while this person's feet were visible. */
export type PersonProfile = { eyeHeight?: number };
type Candidate = { position: Point; uncertainty: number; confidence: number; source: string };
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
function upperBodyEstimate(pose: PoseLandmark[], camera: CameraCalibration, navigation: Navigation, profile?: PersonProfile): PositionResult {
  const geometry = camera.geometry;
  if (!geometry) return { reason: "Feet are hidden. Automatic camera alignment is needed to estimate an upper-body position; floor matches alone cannot measure depth." };
  const candidates: Candidate[] = [];
  let reason = "Show the head, both shoulders or a shoulder and hip clearly to estimate a position when feet are hidden.";
  const torso = torsoEstimate(pose, camera, geometry, navigation);
  if (torso.candidate) candidates.push(torso.candidate); else if (torso.reason) reason = torso.reason;
  const head = headEstimate(pose, camera, geometry, navigation, profile);
  if (head.candidate) candidates.push(head.candidate); else if (head.reason) reason = head.reason;
  for (const pair of [{ a: 11, b: 12, width: 0.40, relative: 0.40, source: "shoulders" }]) {
    const a = pose[pair.a], b = pose[pair.b];
    if (!visible(a, 0.75) || !visible(b, 0.75)) continue;
    // A body turned sideways shrinks the apparent shoulder width and would place the person too far away.
    if (Number.isFinite(a.z) && Number.isFinite(b.z) && Math.abs(a.z! - b.z!) > 0.6 * Math.abs(a.x - b.x)) continue;
    const left = cameraSlope(camera, a), right = cameraSlope(camera, b);
    if (!left || !right) continue;
    const span = Math.hypot(right[0] - left[0], right[1] - left[1]);
    const pixelSpan = Math.hypot((a.x - b.x) * camera.imageWidth, (a.y - b.y) * camera.imageHeight);
    if (span < 0.007 || pixelSpan < 30) { reason = "The person is too small in the image for a useful upper-body distance estimate."; continue; }
    const depth = pair.width / span;
    if (!Number.isFinite(depth) || depth < 0.25 || depth > 8) { reason = "The upper-body depth estimate is outside the supported 0.25–8 m camera range."; continue; }
    const offset = rotate(geometry, { x: (left[0] + right[0]) * 0.5 * depth, y: (left[1] + right[1]) * 0.5 * depth, z: depth });
    if (!offset) continue;
    const position = { x: geometry.center.x + offset.x, y: geometry.center.y + offset.y, z: geometry.center.z + offset.z };
    // Allow sitting/standing, but reject anatomically impossible size/pose estimates.
    const elevation = position.y - navigation.floorY;
    if (elevation < 0.4 || elevation > 2.25) { reason = "The estimated body height is inconsistent with the saved floor. Check camera alignment."; continue; }
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
function torsoEstimate(pose: PoseLandmark[], camera: CameraCalibration, geometry: CameraGeometry, navigation: Navigation): { candidate?: Candidate; reason?: string } {
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

// Adult head dimensions (metres). Widths shrink as the head turns; eye-to-mouth height shrinks as it nods.
const HEAD_WIDTHS = [[2, 5, 0.063], [3, 6, 0.09], [7, 8, 0.145]] as const;
const EYE_TO_MOUTH = 0.068, EYE_TO_CROWN = 0.11, HEAD_HEIGHT = 0.26, HEAD_VISIBILITY = 0.6;
// Without a personal measurement the prior has to cover both standing and sitting adults.
const EYE_HEIGHT = 1.5, EYE_HEIGHT_SIGMA = 0.24, PERSONAL_EYE_HEIGHT_SIGMA = 0.08;
const meanPoint = (pose: PoseLandmark[], indices: number[]): ImagePoint => ({ x: indices.reduce((sum, i) => sum + pose[i].x, 0) / indices.length, y: indices.reduce((sum, i) => sum + pose[i].y, 0) / indices.length });
/** Eye-level point of the head, from whichever facial landmarks are visible. */
function headAnchor(pose: PoseLandmark[]): { point: ImagePoint; used: number[] } | undefined {
  const seen = (i: number) => visible(pose[i], HEAD_VISIBILITY);
  const left = [1, 2, 3].filter(seen), right = [4, 5, 6].filter(seen), ears = [7, 8].filter(seen);
  if ([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter(seen).length < 3) return;
  if (left.length && right.length) { const a = meanPoint(pose, left), b = meanPoint(pose, right); return { point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, used: [...left, ...right] }; }
  const side = left.length ? left : right.length ? right : ears;
  return side.length ? { point: meanPoint(pose, side), used: side } : undefined;
}
/**
 * Depth along one viewing ray from two independent cues: an apparent size (posture-independent) and a
 * horizontal plane at an assumed height. `direction` is the world ray per metre of camera depth.
 */
function rayDepth(center: Point, direction: Point, size: { depth: number; relative: number } | undefined, plane: { y: number; sigma: number } | undefined, onConflict: "size" | "plane"): { depth: number; sigma: number } | undefined {
  let planar: { depth: number; sigma: number } | undefined;
  // A ray close to horizontal slides along the plane: a small height error becomes a huge distance error.
  if (plane && Math.abs(direction.y) / Math.hypot(direction.x, direction.y, direction.z) >= 0.1) {
    const depth = (plane.y - center.y) / direction.y;
    if (depth > 0.25 && depth < 12) planar = { depth, sigma: plane.sigma / Math.abs(direction.y) };
  }
  const sized = size && size.depth > 0.25 && size.depth < 12 ? { depth: size.depth, sigma: size.depth * size.relative } : undefined;
  if (!sized || !planar) return sized ?? planar;
  if (Math.abs(sized.depth - planar.depth) <= 2.5 * Math.hypot(sized.sigma, planar.sigma)) {
    const ws = 1 / sized.sigma ** 2, wp = 1 / planar.sigma ** 2;
    return { depth: (sized.depth * ws + planar.depth * wp) / (ws + wp), sigma: Math.max(Math.sqrt(1 / (ws + wp)), 0.6 * Math.min(sized.sigma, planar.sigma)) };
  }
  // The cues disagree: the person is probably not at the assumed height (sitting, crouching, a child).
  const chosen = onConflict === "size" ? sized : planar;
  return { depth: chosen.depth, sigma: chosen.sigma * 1.3 };
}
function rayCandidate(camera: CameraCalibration, geometry: CameraGeometry, navigation: Navigation, image: ImagePoint, size: { depth: number; relative: number } | undefined, planeHeight: { height: number; sigma: number }, onConflict: "size" | "plane", confidence: number, source: string): { candidate?: Candidate; reason?: string } {
  const slope = cameraSlope(camera, image), direction = slope && rotate(geometry, { x: slope[0], y: slope[1], z: 1 });
  if (!direction) return {};
  const solved = rayDepth(geometry.center, direction, size, { y: navigation.floorY + planeHeight.height, sigma: planeHeight.sigma }, onConflict);
  if (!solved) return { reason: "Only the head is visible and it is too small or too level with the camera to estimate its distance. Move closer or show more of the body." };
  const position = { x: geometry.center.x + direction.x * solved.depth, y: geometry.center.y + direction.y * solved.depth, z: geometry.center.z + direction.z * solved.depth };
  const elevation = position.y - navigation.floorY;
  if (elevation < 0.5 || elevation > 2.3) return { reason: "The estimated head height is inconsistent with the saved floor. Check camera alignment." };
  const uncertainty = Math.max(0.25, solved.sigma * Math.hypot(direction.x, direction.z) + 0.1 + solved.depth * (4 + geometry.reprojectionErrorPx) / Math.min(geometry.intrinsics.fx, geometry.intrinsics.fy));
  if (!Number.isFinite(uncertainty) || uncertainty > 1.5) return { reason: "The head position is too uncertain. Move closer or show more of the body." };
  if (!withinBoundary(position, navigation.boundary, 0.4)) return { reason: "The estimated person is outside the saved walking area. Check camera alignment and the room boundary." };
  return { candidate: { position, uncertainty, confidence, source } };
}
/** A position from facial landmarks alone: apparent head size, cross-checked against the person's eye height. */
function headEstimate(pose: PoseLandmark[], camera: CameraCalibration, geometry: CameraGeometry, navigation: Navigation, profile?: PersonProfile): { candidate?: Candidate; reason?: string } {
  const anchor = headAnchor(pose);
  if (!anchor) return {};
  const seen = (i: number) => visible(pose[i], HEAD_VISIBILITY);
  // Apparent scale (1 / depth) of a facial span, with the pixels it covers as a noise measure.
  const scale = (a: ImagePoint, b: ImagePoint, metres: number): { scale: number; pixels: number } | undefined => {
    const sa = cameraSlope(camera, a), sb = cameraSlope(camera, b), pixels = Math.hypot((a.x - b.x) * camera.imageWidth, (a.y - b.y) * camera.imageHeight);
    return sa && sb && pixels >= 8 ? { scale: Math.hypot(sa[0] - sb[0], sa[1] - sb[1]) / metres, pixels } : undefined;
  };
  const widths = HEAD_WIDTHS.flatMap(([a, b, metres]) => seen(a) && seen(b) ? scale(pose[a], pose[b], metres) ?? [] : []);
  const total = widths.reduce((sum, cue) => sum + cue.pixels, 0);
  let across = widths.length ? { scale: widths.reduce((sum, cue) => sum + cue.scale * cue.pixels, 0) / total, pixels: Math.max(...widths.map(cue => cue.pixels)) } : undefined;
  const eyes = [2, 5].filter(seen), mouth = [9, 10].filter(seen);
  const down = eyes.length && mouth.length ? scale(meanPoint(pose, eyes), meanPoint(pose, mouth), EYE_TO_MOUTH) : undefined;
  // A turned head foreshortens every width; without the vertical cue to correct it the width is unusable.
  if (across && !down && seen(0) && seen(2) && seen(5)) {
    const a = pose[2], b = pose[5], dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
    const fraction = squared > 0 ? ((pose[0].x - a.x) * dx + (pose[0].y - a.y) * dy) / squared : 0;
    if (fraction < 0.2 || fraction > 0.8) across = undefined;
  }
  // Turning shrinks the widths and nodding shrinks the height, so the larger apparent scale is the truer one.
  const best = across && down ? across.scale >= down.scale ? across : down : across ?? down;
  const size = best && best.scale > 0 ? { depth: 1 / best.scale, relative: Math.hypot(across && down ? 0.1 : 0.15, 2.5 / best.pixels) } : undefined;
  const eyeHeight = profile?.eyeHeight;
  const confidence = Math.min(...anchor.used.map(i => Math.min(pose[i].visibility!, pose[i].presence ?? 1)));
  return rayCandidate(camera, geometry, navigation, anchor.point, size, { height: eyeHeight ?? EYE_HEIGHT, sigma: eyeHeight ? PERSONAL_EYE_HEIGHT_SIGMA : EYE_HEIGHT_SIGMA }, "size", confidence, "head");
}
/** Eye height of a person whose feet were just measured on the floor; later used when only their head shows. */
/**
 * How high above the floor a person's hips are, from where the camera sees them over the person's floor position.
 * About 0.95 m standing and 0.5 m on a chair: an avatar posed as seated but left at standing height hangs in the air.
 */
export function measureHipHeight(pose: PoseLandmark[], camera: CameraCalibration, floor: WorldFloorPoint, floorY: number): number | undefined {
  const geometry = camera.geometry;
  if (!geometry) return;
  const heights = [23, 24].flatMap(index => {
    const p = pose[index];
    if (!visible(p, 0.5)) return [];
    const slope = cameraSlope(camera, p), direction = slope && rotate(geometry, { x: slope[0], y: slope[1], z: 1 });
    const horizontal = direction ? direction.x * direction.x + direction.z * direction.z : 0;
    if (!direction || horizontal < 1e-6) return [];
    // Closest approach of the hip ray to the vertical line through the person.
    const depth = ((floor.x - geometry.center.x) * direction.x + (floor.z - geometry.center.z) * direction.z) / horizontal;
    const miss = Math.hypot(geometry.center.x + direction.x * depth - floor.x, geometry.center.z + direction.z * depth - floor.z), height = geometry.center.y + direction.y * depth - floorY;
    return depth > 0.25 && miss <= 0.6 && height >= 0.05 && height <= 1.4 ? [height] : [];
  });
  return heights.length ? heights.reduce((sum, height) => sum + height, 0) / heights.length : undefined;
}
/**
 * How steeply the camera looks down at the top of a boxed person: metres of drop per metre of floor distance.
 * With the person's real distance this gives the height of their head, whatever the box estimate assumed.
 */
export function crownSlope(box: ImageDetection, camera: CameraCalibration): number | undefined {
  const geometry = camera.geometry;
  if (!geometry || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) return;
  const slope = cameraSlope(camera, { x: box.x + box.width / 2, y: box.y + box.height * 0.04 }), direction = slope && rotate(geometry, { x: slope[0], y: slope[1], z: 1 });
  const level = direction ? Math.hypot(direction.x, direction.z) : 0;
  return direction && level > 1e-6 ? -direction.y / level : undefined;
}
export function measureEyeHeight(pose: PoseLandmark[], camera: CameraCalibration, floor: WorldFloorPoint, floorY: number): number | undefined {
  const geometry = camera.geometry, anchor = headAnchor(pose);
  if (!geometry || !anchor) return;
  const slope = cameraSlope(camera, anchor.point), direction = slope && rotate(geometry, { x: slope[0], y: slope[1], z: 1 });
  if (!direction) return;
  const horizontal = direction.x * direction.x + direction.z * direction.z;
  if (horizontal < 1e-6) return;
  // Closest approach of the head ray to the vertical line through the feet.
  const depth = ((floor.x - geometry.center.x) * direction.x + (floor.z - geometry.center.z) * direction.z) / horizontal;
  if (!(depth > 0.25)) return;
  const miss = Math.hypot(geometry.center.x + direction.x * depth - floor.x, geometry.center.z + direction.z * depth - floor.z), height = geometry.center.y + direction.y * depth - floorY;
  // A leaning or bending person has no single standing eye height.
  return miss <= 0.35 && height >= 1.0 && height <= 2.0 ? height : undefined;
}
/**
 * A person the pose model missed but the object detector boxed, typically a head above furniture.
 * The box top is the crown, so it meets the plane at the person's height; a head-shaped box also gives a size.
 */
export function locateBox(box: ImageDetection, camera: CameraCalibration, navigation: Navigation, profile?: PersonProfile): PositionResult {
  const geometry = camera.geometry;
  if (!geometry) return { reason: "Only part of a person is visible. Automatic camera alignment is needed to estimate their position." };
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return {};
  if (box.y <= 0.01) return { reason: "The person's head leaves the top of the camera frame, so their position cannot be estimated." };
  const pixelWidth = box.width * camera.imageWidth, pixelHeight = box.height * camera.imageHeight, aspect = pixelHeight / pixelWidth;
  const crown = { x: box.x + box.width / 2, y: box.y + box.height * 0.04 }, chin = { x: crown.x, y: box.y + box.height };
  // Taller boxes include shoulders or torso of unknown extent; only a head-shaped box has a known size.
  const headShaped = aspect >= 0.9 && aspect <= 1.6 && chin.y < 0.985 && pixelHeight >= 14;
  const top = cameraSlope(camera, crown), bottom = cameraSlope(camera, chin), span = top && bottom ? Math.hypot(top[0] - bottom[0], top[1] - bottom[1]) : 0;
  const size = headShaped && span > 0 ? { depth: HEAD_HEIGHT / span, relative: Math.hypot(0.3, 4 / pixelHeight) } : undefined;
  const eyeHeight = profile?.eyeHeight;
  const found = rayCandidate(camera, geometry, navigation, crown, size, { height: (eyeHeight ?? EYE_HEIGHT) + EYE_TO_CROWN, sigma: eyeHeight ? PERSONAL_EYE_HEIGHT_SIGMA + 0.02 : EYE_HEIGHT_SIGMA + 0.02 }, "plane", box.confidence, "box");
  if (!found.candidate) return { reason: found.reason ?? "Only part of a person is visible and their distance cannot be estimated." };
  const position = withinBoundary(found.candidate.position, navigation.boundary, 0.4);
  if (!position) return { reason: "The estimated person is outside the saved walking area. Check camera alignment and the room boundary." };
  return { detection: { ...position, confidence: Math.min(0.5, box.confidence * 0.6), positionMethod: "estimated", uncertaintyMeters: found.candidate.uncertainty } };
}

/** `profile` carries what this person's earlier floor measurements revealed about their height. */
export function locatePerson(pose: PoseLandmark[], camera: CameraCalibration, navigation: Navigation, profile?: PersonProfile): PositionResult {
  const floor = floorDetection(pose, camera, navigation);
  if (floor.detection) return floor;
  // Feet that project badly (e.g. behind furniture) fall back to the body estimate, which is labelled as estimated.
  const estimate = upperBodyEstimate(pose, camera, navigation, profile);
  return estimate.detection || !feetVisible(pose) ? estimate : floor;
}
