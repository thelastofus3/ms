import type { Navigation } from "../types";
import { insideBoundary } from "./geometry";
import { locatePerson, type PositionDetection } from "./positioning";
import type { CameraCalibration, PoseLandmark, TrackedPerson, WorldFloorPoint } from "./types";

type Detection = PositionDetection & { poseIndex?: number };
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
type Track = Detection & { id: string; seen: number; vx: number; vz: number; hits: number; fx: OneEuro; fz: OneEuro };
const dist = (a: WorldFloorPoint, b: WorldFloorPoint) => Math.hypot(a.x - b.x, a.z - b.z);
/** A confirmed person stays visible at the last position through short detection gaps (turning, brief occlusion). */
export const HOLD_MS = 1200;
const filters = (estimated: boolean) => estimated ? [new OneEuro(0.4, 0.4), new OneEuro(0.4, 0.4)] : [new OneEuro(0.8, 0.7), new OneEuro(0.8, 0.7)];
export class PersonTracker {
  diagnostics: string[] = [];
  private tracks: Track[] = [];
  private context = "";
  private lastTimestamp = -Infinity;
  private nextId = 0;
  reset(): void { this.tracks = []; this.context = ""; this.lastTimestamp = -Infinity; this.nextId = 0; this.diagnostics = []; }
  update(landmarks: PoseLandmark[][], camera: CameraCalibration, navigation: Navigation, timestamp: number): TrackedPerson[] {
    this.diagnostics = [];
    if (!Number.isFinite(timestamp) || !Number.isFinite(navigation.floorY)) return [];
    const context = `${camera.id}:${camera.revision}:${camera.sceneVersion}:${navigation.floorY}`;
    if (context !== this.context) { this.reset(); this.context = context; }
    if (timestamp <= this.lastTimestamp) return [];
    this.lastTimestamp = timestamp;
    this.tracks = this.tracks.filter(track => timestamp - track.seen <= HOLD_MS).slice(-10);
    const detections: Detection[] = [];
    for (const [poseIndex, pose] of landmarks.slice(0, 5).entries()) {
      const result = locatePerson(pose, camera, navigation), found: Detection | undefined = result.detection && { ...result.detection, poseIndex };
      if (!found) { if (result.reason) this.diagnostics.push(result.reason); continue; }
      if (!detections.some(other => dist(other, found) < 0.18)) detections.push(found);
      else this.diagnostics.push("Overlapping person positions were merged to avoid duplicate markers.");
    }
    const predictions = this.tracks.map(track => {
      const dt = Math.min(0.4, Math.max(0, (timestamp - track.seen) / 1000));
      return { x: track.x + track.vx * dt, z: track.z + track.vz * dt };
    });
    const gates = this.tracks.map(track => Math.min(1.5, Math.max(0.45, (timestamp - track.seen) / 1000 * 3 + 0.15)));
    const distances = detections.map(detection => predictions.map(prediction => dist(detection, prediction)));
    let bestCost = Infinity, best: number[] = [];
    const assign = (index: number, used: Set<number>, assignment: number[], cost: number) => {
      if (cost >= bestCost) return;
      if (index === detections.length) { bestCost = cost; best = [...assignment]; return; }
      for (let j = 0; j < this.tracks.length; j++) if (!used.has(j) && distances[index][j] <= gates[j]) {
        used.add(j); assignment.push(j); assign(index + 1, used, assignment, cost + distances[index][j] / gates[j]); assignment.pop(); used.delete(j);
      }
      assignment.push(-1); assign(index + 1, used, assignment, cost + 1.1); assignment.pop();
    };
    assign(0, new Set(), [], 0);
    const visible: TrackedPerson[] = [];
    detections.forEach((detection, i) => {
      const chosen = best[i] ?? -1;
      if (chosen >= 0) {
        const closestAlternatives = distances[i].filter((_, j) => j !== chosen && distances[i][j] <= gates[j]);
        const alternativeDetections = distances.filter((_, j) => j !== i).map(row => row[chosen]).filter(value => value <= gates[chosen]);
        const chosenDistance = distances[i][chosen];
        // Suppress ambiguous crossings rather than attaching a confident wrong ID.
        if (closestAlternatives.some(value => Math.abs(value - chosenDistance) < 0.12) || alternativeDetections.some(value => Math.abs(value - chosenDistance) < 0.12)) {
          this.diagnostics.push("People overlap or cross in the camera view. Waiting for an unambiguous track."); return;
        }
        const track = this.tracks[chosen], dt = Math.max(0.01, (timestamp - track.seen) / 1000);
        // Switching between floor and body-size estimates restarts smoothing at the new measurement type.
        if (track.positionMethod !== detection.positionMethod) [track.fx, track.fz] = filters(detection.positionMethod === "estimated");
        let nextX = track.fx.filter(detection.x, dt), nextZ = track.fz.filter(detection.z, dt);
        // A blend between valid positions can cross the cutout of a concave room.
        if (!insideBoundary({ x: nextX, z: nextZ }, navigation.boundary)) { nextX = detection.x; nextZ = detection.z; track.fx.reset(nextX); track.fz.reset(nextZ); }
        let vx = (nextX - track.x) / dt, vz = (nextZ - track.z) / dt;
        const speed = Math.hypot(vx, vz);
        if (speed > 3) { vx *= 3 / speed; vz *= 3 / speed; }
        track.vx = track.vx * 0.5 + vx * 0.5; track.vz = track.vz * 0.5 + vz * 0.5;
        track.x = nextX; track.z = nextZ; track.seen = timestamp; track.confidence = detection.confidence; track.hits++;
        track.positionMethod = detection.positionMethod; track.uncertaintyMeters = detection.uncertaintyMeters;
        visible.push({ id: track.id, position: { x: track.x, y: navigation.floorY, z: track.z }, confidence: track.confidence, positionMethod: track.positionMethod, uncertaintyMeters: track.uncertaintyMeters, poseIndex: detection.poseIndex });
      } else {
        // Unmatched observations near an existing track may be a split/occlusion.
        if (predictions.some(prediction => dist(prediction, detection) < 0.3)) { this.diagnostics.push("A nearby observation may be the same person. Waiting for a distinct track."); return; }
        const [fx, fz] = filters(detection.positionMethod === "estimated");
        fx.reset(detection.x); fz.reset(detection.z);
        const track: Track = { ...detection, id: String(++this.nextId), seen: timestamp, vx: 0, vz: 0, hits: 1, fx, fz };
        this.tracks.push(track);
        visible.push({ id: track.id, position: { x: track.x, y: navigation.floorY, z: track.z }, confidence: track.confidence, positionMethod: track.positionMethod, uncertaintyMeters: track.uncertaintyMeters, poseIndex: detection.poseIndex });
      }
    });
    // Held tracks keep their last smoothed position (no extrapolation) with reduced confidence.
    for (const track of this.tracks) if (track.seen < timestamp && track.hits >= 3 && !visible.some(person => person.id === track.id))
      visible.push({ id: track.id, position: { x: track.x, y: navigation.floorY, z: track.z }, confidence: track.confidence * 0.6, positionMethod: track.positionMethod, uncertaintyMeters: track.uncertaintyMeters });
    return visible;
  }
}
