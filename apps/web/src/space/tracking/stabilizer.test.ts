import { describe, expect, it } from "vitest";
import { DetectionStabilizer, IMAGE_HOLD_MS, poseExtent } from "./stabilizer";
import type { ImageDetection } from "./types";

const box = (x: number, y: number, confidence = 0.5): ImageDetection => ({ x, y, width: 0.08, height: 0.2, confidence, source: "object" });

describe("detection stabilizer", () => {
  it("keeps one person through missed frames instead of blinking", () => {
    const steady = new DetectionStabilizer(), counts: number[] = [];
    // Found, found, missed, found, missed, missed, found: the raw count would read 1 1 0 1 0 0 1.
    [true, true, false, true, false, false, true].forEach((found, frame) => counts.push(steady.update(found ? [box(0.3 + frame * 0.002, 0.4)] : [], frame * 300).length));
    expect(counts).toEqual([0, 1, 1, 1, 1, 1, 1]);
  });
  it("needs three sightings of something the detector is never sure about", () => {
    const steady = new DetectionStabilizer();
    expect([0, 300, 600].map(time => steady.update([box(0.3, 0.4, 0.42)], time).length)).toEqual([0, 0, 1]);
  });
  it("keeps the same id and marks held frames", () => {
    const steady = new DetectionStabilizer();
    steady.update([box(0.3, 0.4)], 0);
    const seen = steady.update([box(0.3, 0.4)], 300), held = steady.update([], 600);
    expect(seen[0].held).toBe(false);
    expect(held[0]).toMatchObject({ id: seen[0].id, held: true });
  });
  it("drops a person who stays away", () => {
    const steady = new DetectionStabilizer();
    steady.update([box(0.3, 0.4)], 0); steady.update([box(0.3, 0.4)], 300);
    expect(steady.update([], 300 + IMAGE_HOLD_MS)).toHaveLength(1);
    expect(steady.update([], 301 + IMAGE_HOLD_MS)).toHaveLength(0);
  });
  it("does not show a single weak sighting, shows a strong one at once", () => {
    expect(new DetectionStabilizer().update([box(0.3, 0.4, 0.42)], 0)).toHaveLength(0);
    expect(new DetectionStabilizer().update([box(0.3, 0.4, 0.8)], 0)).toHaveLength(1);
  });
  it("counts a pose and its object box as one person, and two people as two", () => {
    const steady = new DetectionStabilizer();
    const pose: ImageDetection = { x: 0.31, y: 0.43, width: 0.05, height: 0.12, confidence: 0.9, source: "pose" };
    expect(steady.update([box(0.3, 0.4, 0.7), pose, box(0.7, 0.4, 0.7)], 0)).toHaveLength(2);
  });
  it("smooths a jumping box", () => {
    const steady = new DetectionStabilizer();
    steady.update([box(0.3, 0.4, 0.8)], 0);
    expect(steady.update([box(0.34, 0.4, 0.8)], 300)[0].x).toBeCloseTo(0.32, 5);
  });
  it("measures a pose extent only from visible points", () => {
    const point = (x: number, y: number, visibility: number) => ({ x, y, visibility });
    expect(poseExtent([point(0.4, 0.3, 0.9), point(0.45, 0.3, 0.9), point(0.4, 0.5, 0.9), point(0.45, 0.5, 0.9), point(0.9, 0.9, 0.1)])).toMatchObject({ source: "pose" });
    expect(poseExtent([point(0.4, 0.3, 0.9), point(0.45, 0.3, 0.2)])).toBeUndefined();
  });
});
