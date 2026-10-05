import type { Correspondence, ImagePoint, WorldFloorPoint } from "./types";

const finite = (p: { x: number; y: number }) => Number.isFinite(p.x) && Number.isFinite(p.y);
type XY = { x: number; y: number };
function multiply(a: number[], b: number[]) {
  return Array.from({ length: 9 }, (_, i) => {
    const row = Math.floor(i / 3), col = i % 3;
    return a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
  });
}
function normalize(points: XY[]) {
  const center = points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length }), { x: 0, y: 0 });
  let xx = 0, yy = 0, xy = 0, meanDistance = 0;
  for (const p of points) {
    const x = p.x - center.x, y = p.y - center.y;
    xx += x * x; yy += y * y; xy += x * y; meanDistance += Math.hypot(x, y);
  }
  const trace = xx + yy, discriminant = Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy * xy));
  const largest = (trace + discriminant) / 2, smallest = (trace - discriminant) / 2;
  if (!Number.isFinite(largest) || largest < 1e-10 || smallest < largest * 1e-4) throw Error("The floor matches are collinear or too narrow. Use a wide triangle or rectangle.");
  const scale = Math.SQRT2 / (meanDistance / points.length);
  return { points: points.map(p => ({ x: (p.x - center.x) * scale, y: (p.y - center.y) * scale })),
    matrix: [scale, 0, -center.x * scale, 0, scale, -center.y * scale, 0, 0, 1],
    inverse: [1 / scale, 0, center.x, 0, 1 / scale, center.y, 0, 0, 1] };
}
function hullArea(points: XY[]) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: XY, a: XY, b: XY) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (items: XY[]) => {
    const out: XY[] = [];
    for (const p of items) { while (out.length > 1 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop(); out.push(p); }
    return out.slice(0, -1);
  };
  const hull = [...half(sorted), ...half(sorted.reverse())];
  return Math.abs(hull.reduce((sum, p, i) => sum + p.x * hull[(i + 1) % hull.length].y - p.y * hull[(i + 1) % hull.length].x, 0)) / 2;
}
// Re-orthogonalized QR avoids squaring the condition number through AᵀA.
function leastSquares(rows: number[][], values: number[]) {
  const count = 8, q: number[][] = [], r = Array.from({ length: count }, () => Array(count).fill(0) as number[]);
  for (let column = 0; column < count; column++) {
    const v = rows.map(row => row[column]);
    for (let pass = 0; pass < 2; pass++) for (let j = 0; j < column; j++) {
      const projection = v.reduce((sum, value, i) => sum + value * q[j][i], 0);
      r[j][column] += projection;
      for (let i = 0; i < v.length; i++) v[i] -= projection * q[j][i];
    }
    const length = Math.hypot(...v);
    if (!Number.isFinite(length) || length < 1e-8) throw Error("Reference points form an unstable mapping. Spread them farther apart.");
    r[column][column] = length;
    q.push(v.map(value => value / length));
  }
  const result = Array(count).fill(0) as number[];
  for (let j = count - 1; j >= 0; j--) {
    const rhs = q[j].reduce((sum, value, i) => sum + value * values[i], 0);
    result[j] = (rhs - r[j].reduce((sum, value, i) => sum + (i > j ? value * result[i] : 0), 0)) / r[j][j];
  }
  return result;
}
export function projectImageToFloor(h: number[], image: ImagePoint): WorldFloorPoint | undefined {
  if (h.length !== 9 || !h.every(Number.isFinite) || !finite(image)) return;
  const denominator = h[6] * image.x + h[7] * image.y + h[8];
  const magnitude = Math.abs(h[6] * image.x) + Math.abs(h[7] * image.y) + Math.abs(h[8]);
  if (Math.abs(denominator) <= Math.max(1e-12, magnitude * 1e-5)) return;
  const x = (h[0] * image.x + h[1] * image.y + h[2]) / denominator;
  const z = (h[3] * image.x + h[4] * image.y + h[5]) / denominator;
  return Number.isFinite(x) && Number.isFinite(z) && Math.abs(x) <= 10000 && Math.abs(z) <= 10000 ? { x, z } : undefined;
}
export function fitHomography(points: Correspondence[]): { homography: number[]; fitErrorMeters: number } {
  if (points.length < 4 || points.length > 20) throw Error("Match 4 to 20 floor reference points in both views.");
  const images = points.map(p => p.image), worlds = points.map(p => ({ x: p.world.x, y: p.world.z }));
  if (images.some(p => !finite(p) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) || worlds.some(p => !finite(p) || Math.abs(p.x) > 10000 || Math.abs(p.y) > 10000)) throw Error("Reference coordinates are outside the image or room.");
  if (hullArea(images) < 0.002 || hullArea(worlds) < 0.04) throw Error("Spread references across a larger floor area; avoid points along one line.");
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    if (Math.hypot(images[i].x - images[j].x, images[i].y - images[j].y) < 0.003 || Math.hypot(worlds[i].x - worlds[j].x, worlds[i].y - worlds[j].y) < 0.02) throw Error("Use separate, clearly identifiable floor references.");
  }
  const source = normalize(images), target = normalize(worlds), rows: number[][] = [], values: number[] = [];
  source.points.forEach((p, i) => {
    const w = target.points[i];
    rows.push([p.x, p.y, 1, 0, 0, 0, -w.x * p.x, -w.x * p.y], [0, 0, 0, p.x, p.y, 1, -w.y * p.x, -w.y * p.y]);
    values.push(w.x, w.y);
  });
  const normalized = [...leastSquares(rows, values), 1];
  const normalizedDeterminant = normalized[0] * (normalized[4] * normalized[8] - normalized[5] * normalized[7]) - normalized[1] * (normalized[3] * normalized[8] - normalized[5] * normalized[6]) + normalized[2] * (normalized[3] * normalized[7] - normalized[4] * normalized[6]);
  if (!Number.isFinite(normalizedDeterminant) || Math.abs(normalizedDeterminant) < 1e-6) throw Error("The calibration is unstable. Spread matches across the visible floor.");
  let homography = multiply(target.inverse, multiply(normalized, source.matrix));
  const gauge = Math.abs(homography[8]) > 1e-10 ? homography[8] : Math.max(...homography.map(Math.abs));
  homography = homography.map(value => value / gauge);
  const h = homography, determinant = h[0] * (h[4] * h[8] - h[5] * h[7]) - h[1] * (h[3] * h[8] - h[5] * h[6]) + h[2] * (h[3] * h[7] - h[4] * h[6]);
  if (!homography.every(Number.isFinite) || Math.abs(determinant) < 1e-10) throw Error("The reference mapping is degenerate. Choose different floor points.");
  const denominators = images.map(p => h[6] * p.x + h[7] * p.y + h[8]);
  if (denominators.some(value => !Number.isFinite(value) || Math.abs(value) < 1e-6 || Math.sign(value) !== Math.sign(denominators[0]))) throw Error("The references cross an unstable perspective boundary. Choose visible floor points.");
  let squaredError = 0;
  for (const reference of points) {
    const mapped = projectImageToFloor(homography, reference.image);
    if (!mapped) throw Error("The reference mapping is unstable near the camera horizon.");
    squaredError += (mapped.x - reference.world.x) ** 2 + (mapped.z - reference.world.z) ** 2;
  }
  const fitErrorMeters = Math.sqrt(squaredError / points.length);
  if (!Number.isFinite(fitErrorMeters) || fitErrorMeters > 0.2) throw Error("Reference pairs disagree by more than 20 cm. Correct the matches before tracking.");
  return { homography, fitErrorMeters };
}
export function insideBoundary(p: WorldFloorPoint, boundary: [number, number][]): boolean {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || boundary.length < 3 || boundary.some(q => !q.every(Number.isFinite))) return false;
  let inside = false;
  for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
    const [ax, az] = boundary[i], [bx, bz] = boundary[j];
    const length = Math.hypot(bx - ax, bz - az), cross = (p.x - ax) * (bz - az) - (p.z - az) * (bx - ax);
    if (length > 0 && Math.abs(cross) <= length * 1e-7 && p.x >= Math.min(ax, bx) - 1e-7 && p.x <= Math.max(ax, bx) + 1e-7 && p.z >= Math.min(az, bz) - 1e-7 && p.z <= Math.max(az, bz) + 1e-7) return true;
    if ((az > p.z) !== (bz > p.z) && p.x < (bx - ax) * (p.z - az) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}
