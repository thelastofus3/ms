import type { Navigation } from "../types";
import { insideBoundary } from "./geometry";
import { locatePerson, type PositionDetection } from "./positioning";
import type { CameraCalibration, PoseLandmark, TrackedPerson, WorldFloorPoint } from "./types";

type Detection = PositionDetection;
type Track = Detection & { id: string; seen: number; vx: number; vz: number };
const dist = (a: WorldFloorPoint, b: WorldFloorPoint) => Math.hypot(a.x - b.x, a.z - b.z);
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
    this.tracks = this.tracks.filter(track => timestamp - track.seen <= 750).slice(-10);
    const detections: Detection[] = [];
    for (const pose of landmarks.slice(0, 5)) {
      const result = locatePerson(pose, camera, navigation), found = result.detection;
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
        const alpha = 1 - Math.exp(-dt / 0.12);
        let nextX = track.x + alpha * (detection.x - track.x), nextZ = track.z + alpha * (detection.z - track.z);
        // A blend between valid positions can cross the cutout of a concave room.
        if (!insideBoundary({ x: nextX, z: nextZ }, navigation.boundary)) { nextX = detection.x; nextZ = detection.z; }
        let vx = (nextX - track.x) / dt, vz = (nextZ - track.z) / dt;
        const speed = Math.hypot(vx, vz);
        if (speed > 3) { vx *= 3 / speed; vz *= 3 / speed; }
        track.vx = track.vx * 0.5 + vx * 0.5; track.vz = track.vz * 0.5 + vz * 0.5;
        track.x = nextX; track.z = nextZ; track.seen = timestamp; track.confidence = detection.confidence;
        track.positionMethod = detection.positionMethod; track.uncertaintyMeters = detection.uncertaintyMeters;
        visible.push({ id: track.id, position: { x: track.x, y: navigation.floorY, z: track.z }, confidence: track.confidence, positionMethod: track.positionMethod, uncertaintyMeters: track.uncertaintyMeters });
      } else {
        // Unmatched observations near an existing track may be a split/occlusion.
        if (predictions.some(prediction => dist(prediction, detection) < 0.3)) { this.diagnostics.push("A nearby observation may be the same person. Waiting for a distinct track."); return; }
        const track: Track = { ...detection, id: String(++this.nextId), seen: timestamp, vx: 0, vz: 0 };
        this.tracks.push(track);
        visible.push({ id: track.id, position: { x: track.x, y: navigation.floorY, z: track.z }, confidence: track.confidence, positionMethod: track.positionMethod, uncertaintyMeters: track.uncertaintyMeters });
      }
    });
    return visible;
  }
}
