import type { DetectorHealth, DetectorInput, DetectorOutput, ImageDetection, PoseLandmark } from "./types";

export class CameraDetector {
  private worker: Worker | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frameTimer: ReturnType<typeof setTimeout> | undefined;
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  private rejectStart: ((reason: Error) => void) | undefined;
  private inFlight = false;
  private sequence = 0;
  async start(video: HTMLVideoElement, onResult: (landmarks: PoseLandmark[][], timestamp: number, detections?: ImageDetection[]) => void, onError: (message: string) => void, onHealth?: (health: DetectorHealth) => void): Promise<void> {
    this.stop();
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") throw Error("Use a current browser with worker camera processing and OffscreenCanvas support.");
    const generation = this.generation, worker = new Worker(new URL("./pose.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    let ready = false, lastVideoTime = -1, inferenceTimestamp = 0, width = 0, height = 0;
    let captureStarted = 0, captureTimestamp = 0, consecutiveStaleFrames = 0;
    const waitingSince = performance.now();
    const active = () => this.generation === generation && this.worker === worker;
    const fail = (message: string) => {
      if (!active()) return;
      const reject = this.rejectStart; this.rejectStart = undefined;
      reject?.(new Error(message));
      try { onError(message); } finally { this.stop(); }
    };
    const schedule = (delay: number) => { if (active()) this.timer = setTimeout(() => void capture(), delay); };
    const capture = async () => {
      if (!active() || !ready || this.inFlight) return;
      const started = performance.now();
      if (video.ended || !video.srcObject && !video.currentSrc) { fail("The camera stream has ended. Start the camera again."); return; }
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight || video.paused || video.currentTime === lastVideoTime) {
        if (!width && started - waitingSince > 15000) { fail("The camera did not provide frames. Check its permission and try again."); return; }
        schedule(125); return;
      }
      if (width && (width !== video.videoWidth || height !== video.videoHeight)) { fail("Camera resolution changed. Stop tracking and recalibrate this source."); return; }
      width = video.videoWidth; height = video.videoHeight; lastVideoTime = video.currentTime;
      const timestamp = Date.now(), id = ++this.sequence;
      captureStarted = started; captureTimestamp = timestamp;
      this.inFlight = true;
      this.frameTimer = setTimeout(() => fail("Camera detection timed out. Stop other heavy tasks and try again."), 10000);
      let bitmap: ImageBitmap | undefined;
      try {
        bitmap = await createImageBitmap(video);
        if (!active()) { bitmap.close(); return; }
        inferenceTimestamp = Math.max(performance.now(), inferenceTimestamp + 1);
        const frame: DetectorInput = { type: "frame", id, bitmap, timestamp, inferenceTimestamp };
        worker.postMessage(frame, [bitmap]);
        bitmap = undefined;
      } catch (reason) { bitmap?.close(); fail(reason instanceof Error ? `Unable to read camera frame: ${reason.message}` : "Unable to read this camera frame."); }
    };
    await new Promise<void>((resolve, reject) => {
      this.rejectStart = reject;
      this.initTimer = setTimeout(() => fail("Person detection could not initialize within 45 seconds. Reload and try again."), 45000);
      worker.onerror = event => { event.preventDefault(); fail("The camera detector could not start. Check browser support and model assets."); };
      worker.onmessageerror = () => fail("The camera detector returned an unreadable frame.");
      worker.onmessage = (event: MessageEvent<DetectorOutput>) => {
        if (!active()) return;
        const message = event.data;
        if (message.type === "error") { fail(`Person detector: ${message.message}`); return; }
        if (message.type === "ready") {
          ready = true; clearTimeout(this.initTimer); this.initTimer = undefined; this.rejectStart = undefined; resolve(); schedule(0); return;
        }
        if (message.type !== "result" || message.id !== this.sequence || !this.inFlight) return;
        clearTimeout(this.frameTimer); this.frameTimer = undefined; this.inFlight = false;
        const completedAt = Date.now(), inferenceMs = Math.max(0, performance.now() - captureStarted);
        const frameAgeMs = Math.max(0, completedAt - captureTimestamp, inferenceMs);
        const stale = message.timestamp !== captureTimestamp || frameAgeMs > 1500;
        const recovered = !stale && consecutiveStaleFrames > 0;
        consecutiveStaleFrames = stale ? consecutiveStaleFrames + 1 : 0;
        const health: DetectorHealth = { status: stale ? "stale" : "fresh", inferenceMs, frameAgeMs, capturedAt: captureTimestamp, completedAt, consecutiveStaleFrames, recovered };
        if (message.inferenceMs !== undefined && Number.isFinite(message.inferenceMs) && message.inferenceMs >= 0) health.workerInferenceMs = message.inferenceMs;
        // Slow frames are diagnostic events, not fatal model failures. They may
        // recover on the next frame, and never refresh an old physical observation.
        try { onHealth?.(health); } catch { /* A timing consumer must not stop capture. */ }
        if (!active()) return;
        // Never publish delayed physical observations as current positions.
        if (!stale) {
          try { onResult(message.landmarks, message.timestamp, message.detections); }
          catch (reason) { fail(reason instanceof Error ? reason.message : "Unable to process the camera positions."); return; }
        }
        schedule(Math.max(0, 125 - inferenceMs));
      };
      const init: DetectorInput = { type: "init", wasmRoot: new URL("/tracking/wasm", location.origin).href, modelPath: new URL("/tracking/pose_landmarker_lite.task", location.origin).href, personModelPath: new URL("/tracking/efficientdet_lite0.tflite", location.origin).href };
      worker.postMessage(init);
    });
  }
  stop(): void {
    this.generation++;
    clearTimeout(this.timer); clearTimeout(this.frameTimer); clearTimeout(this.initTimer);
    this.timer = undefined; this.frameTimer = undefined; this.initTimer = undefined; this.inFlight = false;
    this.rejectStart?.(new Error("Camera detection stopped.")); this.rejectStart = undefined;
    const worker = this.worker; this.worker = null;
    if (worker) {
      const timeout = setTimeout(() => worker.terminate(), 500);
      worker.onerror = null; worker.onmessageerror = null;
      worker.onmessage = (event: MessageEvent<DetectorOutput>) => { if (event.data.type === "closed") { clearTimeout(timeout); worker.terminate(); } };
      try { const stop: DetectorInput = { type: "stop" }; worker.postMessage(stop); }
      catch { clearTimeout(timeout); worker.terminate(); }
    }
  }
}
