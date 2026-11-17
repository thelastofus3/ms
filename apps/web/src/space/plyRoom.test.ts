import { describe, expect, it } from "vitest";
import { describeRoom, obstacleRuns, readGaussianPly } from "./plyRoom";

/** A binary Gaussian PLY with the usual properties: position, normal, three DC colours, opacity, scales, rotation. */
function gaussianPly(splats: { at: number[]; opacity: number; scales: number[]; rotation: number[] }[]): ArrayBuffer {
  const names = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${splats.length}\n${names.map(n => `property float ${n}`).join("\n")}\nend_header\n`;
  const head = new TextEncoder().encode(header), buffer = new ArrayBuffer(head.length + splats.length * names.length * 4), view = new DataView(buffer, head.length);
  new Uint8Array(buffer).set(head);
  splats.forEach((s, i) => [...s.at, 0, 0, 0, 0.5, 0.5, 0.5, s.opacity, ...s.scales, ...s.rotation].forEach((value, k) => view.setFloat32((i * names.length + k) * 4, value, true)));
  return buffer;
}

describe("reading an imported Gaussian PLY", () => {
  it("keeps opaque splats and gives flat ones the direction they face", () => {
    const quarterTurnAboutX = [Math.SQRT1_2, Math.SQRT1_2, 0, 0];   // w, x, y, z: local z turns to -y
    const cloud = readGaussianPly(gaussianPly([
      { at: [1, 2, 3], opacity: 3, scales: [Math.log(0.1), Math.log(0.1), Math.log(0.005)], rotation: quarterTurnAboutX },
      { at: [4, 5, 6], opacity: -3, scales: [0, 0, 0], rotation: [1, 0, 0, 0] },                        // nearly transparent: dropped
      { at: [7, 8, 9], opacity: 3, scales: [Math.log(0.1), Math.log(0.09), Math.log(0.08)], rotation: [1, 0, 0, 0] },   // round: no facing
    ]))!;
    expect([...cloud.centres]).toEqual([1, 2, 3, 7, 8, 9]);
    expect(Math.abs(cloud.normals[1])).toBeCloseTo(1, 5);
    expect([...cloud.normals.slice(3)]).toEqual([0, 0, 0]);
  });
  it("refuses what is not a binary Gaussian PLY", () => {
    expect(readGaussianPly(new TextEncoder().encode("ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n1\n").buffer)).toBeUndefined();
  });
});

type V = [number, number, number];
/** A furnished 4 x 3 m room, 2.6 m high, in units of `unit` metres, turned to an arbitrary orientation and offset. */
function scan(unit: number) {
  let seed = 7; const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296, noise = () => (random() - 0.5) * 0.02;
  const centres: number[] = [], normals: number[] = [];
  const add = (p: V, n: V) => { centres.push(...p); normals.push(...n); };
  const box = (x0: number, x1: number, z0: number, z1: number, top: number, count: number) => {
    for (let i = 0; i < count; i++) add([x0 + random() * (x1 - x0), top + noise(), z0 + random() * (z1 - z0)], [0, 1, 0]);
    for (let i = 0; i < count / 2; i++) { const y = random() * top; add([x0 + noise(), y, z0 + random() * (z1 - z0)], [1, 0, 0]); add([x1 + noise(), y, z0 + random() * (z1 - z0)], [1, 0, 0]); }
  };
  for (let i = 0; i < 30000; i++) add([random() * 4, noise(), random() * 3], [0, 1, 0]);                 // floor
  for (let i = 0; i < 6000; i++) add([random() * 4, 2.6 + noise(), random() * 3], [0, 1, 0]);             // a little ceiling
  for (let i = 0; i < 12000; i++) { const y = random() * 2.6; add([noise(), y, random() * 3], [1, 0, 0]); add([4 + noise(), y, random() * 3], [1, 0, 0]); add([random() * 4, y, noise()], [0, 0, 1]); add([random() * 4, y, 3 + noise()], [0, 0, 1]); }
  box(0, 2, 0, 0.9, 0.5, 20000);   // bed: larger than the floor left visible beside it would be in many scans
  box(3, 4, 2, 3, 0.75, 6000);     // desk
  // Rugs and shoes: low clutter on the floor that must not tilt it.
  for (let i = 0; i < 3000; i++) add([2.2 + random() * 0.6, 0.03 + random() * 0.05, 1.2 + random() * 0.4], [random(), 1, random()]);
  // Turn the whole scan (the file's axes have nothing to do with gravity), shift it, express it in file units.
  const a = 0.7, b = -1.1, c = 2.3, rx = (p: V): V => [p[0], p[1] * Math.cos(a) - p[2] * Math.sin(a), p[1] * Math.sin(a) + p[2] * Math.cos(a)];
  const ry = (p: V): V => [p[0] * Math.cos(b) + p[2] * Math.sin(b), p[1], -p[0] * Math.sin(b) + p[2] * Math.cos(b)], rz = (p: V): V => [p[0] * Math.cos(c) - p[1] * Math.sin(c), p[0] * Math.sin(c) + p[1] * Math.cos(c), p[2]];
  const turn = (p: V) => rz(ry(rx(p)));
  const out = new Float32Array(centres.length), facing = new Float32Array(normals.length);
  for (let k = 0; k < centres.length; k += 3) {
    const p = turn([centres[k], centres[k + 1], centres[k + 2]]), n = turn([normals[k], normals[k + 1], normals[k + 2]]);
    out.set([(p[0] + 5) / unit, (p[1] - 2) / unit, (p[2] + 1) / unit], k); facing.set(n, k);
  }
  return { centres: out, normals: facing, up: turn([0, 1, 0]), toFile: (p: V) => { const q = turn(p); return [(q[0] + 5) / unit, (q[1] - 2) / unit, (q[2] + 1) / unit] as V; } };
}
const angle = (a: number[], b: number[]) => Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.hypot(...a) / Math.hypot(...b))) * 180 / Math.PI;

describe("an imported PLY as a room", () => {
  it("finds the floor, which way is up and the size of a turned, furnished room", () => {
    const room = scan(1)!, shape = describeRoom(room.centres, room.normals)!;
    expect(angle(shape.up, room.up)).toBeLessThan(2);
    expect(shape.up[0] * room.up[0] + shape.up[1] * room.up[1] + shape.up[2] * room.up[2]).toBeGreaterThan(0);   // floor below, not the ceiling
    expect(shape.scaleFrom).toBe("units");
    expect(shape.height).toBeGreaterThan(2.4); expect(shape.height).toBeLessThan(2.8);
    // The start point stands on the floor, clear of the bed and the desk.
    const floorPoint = room.toFile([1, 0, 2]), s = shape.spawn, offset = (s.x - floorPoint[0]) * shape.up[0] + (s.y - floorPoint[1]) * shape.up[1] + (s.z - floorPoint[2]) * shape.up[2];
    expect(Math.abs(offset)).toBeLessThan(0.05);
    expect(shape.boundary.length).toBeGreaterThanOrEqual(3);
  });

  it("scales a scan in unknown units to a room of ordinary height", () => {
    const shape = describeRoom(scan(0.03).centres, scan(0.03).normals)!;
    expect(shape.scaleFrom).toBe("ceiling");
    expect(shape.height * shape.metresPerUnit).toBeCloseTo(2.6, 1);
    expect(shape.metresPerUnit).toBeGreaterThan(0.025); expect(shape.metresPerUnit).toBeLessThan(0.035);
  });

  it("blocks furniture for walking but not the floor or what is lying on it", () => {
    const centres: number[] = [];
    for (let i = 0; i < 400; i++) centres.push(Math.random() * 2, 0.01, Math.random() * 2);            // floor
    for (let i = 0; i < 400; i++) centres.push(1 + Math.random() * 0.2, 0.3 + Math.random() * 1.2, 1 + Math.random() * 0.2);   // a cabinet
    for (let i = 0; i < 3; i++) centres.push(0.5, 1, 0.5);                                              // a few floaters in mid-air
    const runs = obstacleRuns(new Float32Array(centres), 0);
    const blocked = (x: number, z: number) => runs.some(([rx, rz, cells]) => z >= rz && z < rz + 0.1 && x >= rx && x < rx + cells * 0.1);
    expect(blocked(1.1, 1.1)).toBe(true);
    expect(blocked(0.5, 0.5)).toBe(false);
    expect(blocked(1.7, 1.7)).toBe(false);
  });
});
