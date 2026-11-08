import { beforeEach, expect, it, vi } from "vitest";
import { parseManifest } from "./types";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const asset = { path: "room.ply", url: "/room.ply", bytes: 200, sha256: "a".repeat(64) };
const imported = () => ({ schemaVersion: 1, sceneId: "scene", version: 1, sourceType: "gaussian-ply", ready: false, units: "uncalibrated", axes: "right-handed-y-up", assets: { splats: asset }, worldFromReconstruction: identity, previewCamera: identity, collisionReviewed: false });
beforeEach(() => vi.stubGlobal("location", { href: "https://studio.test/" }));
it("opens an imported PLY package with no collision asset", () => {
  expect(parseManifest(imported()).assets.splats.path).toBe("room.ply");
});
it("requires a collision asset for reconstructed scenes", () => {
  const { sourceType, ...capture } = imported();
  expect(() => parseManifest(capture)).toThrow("Invalid room asset");
});
it("rejects imported packages claiming metric calibration or walking readiness", () => {
  expect(() => parseManifest({ ...imported(), units: "meters" })).toThrow();
  expect(() => parseManifest({ ...imported(), collisionReviewed: true })).toThrow();
});
