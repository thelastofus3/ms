export type Point = { x: number; y: number; z: number };
export type Asset = { path: string; url: string; sha256: string; bytes: number };
export type Navigation = {
  floorY: number; boundary: [number, number][]; spawn: [number, number, number]; yaw: number;
  eyeHeight: number; speed: number; capsuleRadius: number; capsuleHeight: number;
  obstacles: { center: [number, number, number]; size: [number, number, number] }[];
};
export type RoomManifest = {
  schemaVersion: 1; sceneId: string; version: number; ready: boolean;
  units: "meters" | "uncalibrated"; axes: "right-handed-y-up";
  assets: { splats: Asset; collision: Asset; source?: Asset; report?: Asset };
  worldFromReconstruction: number[]; previewCamera: number[];
  collisionReviewed: boolean; navigation?: Navigation;
  calibration?: Calibration;
  floorProposal?: { floorPoints?: Point[]; boundary?: Point[]; spawn?: Point; requiresReview?: boolean } | null;
};
export type Job = {
  id: string; name: string; state: string; stage: string; progress: number;
  profile: string; error: string | null; cancel_requested: boolean;
  manifestUrl?: string; version?: number; diagnostics: Record<string, unknown>;
};
export type LiveProgress = {
  stage: string; label: string; activity: string; percent: number | null;
  completed?: number; total?: number; unit?: string;
  elapsedSeconds: number; quietSeconds: number; observedAt: string;
};
export type Calibration = {
  measurement: Point[]; meters: number; floor: Point[]; boundary: Point[];
  spawn: Point | null; flipUp: boolean; reviewed: boolean; obstacles: { a: Point; b: Point }[];
  dimensions?: Dimension[];
};
export type Dimension = { id: string; name: string; a: Point; b: Point };
export type CalibrationTool = "floor" | "floor-height" | "measurement" | "boundary" | "spawn" | "dimension" | "obstacle" | "review";
const numeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function vector(value: unknown, size: number): value is number[] {
  return Array.isArray(value) && value.length === size && value.every(numeric);
}
export function parseManifest(value: unknown): RoomManifest {
  if (!value || typeof value !== "object") throw Error("Invalid room package");
  const m = value as RoomManifest;
  if (m.schemaVersion !== 1 || m.axes !== "right-handed-y-up" || !["meters", "uncalibrated"].includes(m.units) || !vector(m.worldFromReconstruction, 16) || !vector(m.previewCamera, 16)) throw Error("Unsupported room coordinates or package version");
  for (const name of ["splats", "collision"] as const) {
    const a = m.assets?.[name];
    if (!a || !/^[a-f0-9]{64}$/.test(a.sha256) || !numeric(a.bytes) || a.bytes < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a.path)) throw Error("Invalid room asset");
    const url = new URL(a.url, location.href);
    if (!["https:", "http:"].includes(url.protocol)) throw Error("Invalid asset URL");
  }
  const t = m.worldFromReconstruction;
  const lengths = [0, 4, 8].map(i => Math.hypot(t[i], t[i + 1], t[i + 2]));
  if (lengths[0] <= 0 || lengths.some(v => Math.abs(v / lengths[0] - 1) > 1e-5) || t[3] !== 0 || t[7] !== 0 || t[11] !== 0 || t[15] !== 1) throw Error("Room transform must have uniform scale");
  if (m.ready) {
    const n = m.navigation;
    if (m.units !== "meters" || !m.collisionReviewed || !n || !vector(n.spawn, 3) || !numeric(n.yaw) || !numeric(n.floorY) || !Array.isArray(n.boundary) || n.boundary.length < 3 || !n.boundary.every(p => vector(p, 2)) || !Array.isArray(n.obstacles)) throw Error("Room needs metric calibration and collision review before walking");
    if (!numeric(n.speed) || n.speed <= 0 || n.speed > 5 || !numeric(n.eyeHeight) || n.eyeHeight < 0.5 || n.eyeHeight > 2.5 || !numeric(n.capsuleRadius) || n.capsuleRadius <= 0 || !numeric(n.capsuleHeight) || n.capsuleHeight <= n.capsuleRadius * 2) throw Error("Invalid walking settings");
    if (n.obstacles.some(box => !vector(box.center, 3) || !vector(box.size, 3) || box.size.some(v => v <= 0))) throw Error("Invalid collision obstacle");
  }
  return m;
}
