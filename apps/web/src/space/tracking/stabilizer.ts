import type { ImageDetection, PoseLandmark } from "./types";

/** A person the detector found before stays shown through this long a gap: single missed frames must not blink. */
export const IMAGE_HOLD_MS = 1500;
export type SteadyDetection = ImageDetection & { id: number; held: boolean };
type Seen = ImageDetection & { id: number; seen: number; hits: number; best: number };
const overlap = (a: ImageDetection, b: ImageDetection) => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const shared = w > 0 && h > 0 ? w * h : 0;
  return shared / (a.width * a.height + b.width * b.height - shared);
};
const centreInside = (a: ImageDetection, b: ImageDetection) => { const x = a.x + a.width / 2, y = a.y + a.height / 2; return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height; };
/** Two boxes around one person: a pose extent and an object box rarely agree on size, but one holds the other's centre. */
export const samePerson = (a: ImageDetection, b: ImageDetection) => overlap(a, b) >= 0.2 || centreInside(a, b) || centreInside(b, a);
/** The image extent of a detected pose, from the points the model is reasonably sure of. */
export const poseExtent = (pose: PoseLandmark[]): ImageDetection | undefined => {
  const seen = pose.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 && (p.visibility ?? 1) >= 0.5);
  if (seen.length < 4) return;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const x = clamp(Math.min(...seen.map(p => p.x)) - 0.01), y = clamp(Math.min(...seen.map(p => p.y)) - 0.015);
  const right = clamp(Math.max(...seen.map(p => p.x)) + 0.01), bottom = clamp(Math.max(...seen.map(p => p.y)) + 0.015);
  if (right - x < 0.02 || bottom - y < 0.03) return;
  return { x, y, width: right - x, height: bottom - y, confidence: seen.reduce((sum, p) => sum + (p.visibility ?? 1), 0) / seen.length, source: "pose" };
};
/**
 * Steadies per-frame detections for the camera preview and the people count. A distant or half-hidden person is found in
 * some frames and missed in others; shown raw, the box and the count flicker. Works in image coordinates, so it needs no
 * camera calibration. Room positions are steadied separately by `PersonTracker`.
 */
export class DetectionStabilizer {
  private people: Seen[] = [];
  private next = 0;
  reset(): void { this.people = []; this.next = 0; }
  update(boxes: ImageDetection[], timestamp: number): SteadyDetection[] {
    if (!Number.isFinite(timestamp)) return [];
    // A single weak sighting is forgotten quickly; anyone seen twice is held, and longer once well established.
    const hold = (person: Seen) => person.hits < 2 ? person.best >= 0.6 ? IMAGE_HOLD_MS : 700 : person.hits >= 6 ? IMAGE_HOLD_MS + 1000 : IMAGE_HOLD_MS;
    // Shown at once when the detector is sure, after two sightings when it is fairly sure, after three when it never is:
    // a jacket on a door scores 0.4 now and then, a real head at that size keeps coming back.
    const shown = (person: Seen) => person.best >= 0.6 || person.hits >= 2 && person.best >= 0.5 || person.hits >= 3;
    this.people = this.people.filter(person => timestamp >= person.seen && timestamp - person.seen <= hold(person));
    const found: ImageDetection[] = [];
    for (const box of [...boxes].sort((a, b) => b.confidence - a.confidence))
      if ([box.x, box.y, box.width, box.height, box.confidence].every(Number.isFinite) && box.width > 0 && box.height > 0 && !found.some(other => samePerson(box, other))) found.push(box);
    const pairs = found.flatMap((box, i) => this.people.map((person, j) => ({ i, j, score: samePerson(box, person) ? 1 + overlap(box, person) : 0 }))).filter(pair => pair.score > 0).sort((a, b) => b.score - a.score);
    const usedBoxes = new Set<number>(), usedPeople = new Set<number>();
    for (const { i, j } of pairs) {
      if (usedBoxes.has(i) || usedPeople.has(j)) continue;
      usedBoxes.add(i); usedPeople.add(j);
      const person = this.people[j], box = found[i], blend = (previous: number, current: number) => previous + 0.5 * (current - previous);
      // Half-way to each new box: steady while standing, two frames behind at most while walking.
      const x = blend(person.x, box.x), y = blend(person.y, box.y), right = blend(person.x + person.width, box.x + box.width), bottom = blend(person.y + person.height, box.y + box.height);
      Object.assign(person, { x, y, width: right - x, height: bottom - y, confidence: box.confidence, source: box.source, seen: timestamp, hits: person.hits + 1, best: Math.max(person.best, box.confidence) });
    }
    found.forEach((box, i) => { if (!usedBoxes.has(i)) this.people.push({ ...box, id: ++this.next, seen: timestamp, hits: 1, best: box.confidence }); });
    return this.people.filter(shown).map(({ seen, hits: _hits, best: _best, ...box }) => ({ ...box, held: seen < timestamp }));
  }
}
