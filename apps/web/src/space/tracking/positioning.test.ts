import { describe, expect, it } from "vitest";
import type { Navigation, Point } from "../types";
import { locatePerson, withinBoundary } from "./positioning";
import { HOLD_MS, PersonTracker } from "./tracker";
import type { CameraCalibration, PoseLandmark } from "./types";

// Camera 1.7 m above the floor at the origin, looking along +z and tilted 20° down; no lens distortion.
const tilt = 20 * Math.PI / 180, c = Math.cos(tilt), s = Math.sin(tilt);
// Columns are camera right/down/forward in the Y-up room.
const worldFromCamera = [-1, 0, 0, 0, -c, -s, 0, -s, c];
const center = { x: 0, y: 1.7, z: 0 }, width = 1280, height = 720, f = 900;
const camera: CameraCalibration = {
  id: "camera", name: "Camera", sceneVersion: 1, revision: "r", imageWidth: width, imageHeight: height, points: [], homography: [],
  updatedAt: "", fitErrorMeters: 0,
  geometry: { center, worldFromCamera, intrinsics: { fx: f, fy: f, cx: width / 2, cy: height / 2, k1: 0, k2: 0 }, source: "sfm", inliers: 100, reprojectionErrorPx: 1 },
};
const navigation: Navigation = {
  floorY: 0, boundary: [[-3, 0.5], [3, 0.5], [3, 6], [-3, 6]], spawn: [0, 0, 2], yaw: 0,
  eyeHeight: 1.6, speed: 1.4, capsuleRadius: 0.25, capsuleHeight: 1.7, obstacles: [],
};
const project = (p: Point): PoseLandmark => {
  const d = { x: p.x - center.x, y: p.y - center.y, z: p.z - center.z }, r = worldFromCamera;
  // Camera = Rᵀ·(world − center).
  const x = r[0] * d.x + r[3] * d.y + r[6] * d.z, y = r[1] * d.x + r[4] * d.y + r[7] * d.z, z = r[2] * d.x + r[5] * d.y + r[8] * d.z;
  return { x: (f * x / z + width / 2) / width, y: (f * y / z + height / 2) / height, z: 0, visibility: 0.95, presence: 0.95 };
};
const hidden = (): PoseLandmark[] => Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.05, presence: 0.05 }));

describe("locatePerson", () => {
  it("estimates a side-on person from one shoulder-hip line when feet and face are hidden", () => {
    const pose = hidden();
    pose[11] = project({ x: 0.6, y: 1.42, z: 3.2 });
    pose[23] = project({ x: 0.6, y: 0.92, z: 3.2 });
    const result = locatePerson(pose, camera, navigation);
    expect(result.detection?.positionMethod).toBe("estimated");
    expect(Math.hypot(result.detection!.x - 0.6, result.detection!.z - 3.2)).toBeLessThan(0.15);
  });

  it("places a person from a visible ankle when heel and toe are hidden", () => {
    const pose = hidden();
    pose[27] = project({ x: -0.4, y: 0.08, z: 2.5 });
    const result = locatePerson(pose, camera, navigation);
    expect(result.detection?.positionMethod).toBe("floor");
    expect(Math.hypot(result.detection!.x + 0.4, result.detection!.z - 2.5)).toBeLessThan(0.02);
  });

  it("uses a single visible floor contact per foot", () => {
    const pose = hidden();
    pose[29] = project({ x: 1, y: 0, z: 4 });
    const result = locatePerson(pose, camera, navigation);
    expect(result.detection?.positionMethod).toBe("floor");
    expect(Math.hypot(result.detection!.x - 1, result.detection!.z - 4)).toBeLessThan(0.02);
  });

  it("snaps a foot just outside the walking area onto its edge but rejects distant points", () => {
    expect(withinBoundary({ x: 3.1, z: 2 }, navigation.boundary, 0.25)).toEqual({ x: 3, z: 2 });
    expect(withinBoundary({ x: 4, z: 2 }, navigation.boundary, 0.25)).toBeUndefined();
  });
});

describe("PersonTracker", () => {
  it("holds a confirmed person through a short detection gap and drops them afterwards", () => {
    const tracker = new PersonTracker(), pose = hidden();
    pose[29] = project({ x: 0, y: 0, z: 3 });
    for (let t = 1000; t <= 1250; t += 125) expect(tracker.update([pose], camera, navigation, t)).toHaveLength(1);
    expect(tracker.update([], camera, navigation, 1250 + HOLD_MS - 50)).toHaveLength(1);
    expect(tracker.update([], camera, navigation, 1250 + HOLD_MS + 100)).toHaveLength(0);
  });

  it("smooths measurement noise on a standing person", () => {
    const tracker = new PersonTracker();
    let maximum = 0;
    for (let i = 0; i < 40; i++) {
      const pose = hidden();
      pose[29] = project({ x: (i % 2 ? 0.08 : -0.08), y: 0, z: 3 });
      const [person] = tracker.update([pose], camera, navigation, 1000 + i * 125);
      if (i > 10) maximum = Math.max(maximum, Math.abs(person.position.x));
    }
    expect(maximum).toBeLessThan(0.05);
  });
});
