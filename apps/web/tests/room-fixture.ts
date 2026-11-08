import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { testAccount, testQuota } from "./auth-fixture";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const properties = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
const header = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex 2\n${properties.map(name => `property float ${name}\n`).join("")}end_header\n`);
const vertices = Buffer.alloc(2 * properties.length * 4);
[[-1, 1, -1, 1, -1, 0, 2, -2, -2, -2, 1, 0, 0, 0], [1, 1, -1, -1, 1, 0, 2, -2, -2, -2, 1, 0, 0, 0]].flat().forEach((value, index) => vertices.writeFloatLE(value, index * 4));
const splats = Buffer.concat([header, vertices]);

// A real GLB floor quad exercises GLTF loading and Rapier's collision setup.
const floor = Buffer.alloc(60);
[-5, 0, -5, -5, 0, 5, 5, 0, 5, 5, 0, -5].forEach((value, index) => floor.writeFloatLE(value, index * 4));
[0, 1, 2, 0, 2, 3].forEach((value, index) => floor.writeUInt16LE(value, 48 + index * 2));
const model = Buffer.from(JSON.stringify({
  asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  buffers: [{ byteLength: floor.length }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48, target: 34962 }, { buffer: 0, byteOffset: 48, byteLength: 12, target: 34963 }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [-5, 0, -5], max: [5, 0, 5] }, { bufferView: 1, componentType: 5123, count: 6, type: "SCALAR" }],
}));
const json = Buffer.concat([model, Buffer.alloc((4 - model.length % 4) % 4, 32)]);
const collision = Buffer.alloc(12 + 8 + json.length + 8 + floor.length);
collision.writeUInt32LE(0x46546c67, 0); collision.writeUInt32LE(2, 4); collision.writeUInt32LE(collision.length, 8);
collision.writeUInt32LE(json.length, 12); collision.writeUInt32LE(0x4e4f534a, 16); json.copy(collision, 20);
collision.writeUInt32LE(floor.length, 20 + json.length); collision.writeUInt32LE(0x004e4942, 24 + json.length); floor.copy(collision, 28 + json.length);
const asset = (path: string, bytes: Buffer) => ({ path, url: `/test-storage/${path}`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });

export const reconstructedJob = { id: "legacy-reconstructed", name: "Calibrated room", state: "READY", stage: "publication", progress: 100, profile: "local", error: null, cancel_requested: false, diagnostics: {}, manifestUrl: "/v1/rooms/jobs/legacy-reconstructed/manifest", version: 1 };
export async function reconstructedRoom(page: Page, sessionValid: () => boolean = () => true, account = testAccount) {
  const manifest = {
    schemaVersion: 1, sceneId: reconstructedJob.id, version: 1, ready: true, units: "meters", axes: "right-handed-y-up", collisionReviewed: true,
    worldFromReconstruction: identity, previewCamera: [...identity.slice(0, 12), 0, 2, 4, 1],
    assets: { splats: asset("room.ply", splats), collision: asset("floor.glb", collision) },
    navigation: { floorY: 0, boundary: [[-5, -5], [-5, 5], [5, 5], [5, -5]], spawn: [0, 0, 3], yaw: 0, eyeHeight: 1.6, speed: 1.4, capsuleRadius: 0.2, capsuleHeight: 1.7, obstacles: [] },
  };
  await page.route("**/v1/rooms/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (!sessionValid()) return route.fulfill({ status: 401, json: { message: "Session expired" } });
    if (path === "/v1/rooms/quota") return route.fulfill({ json: testQuota });
    return route.fulfill({ json: path.endsWith("/auth/me") ? account : path.endsWith("/manifest") ? manifest : path.endsWith("/jobs") ? [reconstructedJob] : path.endsWith("/tracking") ? { cameras: [] } : path.endsWith("/cameras") ? [] : reconstructedJob });
  });
  await page.route("**/test-storage/*", route => route.fulfill({ contentType: "application/octet-stream", body: route.request().url().endsWith("floor.glb") ? collision : splats }));
}
