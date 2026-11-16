import { describe, expect, it } from "vitest";
import { automaticScale, calibrationFromManifest, captureHeightMeters, draftKey, metersPerUnit, scaleWarning, usesAutomaticScale } from "./calibration";
import type { RoomManifest } from "./types";

const scene = (y: number) => ({ sceneId: "s", version: 1, floorProposal: { floorPoints: [{ x: 0, y, z: 0 }, { x: 1, y, z: 0 }, { x: 0, y, z: 1 }] } }) as RoomManifest;

describe("calibration draft key", () => {
  it("is stable for the same detected floor", () => expect(draftKey(scene(0.5))).toBe(draftKey(scene(0.5))));
  it("drops the draft when the detected floor changes", () => expect(draftKey(scene(0.5))).not.toBe(draftKey(scene(0.6))));
  it("works without a detected floor", () => expect(draftKey({ sceneId: "s", version: 2 } as RoomManifest)).toMatch(/^room-calibration-v3:s:2:/));
});

describe("automatic room scale", () => {
  // The room recorded on 2026-11-15: the camera was carried 4.46 reconstruction units above the floor.
  const room = { sceneId: "s", version: 1, ready: false, previewCamera: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], worldFromReconstruction: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    floorProposal: { captureHeight: 4.46, floorPoints: [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }] } } as unknown as RoomManifest;
  it("opens a new room at a usable size without any measurement", () => {
    const calibration = calibrationFromManifest(room);
    expect(usesAutomaticScale(calibration, room)).toBe(true);
    expect(captureHeightMeters(calibration, room)).toBeCloseTo(1.45, 2);
    expect(scaleWarning(calibration, room)).toBeUndefined();
  });
  it("warns about the measurement that made people look too big, and accepts the corrected one", () => {
    const measured = (meters: number) => ({ ...calibrationFromManifest(room), measurement: [{ x: 0, y: 0, z: 0 }, { x: 3.9598, y: 0, z: 0 }], meters });
    // Entered as 1 m, the camera would have been at 1.13 m: flagged, with the direction of the error.
    expect(scaleWarning(measured(1), room)).toMatch(/1\.13 m.*larger.*too big/);
    expect(scaleWarning(measured(1.22), room)).toBeUndefined();
    expect(scaleWarning(measured(2), room)).toMatch(/smaller.*too small/);
  });
  it("offers nothing for a room reconstructed before the camera height was recorded", () => {
    const old = { ...room, floorProposal: { floorPoints: room.floorProposal!.floorPoints } } as RoomManifest;
    expect(automaticScale(old)).toBeUndefined();
    expect(metersPerUnit(calibrationFromManifest(old))).toBeUndefined();
    expect(scaleWarning(calibrationFromManifest(old), old)).toBeUndefined();
  });
});
