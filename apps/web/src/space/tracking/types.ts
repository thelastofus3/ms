import type { Point } from "../types";

export type ImagePoint = { x: number; y: number };
export type WorldFloorPoint = { x: number; z: number };
export type Correspondence = { image: ImagePoint; world: WorldFloorPoint };
export type CameraGeometry = {
  center: Point;
  /** Row-major rotation: OpenCV camera right/down/forward to the metric Y-up room. */
  worldFromCamera: number[];
  intrinsics: { fx: number; fy: number; cx: number; cy: number; k1: number; k2: number };
  source: "sfm"; inliers: number; reprojectionErrorPx: number;
};
export type CameraCalibration = {
  id: string; name: string; sceneVersion: number; revision: string;
  imageWidth: number; imageHeight: number; points: Correspondence[];
  homography: number[]; updatedAt: string; fitErrorMeters: number;
  geometry?: CameraGeometry | null;
};
export type PoseLandmark = { x: number; y: number; z?: number; visibility?: number; presence?: number };
export type ImageDetection = { x: number; y: number; width: number; height: number; confidence: number; source?: "object" | "pose" };
export type DetectorHealth = {
  status: "fresh" | "stale";
  /** Monotonic latency from source-frame capture until its result is received. */
  inferenceMs: number;
  /** The greater of capture wall-clock age and monotonic result latency. */
  frameAgeMs: number;
  capturedAt: number; completedAt: number;
  consecutiveStaleFrames: number; recovered: boolean;
  workerInferenceMs?: number;
};
export type PositionQuality = { positionMethod?: "floor" | "estimated"; uncertaintyMeters?: number };
export type TrackedPerson = PositionQuality & { id: string; position: Point; confidence: number;
  /** The avatar of the person this track was recognised as, by face. */
  avatarId?: string;
  /** Where the object detector boxed this person when no pose was available (normalised image coordinates). */
  imageBox?: ImageDetection;
  /** Index of the detected pose this track was updated from in the current frame (absent for held tracks). */
  poseIndex?: number;
  /** Top of the head above the floor, when the true distance is known for a person seen only as a box: below about 1.4 m they are not standing. */
  crownHeight?: number;
  /** For a boxed person: how far the line of sight to the top of their head drops per metre of floor distance. */
  crownSlope?: number };
export type TrackingSnapshot = {
  sceneVersion: number; serverTime: number;
  cameras: { cameraId: string; name: string; calibrationRevision: string; streamId: string; ageMs: number; people: TrackedPerson[] }[];
};
/** A person's body in room axes (metres, hip-centred) with per-point visibility, for mirroring onto an avatar. */
export type BodyPose = { points: [number, number, number][]; visibility: number[];
  /** Hips above the floor in metres, when the camera could measure it: places a seated or crouching avatar at the right height. */
  hipHeight?: number };
export type WorldPerson = PositionQuality & { id: string; label: string; position: Point; confidence: number; expiresAt: number; body?: BodyPose;
  /** How many cameras this marker combines. */
  cameras?: number;
  /** Top of the head above the floor for a person whose body could not be read; see `TrackedPerson.crownHeight`. */
  crownHeight?: number;
  /** The recognised person's own avatar; absent for people nobody recognised. */
  avatarId?: string };
export type LiveCameraState = {
  jobId: string; name: string; cameraRunning: boolean;
  detectionState: "idle" | "loading" | "running" | "paused" | "failed";
  tracking: boolean; starting: boolean; detectedCount: number; positionedCount: number;
  feetVisible: boolean; calibrationUsable: boolean; fixedConfirmed: boolean;
  lastDetectionAt: number; error: string;
  positionMessage?: string; estimatedCount?: number;
  detectionHealth?: DetectorHealth;
};
export type CameraCaptureControl = { stopCamera: () => void };
export type DetectorInput =
  | { type: "init"; wasmRoot: string; modelPath: string; personModelPath: string }
  | { type: "frame"; id: number; bitmap: ImageBitmap; timestamp: number; inferenceTimestamp: number }
  | { type: "stop" };
export type DetectorOutput =
  | { type: "ready" }
  | { type: "result"; id: number; timestamp: number; landmarks: PoseLandmark[][]; worldLandmarks?: PoseLandmark[][]; detections: ImageDetection[]; inferenceMs?: number }
  | { type: "error"; message: string }
  | { type: "closed" };
