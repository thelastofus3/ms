import { describe, expect, it } from "vitest";
import { FaceGallery, faceDistance } from "./faces";
import { FaceIdentifier } from "./identity";
import { headCrop } from "./recognition";

const match = (avatarId: string, distance: number, margin = 0.3) => ({ avatarId, distance, margin });

describe("FaceIdentifier", () => {
  it("accepts one very close match at once and an ordinary one only when it repeats", () => {
    const faces = new FaceIdentifier();
    faces.observe("1", match("anna", 0.36), 0);
    expect(faces.identity("1")).toBe("anna");
    faces.observe("2", match("boris", 0.47), 0);
    expect(faces.identity("2")).toBeUndefined();
    faces.observe("2", match("boris", 0.46), 700);
    expect(faces.identity("2")).toBe("boris");
  });

  it("leaves a stranger unidentified", () => {
    const faces = new FaceIdentifier();
    for (let i = 0; i < 6; i++) faces.observe("1", match("anna", 0.63), i * 700);
    expect(faces.identity("1")).toBeUndefined();
  });

  it("does not choose between two avatars that match equally well", () => {
    const faces = new FaceIdentifier();
    for (let i = 0; i < 4; i++) faces.observe("1", match("anna", 0.4, 0.02), i * 700);
    expect(faces.identity("1")).toBeUndefined();
  });

  it("keeps an identity while the face is hidden and through one bad look", () => {
    const faces = new FaceIdentifier();
    faces.observe("1", match("anna", 0.35), 0);
    faces.observe("1", undefined, 6000);
    faces.observe("1", match("boris", 0.7), 12000);
    expect(faces.identity("1")).toBe("anna");
  });

  it("withdraws an identity after two clearly different faces", () => {
    const faces = new FaceIdentifier();
    faces.observe("1", match("anna", 0.35), 0);
    faces.observe("1", match("anna", 0.72), 6000);
    faces.observe("1", match("anna", 0.75), 12000);
    expect(faces.identity("1")).toBeUndefined();
  });

  it("gives an avatar to only one person at a time, the closer match", () => {
    const faces = new FaceIdentifier();
    faces.observe("1", match("anna", 0.39), 0);
    faces.observe("2", match("anna", 0.3), 100);
    expect(faces.identity("1")).toBeUndefined();
    expect(faces.identity("2")).toBe("anna");
    faces.observe("3", match("anna", 0.39), 200);
    expect(faces.identity("3")).toBeUndefined();
  });

  it("looks at unknown people often, at known ones rarely, and forgets tracks that are gone", () => {
    const faces = new FaceIdentifier();
    expect(faces.due("1", 0)).toBe(true);
    faces.attempted("1", 0);
    expect(faces.due("1", 500)).toBe(false);
    expect(faces.due("1", 800)).toBe(true);
    faces.observe("1", match("anna", 0.3), 800); faces.attempted("1", 800);
    expect(faces.due("1", 3000)).toBe(false);
    expect(faces.due("1", 7000)).toBe(true);
    faces.seen([], 12000);
    expect(faces.identity("1")).toBeUndefined();
  });
});

describe("FaceGallery", () => {
  const face = (...head: number[]) => Float32Array.from([...head, ...Array(128 - head.length).fill(0)]);
  it("matches the closest avatar and reports how far the runner-up is", () => {
    const gallery = new FaceGallery();
    gallery.entries = [{ avatarId: "anna", label: "Anna", descriptors: [face(0), face(0.1)] }, { avatarId: "boris", label: "Boris", descriptors: [face(1), face(0.9)] }];
    const found = gallery.match(face(0.05))!;
    expect(found.avatarId).toBe("anna");
    expect(found.distance).toBeCloseTo(0.05);
    expect(found.margin).toBeCloseTo(0.85);
    expect(faceDistance(face(0, 3), face(4, 0))).toBeCloseTo(5);
  });

  it("ignores avatars whose photos showed no face", () => {
    const gallery = new FaceGallery();
    gallery.entries = [{ avatarId: "anna", label: "Anna", descriptors: [] }];
    expect(gallery.match(face(0))).toBeUndefined();
  });
});

describe("headCrop", () => {
  const landmark = (x: number, y: number) => ({ x, y, visibility: 0.9 });
  it("frames the head from facial landmarks with room to spare and stays inside the image", () => {
    const pose = [landmark(0.5, 0.2), landmark(0.51, 0.19), landmark(0.515, 0.19), landmark(0.52, 0.19), landmark(0.49, 0.19), landmark(0.485, 0.19), landmark(0.48, 0.19), landmark(0.53, 0.195), landmark(0.47, 0.195)];
    const crop = headCrop(pose, undefined, 1280, 720, 16)!;
    expect(crop.width).toBeGreaterThan(0.06 * 1280 * 2.5);
    expect(crop.x).toBeGreaterThanOrEqual(0); expect(crop.y).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.width).toBeLessThanOrEqual(1280); expect(crop.y + crop.height).toBeLessThanOrEqual(720);
    expect(crop.x + crop.width / 2).toBeCloseTo(640, -2);
  });
  it("skips a face too small to recognise", () => {
    const pose = [landmark(0.5, 0.2), landmark(0.503, 0.198), landmark(0.497, 0.198), landmark(0.505, 0.199)];
    expect(headCrop(pose, undefined, 1280, 720, 16)).toBeUndefined();
  });
  it("uses a head-shaped detector box when there is no pose, but not a whole-body box", () => {
    expect(headCrop(undefined, { x: 0.4, y: 0.1, width: 0.05, height: 0.1, confidence: 0.7 }, 1280, 720, 16)).toBeDefined();
    expect(headCrop(undefined, { x: 0.4, y: 0.1, width: 0.1, height: 0.7, confidence: 0.9 }, 1280, 720, 16)).toBeUndefined();
  });
});
