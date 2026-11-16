import { describe, expect, it } from "vitest";
import type { Navigation, Point } from "../types";
import { locateBox, locatePerson, withinBoundary } from "./positioning";
import { HOLD_MS, PersonTracker } from "./tracker";
import type { CameraCalibration, ImageDetection, PoseLandmark } from "./types";

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

/** A second synthetic camera, for the high wall-corner mounting where rays to a head point clearly downwards. */
function rig(cameraHeight: number, tiltDegrees: number) {
  const angle = tiltDegrees * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle), rotation = [-1, 0, 0, 0, -cos, -sin, 0, -sin, cos], eye = { x: 0, y: cameraHeight, z: 0 };
  const calibration: CameraCalibration = { ...camera, id: `camera-${cameraHeight}`, geometry: { ...camera.geometry!, center: eye, worldFromCamera: rotation } };
  const toImage = (p: Point): PoseLandmark => {
    const d = { x: p.x - eye.x, y: p.y - eye.y, z: p.z - eye.z }, r = rotation;
    const x = r[0] * d.x + r[3] * d.y + r[6] * d.z, y = r[1] * d.x + r[4] * d.y + r[7] * d.z, z = r[2] * d.x + r[5] * d.y + r[8] * d.z;
    return { x: (f * x / z + width / 2) / width, y: (f * y / z + height / 2) / height, z: 0, visibility: 0.95, presence: 0.95 };
  };
  return { calibration, toImage };
}
/** Facial landmarks of a head whose eyes are at `eyes`, turned `yawDegrees` away from facing the camera along −z. */
function face(pose: PoseLandmark[], eyes: Point, toImage: (p: Point) => PoseLandmark, yawDegrees = 0) {
  const yaw = yawDegrees * Math.PI / 180, at = (side: number, up: number, forward = 0) => toImage({ x: eyes.x + side * Math.cos(yaw) + forward * Math.sin(yaw), y: eyes.y + up, z: eyes.z + side * Math.sin(yaw) - forward * Math.cos(yaw) });
  pose[0] = at(0, -0.035, 0.03); pose[2] = at(0.0315, 0); pose[5] = at(-0.0315, 0); pose[3] = at(0.045, 0); pose[6] = at(-0.045, 0);
  pose[7] = at(0.0725, -0.01, -0.09); pose[8] = at(-0.0725, -0.01, -0.09); pose[9] = at(0.025, -0.068); pose[10] = at(-0.025, -0.068);
  return pose;
}
const headBox = (crown: Point, toImage: (p: Point) => PoseLandmark, confidence = 0.7): ImageDetection => {
  const top = toImage(crown), bottom = toImage({ ...crown, y: crown.y - 0.26 }), boxHeight = bottom.y - top.y, boxWidth = boxHeight * height / width / 1.25;
  return { x: top.x - boxWidth / 2, y: top.y, width: boxWidth, height: boxHeight, confidence, source: "object" };
};
const offBy = (found: { x: number; z: number } | undefined, x: number, z: number) => found ? Math.hypot(found.x - x, found.z - z) : Infinity;

