import type { FaceBox, FaceInput, FaceOutput } from "./face.worker";

export type Face = { descriptor: Float32Array; score: number; box: FaceBox };
export const faceDistance = (a: ArrayLike<number>, b: ArrayLike<number>) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2; return Math.sqrt(sum); };

/** Face descriptors computed in a worker. One engine serves every camera and the avatar gallery; nothing leaves the browser. */
export class FaceEngine {
  private worker: Worker | undefined;
  private starting: Promise<void> | undefined;
  private waiting = new Map<number, { resolve: (faces: Face[]) => void; reject: (reason: Error) => void }>();
  private sequence = 0;
  /** Live cameras skip a look while another is in flight; the gallery queues instead. */
  get busy() { return this.waiting.size > 0; }
  start(): Promise<void> {
    return this.starting ??= new Promise<void>((resolve, reject) => {
      if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") { reject(Error("This browser cannot run face recognition.")); return; }
      const worker = new Worker(new URL("./face.worker.ts", import.meta.url), { type: "module" });
      const fail = (reason: Error) => { this.waiting.forEach(request => request.reject(reason)); this.waiting.clear(); this.worker = undefined; this.starting = undefined; worker.terminate(); reject(reason); };
      worker.onerror = event => { event.preventDefault(); fail(Error("Face recognition could not start. Check the model assets.")); };
      worker.onmessage = (event: MessageEvent<FaceOutput>) => {
        const output = event.data;
        if (output.type === "ready") { this.worker = worker; resolve(); return; }
        if (output.type === "error" && output.id === undefined) { fail(Error(output.message)); return; }
        const request = this.waiting.get(output.id!); this.waiting.delete(output.id!);
        if (output.type === "faces") request?.resolve(output.faces); else request?.reject(Error(output.message));
      };
      const init: FaceInput = { type: "init", modelRoot: new URL("/tracking/face", location.origin).href };
      worker.postMessage(init);
    });
  }
  /** Takes ownership of the bitmap. */
  async describe(bitmap: ImageBitmap): Promise<Face[]> {
    try { await this.start(); } catch (reason) { bitmap.close(); throw reason; }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence; this.waiting.set(id, { resolve, reject });
      const input: FaceInput = { type: "describe", id, bitmap };
      this.worker!.postMessage(input, [bitmap]);
    });
  }
}
let engine: FaceEngine | undefined;
export const faceEngine = () => engine ??= new FaceEngine();

export type GalleryEntry = { avatarId: string; label: string; descriptors: Float32Array[] };
export type FaceMatch = { avatarId: string; distance: number; margin: number };
const GALLERY_VERSION = 1, SAMPLES = 16, KEEP = 8;
export type GallerySource = { id: string; label: string; version: string; photoCount: number; photoUrl: (index: number) => string };

/** The faces of the people who have avatars, read from the photos those avatars were built from. */
export class FaceGallery {
  entries: GalleryEntry[] = [];
  /** Distance to each avatar is the mean of its two closest reference faces, so one odd photo cannot decide alone. */
  match(descriptor: ArrayLike<number>): FaceMatch | undefined {
    const ranked = this.entries.filter(entry => entry.descriptors.length).map(entry => {
      const distances = entry.descriptors.map(reference => faceDistance(reference, descriptor)).sort((a, b) => a - b);
      return { avatarId: entry.avatarId, distance: distances.length > 1 ? (distances[0] + distances[1]) / 2 : distances[0] };
    }).sort((a, b) => a.distance - b.distance);
    return ranked.length ? { ...ranked[0], margin: ranked.length > 1 ? ranked[1].distance - ranked[0].distance : Infinity } : undefined;
  }
  /** Reads up to 16 evenly spaced photos per avatar and keeps its clearest faces. Results are cached for this browser tab. */
  async enrol(sources: GallerySource[], signal: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<void> {
    const entries: GalleryEntry[] = [];
    for (const [index, source] of sources.entries()) {
      onProgress?.(index, sources.length);
      const key = `face-gallery:${GALLERY_VERSION}:${source.id}:${source.version}`;
      let descriptors: Float32Array[] | undefined;
      try { const cached = sessionStorage.getItem(key); if (cached) descriptors = (JSON.parse(cached) as number[][]).map(values => Float32Array.from(values)); } catch { /* Recomputed below. */ }
      if (!descriptors) {
        const found: Face[] = [], count = Math.min(SAMPLES, source.photoCount);
        for (let i = 0; i < count && !signal.aborted; i++) {
          try {
            const response = await fetch(source.photoUrl(Math.floor(i * source.photoCount / count)), { signal });
            if (!response.ok) continue;
            const full = await createImageBitmap(await response.blob()), scale = Math.min(1, 1280 / Math.max(full.width, full.height));
            const bitmap = scale < 1 ? await createImageBitmap(full, { resizeWidth: Math.round(full.width * scale), resizeHeight: Math.round(full.height * scale), resizeQuality: "high" }) : full;
            if (bitmap !== full) full.close();
            // The avatar's subject is the largest confident face; a photographer or a poster in the background is smaller.
            const faces = (await faceEngine().describe(bitmap)).filter(face => face.score >= 0.6 && Math.min(face.box.width, face.box.height) >= 36).sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
            if (faces[0]) found.push(faces[0]);
          } catch (reason) { if (signal.aborted) return; if (reason instanceof Error && /could not start|cannot run/.test(reason.message)) throw reason; }
        }
        if (signal.aborted) return;
        descriptors = found.sort((a, b) => b.score - a.score).slice(0, KEEP).map(face => face.descriptor);
        try { sessionStorage.setItem(key, JSON.stringify(descriptors.map(values => Array.from(values, value => +value.toFixed(5))))); } catch { /* Cache is optional. */ }
      }
      entries.push({ avatarId: source.id, label: source.label, descriptors });
    }
    if (!signal.aborted) { this.entries = entries; onProgress?.(sources.length, sources.length); }
  }
}
