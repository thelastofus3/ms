import type { Point } from "./types";

/**
 * A room read out of an imported Gaussian PLY. A reconstruction comes with camera poses and a collision mesh; a PLY is
 * only the splats, so the floor, which way is up, the size and the furniture are found in the splat centres themselves.
 * Everything here is in the file's own units and axes.
 */
export type RoomShape = {
  up: [number, number, number];
  /** Three floor points for the calibration (origin, forward, right) and a hull of the floor that was actually seen. */
  floorPoints: Point[]; boundary: Point[]; spawn: Point;
  /** Floor to ceiling in file units, and the scale that makes it a plausible room. */
  height: number; metresPerUnit: number; scaleFrom: "units" | "ceiling";
};
type V = [number, number, number];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V): V => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const point = (v: V): Point => ({ x: v[0], y: v[1], z: v[2] });
const quantile = (values: Float32Array | number[], q: number) => { const sorted = Float32Array.from(values).sort(); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] : 0; };

/** Eigenvectors of a symmetric 3x3 matrix (Jacobi rotations), smallest eigenvalue first. */
function eigen(m: number[][]): V[] {
  const a = m.map(row => [...row]), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
    if (Math.abs(a[p][q]) < 1e-14) continue;
    const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
    for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
    for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
    for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
  }
  return [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]).map(i => unit([v[0][i], v[1][i], v[2][i]]));
}
function covariance(points: V[]): { mean: V; axes: V[] } {
  const mean: V = [0, 0, 0];
  for (const p of points) { mean[0] += p[0]; mean[1] += p[1]; mean[2] += p[2]; }
  mean[0] /= points.length; mean[1] /= points.length; mean[2] /= points.length;
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) { const d = [p[0] - mean[0], p[1] - mean[1], p[2] - mean[2]]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += d[i] * d[j]; }
  return { mean, axes: eigen(m) };
}
/** Level surfaces (floor, table tops, shelves, ceiling) stack up along the vertical and nowhere else: how sharply the points bunch along an axis. */
function layering(points: V[], axis: V): number {
  const heights = points.map(p => dot(p, axis)), low = quantile(heights, 0.01), high = quantile(heights, 0.99), bins = new Float64Array(96);
  if (!(high > low)) return 0;
  for (const h of heights) { const i = Math.floor((h - low) / (high - low) * 96); if (i >= 0 && i < 96) bins[i]++; }
  return [...bins].sort((a, b) => b - a).slice(0, 6).reduce((sum, count) => sum + count, 0) / points.length;
}
function hull(points: [number, number][]): [number, number][] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]), turn = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const p of sorted) { while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of sorted.reverse()) { while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * The room's three main surface directions from the facing of flat splats: floor and ceiling share one, each pair of
 * walls another. Rooms are built at right angles, so these are the building's own axes, whatever way the file is turned.
 */
export function roomAxes(normals: Float32Array): { axes: V[]; shares: number[] } | undefined {
  const all: V[] = [];
  for (let k = 0; k + 2 < normals.length; k += 3) { const n: V = [normals[k], normals[k + 1], normals[k + 2]]; const l = Math.hypot(...n); if (l > 0.5) all.push([n[0] / l, n[1] / l, n[2] / l]); }
  if (all.length < 500) return;
  const sample = all.filter((_, i) => i % Math.max(1, Math.floor(all.length / 40000)) === 0), near = Math.cos(12 * Math.PI / 180);
  const best = (allowed: (d: V) => boolean): V | undefined => {
    let top: V | undefined, score = 0;
    for (let c = 0; c < sample.length; c += Math.max(1, Math.floor(sample.length / 400))) {
      const d = sample[c]; if (!allowed(d)) continue;
      let s = 0; for (const n of sample) if (Math.abs(dot(n, d)) > near) s++;
      if (s > score) { score = s; top = d; }
    }
    if (!top) return;
    // Refine: the average of the normals around it, each turned to the same side.
    const sum: V = [0, 0, 0];
    for (const n of sample) { const c = dot(n, top); if (Math.abs(c) > near) { const sign = Math.sign(c); sum[0] += n[0] * sign; sum[1] += n[1] * sign; sum[2] += n[2] * sign; } }
    return unit(sum);
  };
  const first = best(() => true); if (!first) return;
  const second = best(d => Math.abs(dot(d, first)) < Math.sin(15 * Math.PI / 180)); if (!second) return;
  const straight = unit(cross(first, unit([second[0] - dot(second, first) * first[0], second[1] - dot(second, first) * first[1], second[2] - dot(second, first) * first[2]])));
  const secondStraight = cross(straight, first), axes: V[] = [first, secondStraight, straight];
  const shares = axes.map(a => sample.filter(n => Math.abs(dot(n, a)) > near).length / sample.length);
  return { axes, shares };
}

export function describeRoom(cloud: Float32Array, normals?: Float32Array): RoomShape | undefined {
  const total = Math.floor(cloud.length / 3);
  if (total < 3000) return;
  const stride = Math.max(1, Math.floor(total / 60000)), all: V[] = [], allFacing: V[] = [];
  for (let i = 0; i < total; i += stride) {
    const p: V = [cloud[i * 3], cloud[i * 3 + 1], cloud[i * 3 + 2]];
    if (p.every(Number.isFinite)) { all.push(p); allFacing.push(normals ? [normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]] : [0, 0, 0]); }
  }
  // Stray splats far outside the room would stretch every measure below.
  const limits = [0, 1, 2].map(k => { const values = all.map(p => p[k]), low = quantile(values, 0.01), high = quantile(values, 0.99), pad = (high - low) * 0.1; return [low - pad, high + pad]; });
  const keep = all.map(p => p.every((value, k) => value >= limits[k][0] && value <= limits[k][1]));
  const points = all.filter((_, i) => keep[i]), facing = allFacing.filter((_, i) => keep[i]);
  if (points.length < 2000) return;
  // The vertical is one of the room's own axes. With surface normals: the direction most surfaces face (floor, bed and
  // table tops together outweigh any pair of walls), and of two close candidates the shorter one, since rooms are wider
  // than they are high (7 degrees off on a scanned bedroom; the next axis was 89 degrees off). Without normals: the axis
  // along which the points are most layered.
  const frame = normals ? roomAxes(normals) : undefined, extent = (axis: V) => { const h = points.map(p => dot(p, axis)); return quantile(h, 0.99) - quantile(h, 0.01); };
  const vertical = frame
    ? frame.axes.map((axis, i) => ({ axis, score: frame.shares[i] / Math.max(...frame.shares) - 0.3 * extent(axis) / Math.max(...frame.axes.map(extent)) })).sort((a, b) => b.score - a.score)[0].axis
    : [...covariance(points).axes].sort((a, b) => layering(points, b) - layering(points, a))[0];
  const heightsAlong = (axis: V) => points.map(p => dot(p, axis));
  let heights = heightsAlong(vertical), low = quantile(heights, 0.01), high = quantile(heights, 0.99);
  const below = heights.filter(h => h < low + (high - low) * 0.4).length, above = heights.filter(h => h > high - (high - low) * 0.4).length;
  let up: V = below >= above ? vertical : [-vertical[0], -vertical[1], -vertical[2]];
  // Refit the floor on its own points: the room's axes are only roughly the building's. Start from a thick layer at the
  // floor end (a few degrees of tilt across a room move the floor by more than a thin layer), then narrow it.
  if (normals) {
    const level = (axis: V) => { const h = heightsAlong(axis), lo = quantile(h, 0.01), hi = quantile(h, 0.99), bins = new Float64Array(60), step = (hi - lo) / 60;
      for (const value of h) { const i = Math.floor((value - lo) / step); if (i >= 0 && i < 60) bins[i]++; }
      const strongest = Math.max(...bins.slice(0, 20)), first = [...bins.slice(0, 20)].findIndex(count => count >= strongest * 0.4);
      return { h, range: hi - lo, at: lo + (first + 0.5) * step }; };
    // The floor is the plane on which the most points lie near the floor end: tried on many planes through three points each
    // (RANSAC). A fit through every point of a layer, or an average of splat facings, was pulled 5-7 degrees by rugs,
    // furniture feet and skirting boards in the same layer; the plane with the most support is not.
    const { h, range, at } = level(up), candidates = points.filter((_, i) => Math.abs(h[i] - at) <= range * 0.12);
    if (candidates.length >= 300) {
      const tolerance = range * 0.004, random = (() => { let seed = 12345; return () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296; })();
      const near = (normal: V, offset: number) => candidates.filter(p => Math.abs(dot(p, normal) - offset) <= tolerance);
      let best: { normal: V; offset: number; support: number } | undefined;
      for (let attempt = 0; attempt < 600; attempt++) {
        const [a, b, c] = [0, 1, 2].map(() => candidates[Math.floor(random() * candidates.length)]);
        const n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]), l = Math.hypot(...n);
        if (l < 1e-9) continue;
        let normal: V = [n[0] / l, n[1] / l, n[2] / l]; if (dot(normal, up) < 0) normal = [-normal[0], -normal[1], -normal[2]];
        if (dot(normal, up) < Math.cos(15 * Math.PI / 180)) continue;
        const offset = dot(a, normal);
        let support = 0; for (const p of candidates) if (Math.abs(dot(p, normal) - offset) <= tolerance) support++;
        if (!best || support > best.support) best = { normal, offset, support };
      }
      // Least squares on the winner's own points, twice.
      for (let pass = 0; best && pass < 2; pass++) {
        const inliers = near(best.normal, best.offset); if (inliers.length < 100) break;
        const fit = covariance(inliers), normal: V = dot(fit.axes[0], up) >= 0 ? fit.axes[0] : [-fit.axes[0][0], -fit.axes[0][1], -fit.axes[0][2]];
        best = { normal, offset: dot(fit.mean, normal), support: inliers.length };
      }
      if (best && dot(best.normal, up) >= Math.cos(15 * Math.PI / 180)) up = best.normal;
    }
  }
  for (let pass = 0; pass < (normals ? 0 : 3); pass++) {
    heights = heightsAlong(up); low = quantile(heights, 0.01); high = quantile(heights, 0.99);
    const bins = new Float64Array(120), step = (high - low) / 120;
    for (const h of heights) { const i = Math.floor((h - low) / step); if (i >= 0 && i < 120) bins[i]++; }
    // The lowest strong layer, not the strongest one: a table top or a bed can outweigh the floor that is left visible.
    const strongest = Math.max(...bins.slice(0, 40)), first = [...bins.slice(0, 40)].findIndex(count => count >= strongest * 0.4);
    const level = low + (first + 0.5) * step, inSlab = points.map((_, i) => Math.abs(heights[i] - level) <= step * 1.5);
    // Splats that face up are the floor itself; legs of furniture, skirting boards and the bottoms of walls are not, and
    // tilt a fit through every point near the floor (6 degrees, 18 cm at two metres on a scanned bedroom).
    const upward = normals ? points.filter((_, i) => inSlab[i] && Math.abs(dot(facing[i], up)) > Math.cos(20 * Math.PI / 180)) : [];
    const slab = upward.length >= 200 ? upward : points.filter((_, i) => inSlab[i]);
    if (slab.length < 200) break;
    const normal = covariance(slab).axes[0], aligned: V = dot(normal, up) >= 0 ? normal : [-normal[0], -normal[1], -normal[2]];
    if (dot(aligned, up) < Math.cos(25 * Math.PI / 180)) break;
    up = aligned;
  }
  heights = heightsAlong(up); low = quantile(heights, 0.01); high = quantile(heights, 0.99);
  const step = (high - low) / 120, bins = new Float64Array(120);
  for (const h of heights) { const i = Math.floor((h - low) / step); if (i >= 0 && i < 120) bins[i]++; }
  const strongest = Math.max(...bins.slice(0, 40)), first = [...bins.slice(0, 40)].findIndex(count => count >= strongest * 0.4);
  const floorLevel = low + (first + 0.5) * step, floor = points.filter((_, i) => Math.abs(heights[i] - floorLevel) <= step * 1.2);
  if (floor.length < 200) return;
  const height = high - floorLevel;
  if (!(height > 0)) return;
  // File units are often metres already (phone scanners). If the ceiling then comes out absurd, a room is about 2.6 m high.
  const metresPerUnit = height >= 2 && height <= 4 ? 1 : 2.6 / height, scaleFrom = metresPerUnit === 1 ? "units" as const : "ceiling" as const;
  const reference: V = Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], forward = unit(cross(up, reference)), right = cross(forward, up);
  const flat = floor.map(p => [dot(p, right), dot(p, forward)] as [number, number]);
  const bounds = [0, 1].map(k => { const values = flat.map(p => p[k]); return [quantile(values, 0.02), quantile(values, 0.98)]; });
  const inner = flat.filter(p => p[0] >= bounds[0][0] && p[0] <= bounds[0][1] && p[1] >= bounds[1][0] && p[1] <= bounds[1][1]);
  let outline = hull(inner);
  if (outline.length < 3) return;
  if (outline.length > 48) outline = outline.filter((_, i) => i % Math.ceil(outline.length / 48) === 0);
  const lift = (x: number, z: number): V => [right[0] * x + forward[0] * z + up[0] * floorLevel, right[1] * x + forward[1] * z + up[1] * floorLevel, right[2] * x + forward[2] * z + up[2] * floorLevel];
  // Stand where there is floor underfoot and the most room around: the middle of a furnished room is usually a table.
  const cell = 0.1 / metresPerUnit, columns = (bounds[0][1] - bounds[0][0]) / cell, rows = (bounds[1][1] - bounds[1][0]) / cell;
  let spawn = lift((bounds[0][0] + bounds[0][1]) / 2, (bounds[1][0] + bounds[1][1]) / 2);
  if (columns >= 3 && rows >= 3 && columns * rows < 250000) {
    const w = Math.ceil(columns), h = Math.ceil(rows), index = (x: number, z: number) => { const i = Math.floor((x - bounds[0][0]) / cell), j = Math.floor((z - bounds[1][0]) / cell); return i >= 0 && i < w && j >= 0 && j < h ? j * w + i : -1; };
    const floored = new Uint8Array(w * h), blocked = new Uint16Array(w * h);
    for (const p of flat) { const k = index(p[0], p[1]); if (k >= 0) floored[k] = 1; }
    points.forEach((p, i) => { const above = (heights[i] - floorLevel) * metresPerUnit; if (above > 0.3 && above < 1.75) { const k = index(dot(p, right), dot(p, forward)); if (k >= 0) blocked[k]++; } });
    // Distance to the nearest furniture or unseen floor, by spreading outwards from them.
    const distance = new Float32Array(w * h).fill(Infinity), queue: number[] = [];
    for (let k = 0; k < w * h; k++) if (blocked[k] >= 2 || !floored[k]) { distance[k] = 0; queue.push(k); }
    for (let head = 0; head < queue.length; head++) {
      const k = queue[head], x = k % w, z = Math.floor(k / w);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, nz = z + dz; if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue; const next = nz * w + nx; if (distance[next] > distance[k] + 1) { distance[next] = distance[k] + 1; queue.push(next); } }
    }
    let best = -1;
    for (let k = 0; k < w * h; k++) if (Number.isFinite(distance[k]) && (best < 0 || distance[k] > distance[best])) best = k;
    if (best >= 0 && distance[best] > 0) spawn = lift(bounds[0][0] + (best % w + 0.5) * cell, bounds[1][0] + (Math.floor(best / w) + 0.5) * cell);
  }
  const span = Math.max(bounds[0][1] - bounds[0][0], bounds[1][1] - bounds[1][0]) * 0.25, centre: V = [dot(spawn, right), dot(spawn, forward), 0];
  return { up, height, metresPerUnit, scaleFrom, spawn: point(spawn), boundary: outline.map(([x, z]) => point(lift(x, z))),
    floorPoints: [point(spawn), point(lift(centre[0], centre[1] + span)), point(lift(centre[0] + span, centre[1]))] };
}