describe("head-only positions", () => {
  it("estimates a person from facial landmarks alone when the camera is level with the head", () => {
    const result = locatePerson(face(hidden(), { x: 0.5, y: 1.6, z: 2.5 }, project), camera, navigation);
    expect(result.detection?.positionMethod).toBe("estimated");
    expect(offBy(result.detection, 0.5, 2.5)).toBeLessThan(0.2);
  });

  it("stays accurate when the head is turned, using the face height instead of its foreshortened width", () => {
    const result = locatePerson(face(hidden(), { x: -0.4, y: 1.6, z: 2.5 }, project, 50), camera, navigation);
    expect(offBy(result.detection, -0.4, 2.5)).toBeLessThan(0.3);
  });

  it("reports a wider uncertainty for a distant head than for a near one", () => {
    const near = locatePerson(face(hidden(), { x: 0, y: 1.6, z: 2 }, project), camera, navigation).detection!;
    const far = locatePerson(face(hidden(), { x: 0, y: 1.6, z: 4.5 }, project), camera, navigation).detection!;
    expect(far.uncertaintyMeters!).toBeGreaterThan(near.uncertaintyMeters!);
  });

  it("uses the known eye height of a person seen from a high camera", () => {
    const { calibration, toImage } = rig(2.6, 35), pose = face(hidden(), { x: 0.8, y: 1.45, z: 3 }, toImage);
    const personal = locatePerson(pose, calibration, navigation, { eyeHeight: 1.45 }).detection!;
    expect(offBy(personal, 0.8, 3)).toBeLessThan(0.12);
    expect(personal.uncertaintyMeters!).toBeLessThanOrEqual(locatePerson(pose, calibration, navigation).detection!.uncertaintyMeters!);
  });

  it("falls back to the head size when a seated person contradicts the standing height", () => {
    const { calibration, toImage } = rig(2.6, 35);
    const result = locatePerson(face(hidden(), { x: 0, y: 1.15, z: 2.2 }, toImage), calibration, navigation, { eyeHeight: 1.65 });
    expect(offBy(result.detection, 0, 2.2)).toBeLessThan(0.35);
  });

  it("locates a head that only the object detector boxed", () => {
    const { calibration, toImage } = rig(2.6, 35), result = locateBox(headBox({ x: 1, y: 1.71, z: 3 }, toImage), calibration, navigation, { eyeHeight: 1.6 });
    expect(result.detection?.positionMethod).toBe("estimated");
    expect(offBy(result.detection, 1, 3)).toBeLessThan(0.2);
  });

  it("refuses a box whose head is cut off by the top of the frame", () => {
    const { calibration } = rig(2.6, 35);
    expect(locateBox({ x: 0.4, y: 0, width: 0.1, height: 0.2, confidence: 0.8, source: "object" }, calibration, navigation).detection).toBeUndefined();
  });
});

