import { FilesetResolver, ObjectDetector, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { DetectorInput, DetectorOutput, ImageDetection, PoseLandmark } from "./types";

const scope = self as unknown as { onmessage: ((event: MessageEvent<DetectorInput>) => void) | null; postMessage: (message: DetectorOutput) => void; close: () => void };
let pose: PoseLandmarker | undefined, persons: ObjectDetector | undefined, closeUp: ObjectDetector | undefined, input: OffscreenCanvas | undefined, context: OffscreenCanvasRenderingContext2D | null = null, disposed = false, initializing = false;
let crop: OffscreenCanvas | undefined, cropContext: OffscreenCanvasRenderingContext2D | null = null, scan = 0, idle = 0;
/** Where people were found lately (normalised image boxes): looked at again, enlarged, whenever the whole-frame pass misses them. */
let attention: (ImageDetection & { seen: number; misses?: number })[] = [];
const error = (reason: unknown) => scope.postMessage({ type: "error", message: reason instanceof Error ? reason.message : "Person detection could not process this camera." });
const release = () => {
  for (const model of [pose, persons, closeUp]) { try { model?.close(); } catch { /* Worker termination also releases a failed runtime. */ } }
  pose = undefined; persons = undefined; closeUp = undefined; input = undefined; context = null; crop = undefined; cropContext = null; attention = [];
};
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const centreInside = (a: ImageDetection, b: ImageDetection) => { const x = a.x + a.width / 2, y = a.y + a.height / 2; return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height; };
const samePerson = (a: ImageDetection, b: ImageDetection) => centreInside(a, b) || centreInside(b, a);
/**
 * The person model sees the whole frame squeezed into 320 x 320, where someone across the room is ~25 px wide and is found
 * in one frame and missed in the next. Looking again at a square part of the full-resolution frame makes them 2-4x larger.
 * Returns boxes in whole-frame coordinates; `cut` marks one that runs into the part's edge, so it shows only a piece of the person.
 */
const lookCloser = (bitmap: ImageBitmap, left: number, top: number, side: number, minimum: number): (ImageDetection & { cut: boolean })[] => {
  if (!closeUp || !crop || !cropContext) return [];
  cropContext.drawImage(bitmap, left, top, side, side, 0, 0, crop.width, crop.height);
  return closeUp.detect(crop).detections.flatMap(detection => {
    const category = detection.categories.find(value => value.categoryName === "person" && value.score >= minimum), box = detection.boundingBox;
    if (!category || !box || ![box.originX, box.originY, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return [];
    const scale = side / crop!.width, x0 = left + box.originX * scale, y0 = top + box.originY * scale, x1 = x0 + box.width * scale, y1 = y0 + box.height * scale, edge = side * 0.02;
    const cut = x0 - left < edge && left > 1 || y0 - top < edge && top > 1 || left + side - x1 < edge && left + side < bitmap.width - 1 || top + side - y1 < edge && top + side < bitmap.height - 1;
    // A part bigger than its share of a person box is a crop of furniture or a wall-sized false alarm, not a distant person.
    if (box.width * box.height > crop!.width * crop!.height * 0.7) return [];
    const x = clamp(x0 / bitmap.width), y = clamp(y0 / bitmap.height), right = clamp(x1 / bitmap.width), bottom = clamp(y1 / bitmap.height);
    return right > x && bottom > y ? [{ x, y, width: right - x, height: bottom - y, confidence: clamp(category.score), source: "object" as const, cut }] : [];
  });
};
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
        categoryAllowlist: ["person"], scoreThreshold: 0.4, maxResults: 5,
      });
      if (disposed) { loadedPersons.close(); return; }
      persons = loadedPersons;
      const closeLoader = new URL(String(files.wasmLoaderPath)); closeLoader.searchParams.set("task", "close-up");
      const loadedCloseUp = await ObjectDetector.createFromOptions({ ...files, wasmLoaderPath: closeLoader.href }, {
        baseOptions: { modelAssetPath: message.personModelPath, delegate: "CPU" }, canvas: new OffscreenCanvas(1, 1), runningMode: "IMAGE",
        categoryAllowlist: ["person"], scoreThreshold: 0.3, maxResults: 5,
      });
      if (disposed) { loadedCloseUp.close(); return; }
      closeUp = loadedCloseUp; crop = new OffscreenCanvas(384, 384); cropContext = crop.getContext("2d", { alpha: false });
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
      const category = detection.categories.find(value => value.categoryName === "person" && value.score >= 0.4), box = detection.boundingBox;
      if (!category || !box || ![box.originX, box.originY, box.width, box.height, category.score].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return [];
      const x = clamp(box.originX / width), y = clamp(box.originY / height), right = clamp((box.originX + box.width) / width), bottom = clamp((box.originY + box.height) / height);
      return right > x && bottom > y ? [{ x, y, width: right - x, height: bottom - y, confidence: clamp(category.score), source: "object" as const }] : [];
    }).slice(0, 5);
    let landmarks: PoseLandmark[][] = [], world: PoseLandmark[][] = [];
    // Boxes remain useful for cropped upper bodies. Feet come only from reliable
    // pose landmarks; a box bottom never becomes a fabricated floor contact.
    // Pose inference must not depend on EfficientDet recognizing the person.
    const result = pose.detectForVideo(input, message.inferenceTimestamp);
    try {
      landmarks = result.landmarks.map(person => person.map(landmark => ({ x: landmark.x, y: landmark.y, z: landmark.z, visibility: landmark.visibility, presence: (landmark as PoseLandmark).presence })));
      // Metric 3D body points (hip-centred, camera-aligned axes) for mirroring the person's pose on an avatar.
      world = result.worldLandmarks.map(person => person.map(landmark => ({ x: landmark.x, y: landmark.y, z: landmark.z, visibility: landmark.visibility })));
    }
    finally { result.close(); }
    // One extra look per frame. First at people seen in the last two seconds whom this frame's whole-image pass lost;
    // otherwise at the next of the square parts the frame is walked through in turn, to find someone small the first time.
    const posedNow = landmarks.flatMap(person => poseBox(person) ?? []), short = Math.min(bitmap.width, bitmap.height);
    attention = attention.filter(region => message.timestamp - region.seen <= 2500 && message.timestamp >= region.seen);
    const lost = attention.filter(region => ![...detections, ...posedNow].some(box => samePerson(box, region))).sort((a, b) => b.seen - a.seen)[0];
    if (lost) {
      // About twice the person's size: enough surroundings for the model, enough pixels for the person. A head above
      // furniture is a small box and needs the tight crop; at a third of the frame a 50 px head was found once in eight frames.
      // The same crop of a still scene misses the same way every time, so each miss tries another framing.
      const misses = lost.misses ?? 0, zoom = [1, 1.4, 0.75, 1.8][misses % 4];
      const side = Math.min(short, Math.max(short / 7, Math.max(lost.width * bitmap.width * 2.4, lost.height * bitmap.height * 2) * zoom));
      const left = Math.min(bitmap.width - side, Math.max(0, (lost.x + lost.width / 2) * bitmap.width - side / 2)), top = Math.min(bitmap.height - side, Math.max(0, (lost.y + lost.height / 2) * bitmap.height - side / 2));
      const again = lookCloser(bitmap, left, top, side, 0.3).filter(box => samePerson(box, lost)).sort((a, b) => b.confidence - a.confidence)[0];
      if (again) { const { cut: _cut, ...box } = again; detections.push(box); }
      else lost.misses = misses + 1;
    } else if (short > 0 && (attention.length === 0 || idle++ % 4 === 0)) {
      // Two walks side by side, one square of each per frame: large squares (the frame's full height, then 0.6 of it) for
      // people at the far end of the room, about a dozen frames a round; small ones for heads showing above furniture,
      // about thirty. Whoever they find is then followed by the look above.
      const squares = (sides: number[]) => sides.flatMap(side => {
        const across = Math.ceil((bitmap.width - side) / (side * 0.7)) + 1, down = Math.ceil((bitmap.height - side) / (side * 0.7)) + 1;
        return Array.from({ length: across * down }, (_, i): [number, number, number] => [across > 1 ? (bitmap.width - side) * (i % across) / (across - 1) : 0, down > 1 ? (bitmap.height - side) * Math.floor(i / across) / (down - 1) : 0, side]);
      });
      // Each look costs as much as the whole-frame pass: with two per frame the camera fell from six frames a second to
      // two and the room lagged a second behind. One per frame while nobody is followed, one in four frames otherwise.
      const large = squares([short, short * 0.6]), small = squares([short * 0.35]), turn = scan++;
      for (const [left, top, side] of [turn % 2 ? small[(turn >> 1) % small.length] : large[(turn >> 1) % large.length]]) for (const { cut, ...box } of lookCloser(bitmap, left, top, side, 0.4)) {
        if ([...detections, ...posedNow].some(other => samePerson(box, other))) continue;
        // A piece of a person is not reported, only remembered: the next frame looks at that spot with the person centred.
        if (!cut) detections.push(box);
        else if (attention.length < 5 && !attention.some(region => samePerson(box, region))) attention.push({ ...box, seen: message.timestamp });
      }
    }
    for (const box of [...detections, ...posedNow]) {
      const known = attention.find(region => samePerson(box, region));
      // Follow the centre at once but the size slowly: a wider second look returns a looser box, and cropping by that one
      // next time would drift ever wider.
      if (known) {
        const width = known.width + 0.3 * (box.width - known.width), height = known.height + 0.3 * (box.height - known.height);
        Object.assign(known, { x: box.x + box.width / 2 - width / 2, y: box.y + box.height / 2 - height / 2, width, height, seen: message.timestamp, misses: 0 });
      }
      else if (attention.length < 5) attention.push({ ...box, seen: message.timestamp });
    }
    // A head above furniture scores lower than a whole person, so weaker boxes are kept for positioning.
    if (!detections.some(box => box.confidence >= 0.5)) {
      // Suppress weak/degenerate pose-only observations rather than counting them
      // as people. Reliable cropped faces/torso poses remain usable without a box.
      const posed: ImageDetection[] = [];
      const kept = landmarks.map((person, index) => ({ person, index })).filter(({ person }) => {
        const box = poseBox(person);
        if (!box) return false;
        posed.push(box); return true;
      }).slice(0, 5);
      landmarks = kept.map(item => item.person); world = kept.map(item => world[item.index] ?? []);
      // A weak box around someone the pose model already found is the same person, not a second one.
      const inside = (box: ImageDetection, other: ImageDetection) => { const x = other.x + other.width / 2, y = other.y + other.height / 2; return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height; };
      const unposed = detections.filter(box => !posed.some(other => inside(box, other) || inside(other, box)));
      detections.splice(0, detections.length, ...posed, ...unposed);
    }
    scope.postMessage({ type: "result", id: message.id, timestamp: message.timestamp, landmarks, worldLandmarks: world, detections: detections.slice(0, 5), inferenceMs: Math.max(0, performance.now() - started) });
  } catch (reason) { error(reason); }
  finally { bitmap.close(); }
};
