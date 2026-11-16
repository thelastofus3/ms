import type { Navigation } from "../types";
import { insideBoundary } from "./geometry";
import { crownSlope, locateBox, locatePerson, measureEyeHeight, type PositionDetection } from "./positioning";
import type { CameraCalibration, ImageDetection, PoseLandmark, TrackedPerson, WorldFloorPoint } from "./types";

type Detection = PositionDetection & { poseIndex?: number; box?: ImageDetection };
/** One Euro filter: strong smoothing while standing still, little lag while walking. */
class OneEuro {
  private value: number | undefined;
  private derivative = 0;
  constructor(private minCutoff: number, private beta: number) {}
  filter(value: number, dt: number): number {
    if (this.value === undefined) return this.value = value;
    const smoothing = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    this.derivative += smoothing(1) * ((value - this.value) / dt - this.derivative);
    this.value += smoothing(this.minCutoff + this.beta * Math.abs(this.derivative)) * (value - this.value);
    return this.value;
  }
  reset(value: number) { this.value = value; this.derivative = 0; }
}
type Track = Detection & { id: string; seen: number; vx: number; vz: number; hits: number; fx: OneEuro; fz: OneEuro;
  /** Started from a weak box only: followed, but not shown until it has been seen three times. */
  tentative?: boolean;
  /** How well the position is known, metres: about 0.1 right after feet were seen on the floor, the estimate's own error otherwise. */
  sigma: number; lastFloor?: number; strays?: number;
  /** How much farther than a body-size estimate this person really is, learned when their feet were last seen. */
  depthRatio?: number; crownHeight?: number; crownSlope?: number;
  /** Learned while the feet were visible; makes later head-only positions of this person far more precise. */
  eyeHeight?: number };
const dist = (a: WorldFloorPoint, b: WorldFloorPoint) => Math.hypot(a.x - b.x, a.z - b.z);
/**
 * A confirmed person stays visible at the last position through short detection gaps (turning, brief occlusion).
 * A loaded machine analyses two frames a second, not eight: at 1.2 s one missed frame ended the track, and the live room
 * showed people blinking with a new id every few seconds (ids 1 to 39 within half a minute, 2026-11-15).
 */
