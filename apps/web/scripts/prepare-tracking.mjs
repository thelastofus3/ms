import { mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const output = fileURLToPath(new URL("../public/tracking/", import.meta.url));
const wasm = fileURLToPath(new URL("../node_modules/@mediapipe/tasks-vision/wasm/", import.meta.url));
const models = [
  {
    name: "Pose Landmarker Lite v1", file: "pose_landmarker_lite.task",
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    sha256: "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a",
  },
  {
    name: "EfficientDet Lite0 int8 v1", file: "efficientdet_lite0.tflite",
    url: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite",
    sha256: "0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb",
  },
];
const digest = data => createHash("sha256").update(data).digest("hex");
await mkdir(output, { recursive: true });
await cp(wasm, `${output}wasm`, { recursive: true });
for (const specification of models) {
  const modelPath = `${output}${specification.file}`;
  let model;
  try { model = await readFile(modelPath); } catch { /* The first build downloads the pinned models. */ }
  if (!model || digest(model) !== specification.sha256) {
    const response = await fetch(specification.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`${specification.name} download failed (${response.status})`);
    model = Buffer.from(await response.arrayBuffer());
    if (digest(model) !== specification.sha256) throw new Error(`${specification.name} checksum does not match the pinned model`);
    await writeFile(modelPath, model);
  }
  console.log(`Tracking assets ready: ${specification.name}, ${model.byteLength} bytes, SHA-256 ${digest(model)}`);
}