/**
 * Where a visitor cannot walk, as runs of blocked floor cells: `[x, z, cells]` in world metres, each cell `size` wide.
 * `world` holds splat centres already in the calibrated room frame (metres, Y up).
 */
export function obstacleRuns(world: Float32Array, floorY: number, size = 0.1, from = 0.3, to = 1.75): [number, number, number][] {
  const counts = new Map<number, number>(), key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
  for (let k = 0; k + 2 < world.length; k += 3) {
    const above = world[k + 1] - floorY;
    if (!(above > from && above < to)) continue;
    const i = Math.floor(world[k] / size), j = Math.floor(world[k + 2] / size);
    if (Math.abs(i) < 32768 && Math.abs(j) < 32768) counts.set(key(i, j), (counts.get(key(i, j)) ?? 0) + 1);
  }
  // A few stray splats in mid-air are not furniture; a real surface puts many centres into a 10 cm column.
  const filled = [...counts.values()].sort((a, b) => a - b), threshold = Math.max(3, Math.round((filled[Math.floor(filled.length / 2)] ?? 0) * 0.2));
  const cells = [...counts.entries()].filter(([, count]) => count >= threshold).map(([k]) => [Math.floor(k / 65536) - 32768, k % 65536 - 32768] as [number, number]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const runs: [number, number, number][] = [];
  for (const [i, j] of cells) {
    const last = runs[runs.length - 1];
    if (last && Math.abs(last[1] - j * size) < 1e-9 && Math.abs(last[0] + last[2] * size - i * size) < 1e-9) last[2]++;
    else runs.push([i * size, j * size, 1]);
  }
  return runs;
}