export const HOLD_MS = 2500;
const filters = (estimated: boolean) => estimated ? [new OneEuro(0.4, 0.4), new OneEuro(0.4, 0.4)] : [new OneEuro(0.8, 0.7), new OneEuro(0.8, 0.7)];
export class PersonTracker {
  diagnostics: string[] = [];
  private tracks: Track[] = [];
  private context = "";
  private lastTimestamp = -Infinity;
  private nextId = 0;
  reset(): void { this.tracks = []; this.context = ""; this.lastTimestamp = -Infinity; this.nextId = 0; this.diagnostics = []; }
  /** `boxes` are the object detector's person boxes; one without a usable pose is located from its head. */
  update(landmarks: PoseLandmark[][], camera: CameraCalibration, navigation: Navigation, timestamp: number, boxes: ImageDetection[] = []): TrackedPerson[] {
    this.diagnostics = [];
    if (!Number.isFinite(timestamp) || !Number.isFinite(navigation.floorY)) return [];
    const context = `${camera.id}:${camera.revision}:${camera.sceneVersion}:${navigation.floorY}`;
    if (context !== this.context) { this.reset(); this.context = context; }
    if (timestamp <= this.lastTimestamp) return [];
    this.lastTimestamp = timestamp;
    this.tracks = this.tracks.filter(track => timestamp - track.seen <= HOLD_MS).slice(-10);
    const detections: Detection[] = [];
    // One camera cannot tell two people apart by distance alone: a body-size estimate in the same direction as someone
    // already placed is that person again with another guess at their distance. Alone in the room, a person got a second
    // avatar on the line between them and the camera in one frame out of eight (2026-11-15).
    const eye = camera.geometry?.center;
    const inLine = (a: WorldFloorPoint, b: WorldFloorPoint) => {
      if (!eye) return false;
      const ax = a.x - eye.x, az = a.z - eye.z, bx = b.x - eye.x, bz = b.z - eye.z, la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      return la > 0.05 && lb > 0.05 && ax * bx + az * bz > 0 && Math.abs(ax * bz - az * bx) / (la * lb) < 0.1 && la / lb > 0.25 && la / lb < 4;
    };
    const guess = (detection: Detection) => detection.positionMethod === "estimated";
    for (const [poseIndex, pose] of landmarks.slice(0, 5).entries()) {
      const result = locatePerson(pose, camera, navigation), found: Detection | undefined = result.detection && { ...result.detection, poseIndex };
      if (!found) { if (result.reason) this.diagnostics.push(result.reason); continue; }
      const same = detections.findIndex(other => dist(other, found) < 0.18 || (guess(other) || guess(found)) && inLine(other, found));
      if (same < 0) detections.push(found);
      else {
        // Feet on the floor beat a guess; between two guesses the surer one stays.
        if (guess(detections[same]) && (!guess(found) || (found.uncertaintyMeters ?? 1) < (detections[same].uncertaintyMeters ?? 1))) detections[same] = found;
        this.diagnostics.push("Overlapping person positions were merged to avoid duplicate markers.");
      }
    }
    // The pose model needs a visible torso. A head above furniture is still boxed by the object detector.
    const located = new Set(detections.map(detection => detection.poseIndex));
    const centres = landmarks.slice(0, 5).flatMap((pose, index) => {
      const seen = pose.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y) && (p.visibility ?? 0) >= 0.5);
      return located.has(index) && seen.length ? [{ x: seen.reduce((sum, p) => sum + p.x, 0) / seen.length, y: seen.reduce((sum, p) => sum + p.y, 0) / seen.length }] : [];
    });
    for (const box of boxes.filter(box => box.source === "object" && box.confidence >= 0.4).slice(0, 5)) {
      const padX = box.width * 0.1, padY = box.height * 0.1;
      if (centres.some(p => p.x >= box.x - padX && p.x <= box.x + box.width + padX && p.y >= box.y - padY && p.y <= box.y + box.height + padY)) continue;
      const result = locateBox(box, camera, navigation);
      if (!result.detection) { if (result.reason) this.diagnostics.push(result.reason); continue; }
      const found: Detection = { ...result.detection, box };
      // A box estimate is coarse: anything it could be confused with is the better-measured person.
      if (!detections.some(other => dist(other, found) < Math.max(0.5, found.uncertaintyMeters ?? 0) || inLine(other, found))) detections.push(found);
    }
    const predictions = this.tracks.map(track => {
      const dt = Math.min(0.4, Math.max(0, (timestamp - track.seen) / 1000));
      return { x: track.x + track.vx * dt, z: track.z + track.vz * dt };
    });
    const gates = this.tracks.map(track => Math.min(1.5, Math.max(0.45, (timestamp - track.seen) / 1000 * 3 + 0.15)));
    // A guess in line with a track is matched by how far it passes from that track, not by where along the line it fell.
    const aside = (detection: WorldFloorPoint, track: WorldFloorPoint) => {
      const dx = detection.x - eye!.x, dz = detection.z - eye!.z;
      return Math.abs((track.x - eye!.x) * dz - (track.z - eye!.z) * dx) / Math.hypot(dx, dz);
    };
    // The same holds the other way round: feet seen in line with a track that has only ever been a guess are that person,
    // found properly at last. A seated person first appeared a metre short as a guess, then again at the desk by their feet.
    const distances = detections.map(detection => predictions.map((prediction, j) => (guess(detection) || this.tracks[j].lastFloor === undefined) && inLine(detection, prediction) ? aside(detection, prediction) : dist(detection, prediction)));
    // A body-size estimate is uncertain by half a metre or more, mostly along the camera ray, and two estimates of one person
    // differ by that much; with the 0.45 m gate alone they started a new track each time.
    const reach = (i: number, j: number) => Math.max(gates[j], Math.min(1.5, 1.5 * Math.max(detections[i].uncertaintyMeters ?? 0, this.tracks[j].uncertaintyMeters ?? 0)));
    let bestCost = Infinity, best: number[] = [];
    const assign = (index: number, used: Set<number>, assignment: number[], cost: number) => {
      if (cost >= bestCost) return;
      if (index === detections.length) { bestCost = cost; best = [...assignment]; return; }
      for (let j = 0; j < this.tracks.length; j++) if (!used.has(j) && distances[index][j] <= reach(index, j)) {
        used.add(j); assignment.push(j); assign(index + 1, used, assignment, cost + distances[index][j] / reach(index, j)); assignment.pop(); used.delete(j);
      }
      assignment.push(-1); assign(index + 1, used, assignment, cost + 1.1); assignment.pop();
    };
    assign(0, new Set(), [], 0);
    const visible: TrackedPerson[] = [];
    detections.forEach((measured, i) => {
      let detection = measured;
      const chosen = best[i] ?? -1, pose = detection.poseIndex !== undefined ? landmarks[detection.poseIndex] : undefined;
      if (chosen >= 0) {
        const closestAlternatives = distances[i].filter((_, j) => j !== chosen && distances[i][j] <= reach(i, j));
        const alternativeDetections = distances.map((row, j) => ({ value: row[chosen], j })).filter(({ value, j }) => j !== i && value <= reach(j, chosen)).map(({ value }) => value);
        const chosenDistance = distances[i][chosen];
        // Suppress ambiguous crossings rather than attaching a confident wrong ID.
        if (closestAlternatives.some(value => Math.abs(value - chosenDistance) < 0.12) || alternativeDetections.some(value => Math.abs(value - chosenDistance) < 0.12)) {
          this.diagnostics.push("People overlap or cross in the camera view. Waiting for an unambiguous track."); return;
        }
        const track = this.tracks[chosen], dt = Math.max(0.01, (timestamp - track.seen) / 1000);
        if (detection.positionMethod === "floor" && pose) {
          const eyeHeight = measureEyeHeight(pose, camera, detection, navigation.floorY);
          if (eyeHeight) track.eyeHeight = track.eyeHeight === undefined ? eyeHeight : track.eyeHeight + 0.2 * (eyeHeight - track.eyeHeight);
        } else if (track.eyeHeight !== undefined) {
          // Feet are hidden now, but this person's height is known: measure again with it instead of the adult average.
          const profile = { eyeHeight: track.eyeHeight }, refined = (pose ? locatePerson(pose, camera, navigation, profile) : detection.box ? locateBox(detection.box, camera, navigation, profile) : undefined)?.detection;
          if (refined?.positionMethod === "estimated" && dist(refined, predictions[chosen]) <= Math.max(gates[chosen], 1)) detection = { ...detection, ...refined };
        }
        // Each measurement moves the track in proportion to how much better it is than what is already known. Feet on the
        // floor are good to a decimetre, a body-size estimate to half a metre. The estimate used to replace the position
        // outright and restart the smoothing, so a seated person jumped and turned amber whenever a foot went out of sight.
        // Feet the pose model is unsure of are not an anchor: someone lying on a bed, only their head in view, got "feet" at
        // 0.36 confidence for one frame, jumped 0.9 m and was then held there by the distance learned from that frame.
        const feet = detection.positionMethod === "floor", floor = feet && detection.confidence >= 0.5, centre = camera.geometry?.center;
        // Heel and toe points wander by a few pixels, and a few pixels are 20 cm on the floor three metres from the camera.
        const footing = 0.08 + 0.04 * (centre ? Math.hypot(detection.x - centre.x, detection.z - centre.z) : 1);
        if (floor) track.depthRatio = undefined;
        else if (centre) {
          // An estimate gives the direction to the person well and the distance badly: it assumes a standing adult, and
          // someone seated at a desk was drawn a metre nearer the camera as soon as their feet went under it (2026-11-15).
          // While the feet were visible the true distance was known; keep the factor between the two for this person.
          const ex = detection.x - centre.x, ez = detection.z - centre.z, range = Math.hypot(ex, ez), tx = track.x - centre.x, tz = track.z - centre.z;
          if (range > 0.05) {
            const along = (tx * ex + tz * ez) / range, aside = Math.abs(tx * ez - tz * ex) / range, ratio = along / range;
            if (track.depthRatio === undefined && track.lastFloor !== undefined && timestamp - track.lastFloor <= 4000 && aside <= 0.4 && ratio >= 0.4 && ratio <= 3.5) track.depthRatio = ratio;
            if (track.depthRatio !== undefined) detection = { ...detection, x: centre.x + ex * track.depthRatio, z: centre.z + ez * track.depthRatio };
          }
        }
        const measured = floor ? footing : feet ? Math.max(0.5, footing) : Math.max(0.25, detection.uncertaintyMeters ?? 0.5);
        const known = Math.min(1.5, track.sigma + (Math.hypot(track.vx, track.vz) < 0.25 ? 0.15 : 0.5) * dt);
        // Far outside what both errors allow, three frames running: the person really is somewhere else.
        track.strays = dist(detection, track) > 2.5 * Math.hypot(known, measured) ? (track.strays ?? 0) + 1 : 0;
        const moved = track.strays >= 3, gain = moved ? 1 : known ** 2 / (known ** 2 + measured ** 2);
        // Estimates share their errors from frame to frame, so repeating them never makes the position better than one of them.
        track.sigma = moved ? measured : Math.min(known, Math.max(Math.sqrt(1 / (1 / known ** 2 + 1 / measured ** 2)), floor ? 0 : 0.7 * measured));
        if (moved) { track.strays = 0; track.fx.reset(detection.x); track.fz.reset(detection.z); }
        if (floor) track.lastFloor = timestamp;
        const targetX = track.x + gain * (detection.x - track.x), targetZ = track.z + gain * (detection.z - track.z);
        let nextX = moved ? targetX : track.fx.filter(targetX, dt), nextZ = moved ? targetZ : track.fz.filter(targetZ, dt);
        // A blend between valid positions can cross the cutout of a concave room.
        if (!insideBoundary({ x: nextX, z: nextZ }, navigation.boundary)) { nextX = detection.x; nextZ = detection.z; track.fx.reset(nextX); track.fz.reset(nextZ); }
        let vx = (nextX - track.x) / dt, vz = (nextZ - track.z) / dt;
        const speed = Math.hypot(vx, vz);
        if (speed > 3) { vx *= 3 / speed; vz *= 3 / speed; }
        track.vx = track.vx * 0.5 + vx * 0.5; track.vz = track.vz * 0.5 + vz * 0.5;
        track.x = nextX; track.z = nextZ; track.seen = timestamp; track.confidence = detection.confidence; track.hits++;
        // Green means the position still rests on feet seen a moment ago, not that this very frame showed them.
        const anchored = track.lastFloor !== undefined && timestamp - track.lastFloor <= 4000 && track.sigma <= 0.33;
        track.positionMethod = anchored ? "floor" : "estimated"; track.uncertaintyMeters = anchored ? undefined : Math.max(0.25, track.sigma);
        if (track.tentative && track.hits < 3 && !(detection.box && detection.box.confidence < 0.55)) track.tentative = false;
        if (track.tentative && track.hits >= 3) track.tentative = false;
        // Farther away than a standing person would be on that line of sight means lower down: seated, or lying.
        const top = camera.geometry ? camera.geometry.center.y - navigation.floorY : undefined;
        track.crownSlope = detection.box ? crownSlope(detection.box, camera) : undefined;
        track.crownHeight = track.crownSlope !== undefined && track.depthRatio !== undefined && top !== undefined && centre ? top - Math.hypot(track.x - centre.x, track.z - centre.z) * track.crownSlope : undefined;
        if (!track.tentative) visible.push({ id: track.id, position: { x: track.x, y: navigation.floorY, z: track.z }, confidence: track.confidence, positionMethod: track.positionMethod, uncertaintyMeters: track.uncertaintyMeters, poseIndex: detection.poseIndex, imageBox: detection.box, crownHeight: track.crownHeight, crownSlope: track.crownSlope });
      } else {
        // Unmatched observations near an existing track may be a split/occlusion.
        if (predictions.some(prediction => dist(prediction, detection) < 0.3 || guess(detection) && inLine(detection, prediction))) { this.diagnostics.push("A nearby observation may be the same person. Waiting for a distinct track."); return; }
        // One weak box must not invent a person, but someone seated or showing only a head is never more than a weak box:
        // follow it unseen and show it once it has come back twice.
        const tentative = !!detection.box && detection.box.confidence < 0.55;
        const [fx, fz] = filters(detection.positionMethod === "estimated");
        fx.reset(detection.x); fz.reset(detection.z);
        const track: Track = { ...detection, id: String(++this.nextId), seen: timestamp, vx: 0, vz: 0, hits: 1, fx, fz, tentative,
          sigma: detection.positionMethod === "floor" && detection.confidence >= 0.5 ? 0.12 : Math.max(0.25, detection.uncertaintyMeters ?? 0.5), lastFloor: detection.positionMethod === "floor" && detection.confidence >= 0.5 ? timestamp : undefined };
        this.tracks.push(track);
        if (!tentative) visible.push({ id: track.id, position: { x: track.x, y: navigation.floorY, z: track.z }, confidence: track.confidence, positionMethod: track.positionMethod, uncertaintyMeters: track.uncertaintyMeters, poseIndex: detection.poseIndex, imageBox: detection.box });
      }
    });
    // Held tracks keep their last smoothed position (no extrapolation) with reduced confidence.
    for (const track of this.tracks) if (track.seen < timestamp && track.hits >= 2 && !track.tentative && !visible.some(person => person.id === track.id))
      visible.push({ id: track.id, position: { x: track.x, y: navigation.floorY, z: track.z }, confidence: track.confidence * 0.6, positionMethod: track.positionMethod, uncertaintyMeters: track.uncertaintyMeters, crownHeight: track.crownHeight, crownSlope: track.crownSlope });
    return visible;
  }
}
