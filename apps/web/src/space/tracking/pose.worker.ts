import { FilesetResolver, ObjectDetector, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { DetectorInput, DetectorOutput, ImageDetection, PoseLandmark } from "./types";

const scope = self as unknown as { onmessage: ((event: MessageEvent<DetectorInput>) => void) | null; postMessage: (message: DetectorOutput) => void; close: () => void };
let pose: PoseLandmarker | undefined, persons: ObjectDetector | undefined, input: OffscreenCanvas | undefined, context: OffscreenCanvasRenderingContext2D | null = null, disposed = false, initializing = false;
const error = (reason: unknown) => scope.postMessage({ type: "error", message: reason instanceof Error ? reason.message : "Person detection could not process this camera." });
const release = () => {
  for (const model of [pose, persons]) { try { model?.close(); } catch { /* Worker termination also releases a failed runtime. */ } }
  pose = undefined; persons = undefined; input = undefined; context = null;
};
const clamp = (value: number) => Math.min(1, Math.max(0, value));
// This is only an image overlay. Floor/estimated room positions still require
// independently validated landmarks and the saved camera geometry downstream.
const poseBox = (landmarks: PoseLandmark[]): ImageDetection | undefined => {
  const reliable = (index: number) => {
    const p = landmarks[index];
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 &&
      Number.isFinite(p.visibility) && (p.visibility ?? 0) >= 0.65 && (p.presence === undefined || Number.isFinite(p.presence) && p.presence >= 0.65);
  };
  const supportedPair = (a: number, b: number, minimum: number) => reliable(a) && reliable(b) && Math.hypot(landmarks[a].x - landmarks[b].x, landmarks[a].y - landmarks[b].y) >= minimum;
  let support: number[] | undefined;
  if (supportedPair(11, 12, 0.02) && (reliable(0) || supportedPair(23, 24, 0.02))) support = reliable(0) ? [0, 11, 12] : [11, 12, 23, 24];
  else if (reliable(0) && supportedPair(2, 5, 0.008)) support = [0, 2, 5];
  else if (reliable(0) && supportedPair(7, 8, 0.015)) support = [0, 7, 8];
  else if (supportedPair(23, 24, 0.02) && supportedPair(25, 26, 0.02)) support = [23, 24, 25, 26];
  else if (supportedPair(29, 31, 0.004)) support = [29, 31];
  else if (supportedPair(30, 32, 0.004)) support = [30, 32];
  if (!support) return;
  const visible = landmarks.filter((_, index) => reliable(index));
  const left = clamp(Math.min(...visible.map(p => p.x)) - 0.02), top = clamp(Math.min(...visible.map(p => p.y)) - 0.02);
  const right = clamp(Math.max(...visible.map(p => p.x)) + 0.02), bottom = clamp(Math.max(...visible.map(p => p.y)) + 0.02);
  if (right - left < 0.025 || bottom - top < 0.035) return;
  const confidence = clamp(Math.min(...support.map(index => Math.min(landmarks[index].visibility ?? 0, landmarks[index].presence ?? 1))));
  return { x: left, y: top, width: right - left, height: bottom - top, confidence, source: "pose" };
};
scope.onmessage = async event => {
  const message = event.data;
  if (message.type === "stop") {
    disposed = true; release();
    scope.postMessage({ type: "closed" }); scope.close(); return;
  }
  if (message.type === "init") {
    if (initializing || disposed) return;
    initializing = true;
    try {
      const files = await FilesetResolver.forVisionTasks(message.wasmRoot, true);
      if (disposed) return;
      const loadedPersons = await ObjectDetector.createFromOptions(files, {
        baseOptions: { modelAssetPath: message.personModelPath, delegate: "CPU" }, canvas: new OffscreenCanvas(1, 1), runningMode: "VIDEO",
        categoryAllowlist: ["person"], scoreThreshold: 0.5, maxResults: 5,
      });
      if (disposed) { loadedPersons.close(); return; }
      persons = loadedPersons;
      // Tasks Vision clears the loader's global factory after creating a task.
      // Give the second ESM import its own identity so it runs again; both tasks
      // still share the resolver's self-hosted WASM binary and asset paths.
      const poseLoader = new URL(String(files.wasmLoaderPath)); poseLoader.searchParams.set("task", "pose");
      const loaded = await PoseLandmarker.createFromOptions({ ...files, wasmLoaderPath: poseLoader.href }, {
        baseOptions: { modelAssetPath: message.modelPath, delegate: "CPU" }, canvas: new OffscreenCanvas(1, 1), runningMode: "VIDEO",
        numPoses: 5, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5, outputSegmentationMasks: false,
      });
      if (disposed) { loaded.close(); return; }
      pose = loaded; input = new OffscreenCanvas(1, 1); context = input.getContext("2d", { alpha: false });
      if (!context) throw Error("This browser cannot create the camera-processing canvas.");
      scope.postMessage({ type: "ready" });
    } catch (reason) { release(); if (!disposed) error(reason); }
    return;
  }
  const bitmap = message.bitmap;
  const started = performance.now();
  try {
    if (disposed || !persons || !pose || !input || !context) return;
    const factor = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * factor)), height = Math.max(1, Math.round(bitmap.height * factor));
    if (input.width !== width || input.height !== height) { input.width = width; input.height = height; }
    context.drawImage(bitmap, 0, 0, width, height);
    const found = persons.detectForVideo(input, message.inferenceTimestamp);
    const detections: ImageDetection[] = found.detections.flatMap(detection => {
      const category = detection.categories.find(value => value.categoryName === "person" && value.score >= 0.5), box = detection.boundingBox;
      if (!category || !box || ![box.originX, box.originY, box.width, box.height, category.score].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return [];
      const x = clamp(box.originX / width), y = clamp(box.originY / height), right = clamp((box.originX + box.width) / width), bottom = clamp((box.originY + box.height) / height);
      return right > x && bottom > y ? [{ x, y, width: right - x, height: bottom - y, confidence: clamp(category.score), source: "object" as const }] : [];
    }).slice(0, 5);
    let landmarks: PoseLandmark[][] = [];
    // Boxes remain useful for cropped upper bodies. Feet come only from reliable
    // pose landmarks; a box bottom never becomes a fabricated floor contact.
    // Pose inference must not depend on EfficientDet recognizing the person.
    const result = pose.detectForVideo(input, message.inferenceTimestamp);
    try { landmarks = result.landmarks.map(person => person.map(landmark => ({ x: landmark.x, y: landmark.y, z: landmark.z, visibility: landmark.visibility, presence: (landmark as PoseLandmark).presence }))); }
    finally { result.close(); }
    if (!detections.length) {
      // Suppress weak/degenerate pose-only observations rather than counting them
      // as people. Reliable cropped faces/torso poses remain usable without a box.
      landmarks = landmarks.filter(person => {
        const box = poseBox(person);
        if (!box) return false;
        detections.push(box); return true;
      }).slice(0, 5);
    }
    scope.postMessage({ type: "result", id: message.id, timestamp: message.timestamp, landmarks, detections: detections.slice(0, 5), inferenceMs: Math.max(0, performance.now() - started) });
  } catch (reason) { error(reason); }
  finally { bitmap.close(); }
};
