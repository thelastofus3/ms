import * as faceapi from "@vladmandic/face-api/dist/face-api.esm.js";

export type FaceInput = { type: "init"; modelRoot: string } | { type: "describe"; id: number; bitmap: ImageBitmap };
export type FaceBox = { x: number; y: number; width: number; height: number };
export type FaceOutput =
  | { type: "ready"; backend: string }
  | { type: "faces"; id: number; faces: { descriptor: Float32Array; score: number; box: FaceBox }[] }
  | { type: "error"; id?: number; message: string };

const scope = self as unknown as { onmessage: ((event: MessageEvent<FaceInput>) => void) | null; postMessage: (message: FaceOutput, transfer?: Transferable[]) => void };
let ready = false;
const message = (reason: unknown) => reason instanceof Error ? reason.message : "Face recognition could not process this image.";
scope.onmessage = async event => {
  const input = event.data;
  if (input.type === "init") {
    try {
      // The library only detects browser pages and Node; a worker has to describe itself. Tensors are passed in, so no DOM is needed.
      class Unavailable {}
      faceapi.env.setEnv({
        Canvas: OffscreenCanvas, CanvasRenderingContext2D: OffscreenCanvasRenderingContext2D, Image: Unavailable, ImageData, Video: Unavailable,
        createCanvasElement: () => new OffscreenCanvas(1, 1), createImageElement: () => { throw Error("Images are not available in a worker."); }, createVideoElement: () => { throw Error("Video is not available in a worker."); },
        fetch: (url: RequestInfo | URL, init?: RequestInit) => fetch(url, init), readFile: () => { throw Error("Files are not available in a worker."); },
      } as unknown as Parameters<typeof faceapi.env.setEnv>[0]);
      const tf = faceapi.tf as unknown as { setBackend: (name: string) => Promise<boolean>; ready: () => Promise<void>; getBackend: () => string };
      if (!await tf.setBackend("webgl").catch(() => false)) await tf.setBackend("cpu");
      await tf.ready();
      await Promise.all([faceapi.nets.ssdMobilenetv1.loadFromUri(input.modelRoot), faceapi.nets.faceLandmark68Net.loadFromUri(input.modelRoot), faceapi.nets.faceRecognitionNet.loadFromUri(input.modelRoot)]);
      ready = true; scope.postMessage({ type: "ready", backend: tf.getBackend() });
    } catch (reason) { scope.postMessage({ type: "error", message: message(reason) }); }
    return;
  }
  const { id, bitmap } = input;
  try {
    if (!ready) throw Error("Face recognition is not ready.");
    const pixels = faceapi.tf.browser.fromPixels(bitmap as unknown as ImageData);
    try {
      const found = await faceapi.detectAllFaces(pixels, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.35, maxResults: 6 })).withFaceLandmarks().withFaceDescriptors();
      const faces = found.map(face => ({ descriptor: new Float32Array(face.descriptor), score: face.detection.score, box: { x: face.detection.box.x, y: face.detection.box.y, width: face.detection.box.width, height: face.detection.box.height } }));
      scope.postMessage({ type: "faces", id, faces }, faces.map(face => face.descriptor.buffer));
    } finally { pixels.dispose(); }
  } catch (reason) { scope.postMessage({ type: "error", id, message: message(reason) }); }
  finally { bitmap.close(); }
};