describe("PersonTracker with head-only people", () => {
  it("learns a person's height while their feet are visible and keeps placing them from the head box afterwards", () => {
    const { calibration, toImage } = rig(2.6, 35), tracker = new PersonTracker();
    // A short person: the adult-average prior alone would misplace them.
    const eyeHeight = 1.38, standing = (x: number, z: number) => { const pose = face(hidden(), { x, y: eyeHeight, z }, toImage); pose[29] = toImage({ x, y: 0, z }); pose[31] = toImage({ x, y: 0, z: z - 0.2 }); return pose; };
    let time = 1000;
    for (let i = 0; i < 6; i++, time += 125) expect(tracker.update([standing(0.5, 3.1)], calibration, navigation, time)[0].positionMethod).toBe("floor");
    let people = tracker.update([], calibration, navigation, time, [headBox({ x: 0.5, y: eyeHeight + 0.11, z: 3 }, toImage)]);
    for (let i = 0; i < 4; i++) people = tracker.update([], calibration, navigation, time += 125, [headBox({ x: 0.5, y: eyeHeight + 0.11, z: 3 }, toImage)]);
    // Feet out of sight for half a second: the position still rests on them, the marker does not change colour.
    expect(people[0].positionMethod).toBe("floor");
    for (let i = 0; i < 40; i++) people = tracker.update([], calibration, navigation, time += 125, [headBox({ x: 0.5, y: eyeHeight + 0.11, z: 3 }, toImage)]);
    expect(people).toHaveLength(1);
    expect(people[0].id).toBe("1");
    expect(people[0].positionMethod).toBe("estimated");
    expect(offBy({ x: people[0].position.x, z: people[0].position.z }, 0.5, 3)).toBeLessThan(0.2);
  });

  it("does not add a second marker for the box around an already positioned person", () => {
    const { calibration, toImage } = rig(2.6, 35), tracker = new PersonTracker(), pose = face(hidden(), { x: 0, y: 1.6, z: 3 }, toImage);
    pose[29] = toImage({ x: 0, y: 0, z: 3 });
    const crown = toImage({ x: 0, y: 1.71, z: 3 }), foot = toImage({ x: 0, y: 0, z: 3 });
    const body: ImageDetection = { x: crown.x - 0.05, y: crown.y, width: 0.1, height: foot.y - crown.y, confidence: 0.9, source: "object" };
    expect(tracker.update([pose], calibration, navigation, 1000, [body])).toHaveLength(1);
  });

  it("does not start a track from a weak box", () => {
    const { calibration, toImage } = rig(2.6, 35), tracker = new PersonTracker();
    expect(tracker.update([], calibration, navigation, 1000, [headBox({ x: 0, y: 1.71, z: 3 }, toImage, 0.45)])).toHaveLength(0);
  });

  it("shows a person who is only ever a weak box once they have been seen three times", () => {
    const { calibration, toImage } = rig(2.6, 35), tracker = new PersonTracker(), weak = () => [headBox({ x: 0, y: 1.71, z: 3 }, toImage, 0.45)];
    expect([1000, 1500, 2000, 2500].map(time => tracker.update([], calibration, navigation, time, weak()).length)).toEqual([0, 0, 1, 1]);
    // ...and then keeps them through a missed frame at two frames a second.
    expect(tracker.update([], calibration, navigation, 3000)).toHaveLength(1);
  });

  it("keeps a seated person in place and green while a noisy estimate alternates with their feet", () => {
    const { calibration, toImage } = rig(2.6, 35), tracker = new PersonTracker(), seen: { x: number; z: number; method?: string }[] = [];
    const feet = () => { const pose = hidden(); pose[29] = toImage({ x: 0.5, y: 0, z: 3 }); pose[31] = toImage({ x: 0.5, y: 0, z: 2.8 }); return pose; };
    for (let frame = 0; frame < 16; frame++) {
      // Every other frame the feet are hidden and only a head box is left, placed 0.6 m further along the ray.
      const people = frame % 2 === 0 ? tracker.update([feet()], calibration, navigation, 1000 + frame * 500)
        : tracker.update([], calibration, navigation, 1000 + frame * 500, [headBox({ x: 0.6, y: 1.71, z: 3.6 }, toImage)]);
      expect(people).toHaveLength(1);
      if (frame >= 2) seen.push({ x: people[0].position.x, z: people[0].position.z, method: people[0].positionMethod });
    }
    expect(new Set(seen.map(person => person.method))).toEqual(new Set(["floor"]));
    expect(Math.max(...seen.map(person => person.z)) - Math.min(...seen.map(person => person.z))).toBeLessThan(0.15);
  });

  it("keeps a person in place when they sit down and their feet go out of sight", () => {
    const { calibration, toImage } = rig(2.6, 35), tracker = new PersonTracker();
    const feet = () => { const pose = hidden(); pose[29] = toImage({ x: 0.5, y: 0, z: 3 }); pose[31] = toImage({ x: 0.5, y: 0, z: 2.8 }); return pose; };
    let time = 1000;
    for (let i = 0; i < 4; i++, time += 500) tracker.update([feet()], calibration, navigation, time);
    // Seated: the crown is at 1.25 m, not 1.71 m, so the head box alone reads as a standing person much nearer the camera.
    const alone = new PersonTracker().update([], calibration, navigation, 1000, [headBox({ x: 0.5, y: 1.25, z: 3 }, toImage)]);
    expect(offBy({ x: alone[0].position.x, z: alone[0].position.z }, 0.5, 3)).toBeGreaterThan(0.4);
    let people = tracker.update([], calibration, navigation, time, [headBox({ x: 0.5, y: 1.25, z: 3 }, toImage)]);
    for (let i = 0; i < 60; i++) people = tracker.update([], calibration, navigation, time += 500, [headBox({ x: 0.5, y: 1.25, z: 3 }, toImage)]);
    expect(people).toHaveLength(1);
    expect(people[0].id).toBe("1");
    expect(offBy({ x: people[0].position.x, z: people[0].position.z }, 0.5, 3)).toBeLessThan(0.25);
  });

  it("does not give one person a second marker for a guess along the same line of sight", () => {
    const { calibration, toImage } = rig(2.6, 35), tracker = new PersonTracker(), counts: number[] = [];
    const feet = () => { const pose = hidden(); pose[29] = toImage({ x: 0.5, y: 0, z: 3 }); pose[31] = toImage({ x: 0.5, y: 0, z: 2.8 }); return pose; };
    for (let frame = 0; frame < 12; frame++) {
      // Now and then a head box of the same seated person arrives as well; read as a standing person it lands a metre nearer the camera.
      const extra = frame % 3 === 2 ? [headBox({ x: 0.5, y: 1.25, z: 3 }, toImage, 0.7)] : [];
      counts.push(tracker.update([feet()], calibration, navigation, 1000 + frame * 500, extra).length);
    }
    expect(new Set(counts)).toEqual(new Set([1]));
    // The same guess without the feet, a few frames running, never becomes a second person either.
    for (let frame = 12; frame < 18; frame++) expect(tracker.update([], calibration, navigation, 1000 + frame * 500, [headBox({ x: 0.5, y: 1.25, z: 3 }, toImage, 0.7)])).toHaveLength(1);
  });

  it("lets feet take over a track that was only a guess along the same line of sight", () => {
    const { calibration, toImage } = rig(2.6, 35), tracker = new PersonTracker();
    // Seated at (0.5, 3): the head box alone lands well short of that.
    let people = tracker.update([], calibration, navigation, 1000, [headBox({ x: 0.5, y: 1.25, z: 3 }, toImage, 0.7)]);
    for (let i = 1; i < 4; i++) people = tracker.update([], calibration, navigation, 1000 + i * 500, [headBox({ x: 0.5, y: 1.25, z: 3 }, toImage, 0.7)]);
    expect(offBy({ x: people[0].position.x, z: people[0].position.z }, 0.5, 3)).toBeGreaterThan(0.4);
    const feet = hidden(); feet[29] = toImage({ x: 0.5, y: 0, z: 3 }); feet[31] = toImage({ x: 0.5, y: 0, z: 2.8 });
    for (let i = 4; i < 8; i++) people = tracker.update([feet], calibration, navigation, 1000 + i * 500);
    expect(people.map(person => person.id)).toEqual(["1"]);
    expect(offBy({ x: people[0].position.x, z: people[0].position.z }, 0.5, 2.9)).toBeLessThan(0.2);
  });

  it("does not move or anchor a person on feet the pose model is unsure of", () => {
    const { calibration, toImage } = rig(2.6, 35), tracker = new PersonTracker(), box = () => [headBox({ x: 0.5, y: 1.71, z: 3 }, toImage, 0.7)];
    let people = tracker.update([], calibration, navigation, 1000, box());
    for (let i = 1; i < 4; i++) people = tracker.update([], calibration, navigation, 1000 + i * 500, box());
    const before = { x: people[0].position.x, z: people[0].position.z };
    // One frame of a single ankle, barely visible, a metre nearer along the same line.
    const unsure = hidden(); unsure[27] = { ...toImage({ x: 0.5 * 2 / 3, y: 0.08, z: 2 }), visibility: 0.66, presence: 0.66 };
    people = tracker.update([unsure], calibration, navigation, 3000, box());
    for (let i = 5; i < 9; i++) people = tracker.update([], calibration, navigation, 1000 + i * 500, box());
    expect(people).toHaveLength(1);
    expect(offBy({ x: people[0].position.x, z: people[0].position.z }, before.x, before.z)).toBeLessThan(0.3);
    expect(people[0].positionMethod).toBe("estimated");
  });

  it("reports a low head for a seated person once their distance is known", () => {
    const { calibration, toImage } = rig(2.6, 35), tracker = new PersonTracker();
    const feet = hidden(); feet[29] = toImage({ x: 0.5, y: 0, z: 3 }); feet[31] = toImage({ x: 0.5, y: 0, z: 2.8 });
    let time = 1000, people = tracker.update([feet], calibration, navigation, time);
    for (let i = 0; i < 3; i++) people = tracker.update([feet], calibration, navigation, time += 500);
    for (let i = 0; i < 4; i++) people = tracker.update([], calibration, navigation, time += 500, [headBox({ x: 0.5, y: 1.25, z: 3 }, toImage, 0.7)]);
    expect(people[0].crownHeight!).toBeGreaterThan(1.05);
    expect(people[0].crownHeight!).toBeLessThan(1.45);
  });

  it("keeps one id for a person whose estimated position jumps along the camera ray, at two frames a second", () => {
    const { calibration, toImage } = rig(2.6, 35), tracker = new PersonTracker(), ids = new Set<string>();
    // The head box gives distance from head size: a few pixels of box noise move the estimate by half a metre.
    [3, 3.5, 2.7, 3.4, 2.9, 3.6, 2.8, 3.2].forEach((z, frame) => {
      const people = tracker.update([], calibration, navigation, 1000 + frame * 500, [headBox({ x: 0.5 * z / 3, y: 1.71, z }, toImage)]);
      expect(people).toHaveLength(1); ids.add(people[0].id);
    });
    expect([...ids]).toEqual(["1"]);
  });
});
