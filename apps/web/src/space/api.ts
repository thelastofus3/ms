import { parseManifest, type Calibration, type Job } from "./types";

const base = "/v1/rooms";
export async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (path.startsWith(base) && path !== `${base}/session/recover`) await recoverSession();
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(15000);
    response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw Error("Cannot connect to the room service. Check that the services are running and retry shortly.");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Error(data.message || (response.status >= 500 ? "Room service is unavailable. Retry when the service reconnects." : `Room service returned ${response.status}`));
  }
  return response.json();
}
let recoveryAttempt: Promise<void> | undefined;
let recoveredJob: string | undefined;
export const recoveredJobId = () => recoveredJob;
function recoverSession(): Promise<void> {
  const [route, query = ""] = location.hash.slice(1).split("?");
  const parameters = new URLSearchParams(query), token = parameters.get("recover");
  if (token) {
    // Preserve the destination and remove the one-use secret before any fetch.
    parameters.delete("recover");
    const remaining = parameters.toString();
    history.replaceState(null, "", `${location.pathname}${location.search}#${route || "rooms"}${remaining ? `?${remaining}` : ""}`);
    const attempt = request<{ jobId: string }>(`${base}/session/recover`, { token }).then(result => {
      if (recoveryAttempt === attempt) recoveredJob = result.jobId;
    }).catch(error => {
      // A failed recovery must not permanently block a later valid link.
      if (recoveryAttempt === attempt) recoveryAttempt = undefined;
      throw error;
    });
    recoveryAttempt = attempt;
  }
  return recoveryAttempt ?? Promise.resolve();
}
export async function jobs(signal?: AbortSignal) {
  await recoverSession();
  return request<Job[]>(`${base}/jobs`, undefined, signal);
}
export const job = (id: string) => request<Job>(`${base}/jobs/${id}`);
export const cancel = (id: string) => request<Job>(`${base}/jobs/${id}/cancel`, {});
export const reconstructAgain = (id: string, idempotencyKey: string) => request<Job>(`${base}/jobs/${id}/reconstruct`, { idempotencyKey });
export const calibrate = (id: string, calibration: Calibration) => request<Job>(`${base}/jobs/${id}/calibration`, calibration);
export async function manifest(url: string) { return parseManifest(await request(url)); }
type Part = { number: number; url: string };
type Operation = { key: string; url?: string; partSize?: number; parts?: Part[] };
type UploadPlan = { id: string; files: Operation[] };
type Draft = { fingerprint: string; uploadId: string; completed: { key: string; parts: { number: number; etag: string }[] }[]; jobKey: string };
const storageKey = "room-upload-draft-v1";
function save(draft: Draft) { try { localStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* Upload continues when local persistence is unavailable. */ } }
function put(url: string, blob: Blob, signal: AbortSignal, progress: (bytes: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const stop = () => xhr.abort();
    const cleanup = () => signal.removeEventListener("abort", stop);
    xhr.open("PUT", url);
    xhr.upload.onprogress = event => progress(event.loaded);
    xhr.onload = () => { cleanup(); xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.getResponseHeader("ETag") || "") : reject(Error(`Upload failed (${xhr.status}). Select the same files to resume.`)); };
    xhr.onerror = () => { cleanup(); reject(Error("Upload connection failed. Select the same files to resume.")); };
    xhr.onabort = () => { cleanup(); reject(new DOMException("Upload paused", "AbortError")); };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) { cleanup(); reject(new DOMException("Upload paused", "AbortError")); return; }
    xhr.send(blob);
  });
}
export async function upload(files: File[], name: string, profile: string, signal: AbortSignal, progress: (percent: number) => void, phase: (message: string) => void = () => {}): Promise<Job> {
  phase("Preparing upload session…");
  const fingerprint = JSON.stringify(files.map(f => [f.name, f.size, f.lastModified]));
  let draft: Draft | undefined;
  try { const saved = JSON.parse(localStorage.getItem(storageKey) || "null") as Draft | null; if (saved?.fingerprint === fingerprint) draft = saved; } catch { /* Fresh upload. */ }
  let plan: UploadPlan;
  if (draft) {
    try { plan = await request<UploadPlan>(`${base}/uploads/${draft.uploadId}`, undefined, signal); }
    catch (error) { if (signal.aborted) throw error; draft = undefined; }
  }
  if (!draft) {
    plan = await request<UploadPlan>(`${base}/uploads`, { files: files.map(f => ({ name: f.name, size: f.size, contentType: f.type || mime(f.name) })) }, signal);
    draft = { fingerprint, uploadId: plan.id, completed: [], jobKey: crypto.randomUUID() }; save(draft);
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);
  let finished = 0;
  phase("Uploading capture…");
  for (let i = 0; i < files.length; i++) {
    const f = files[i], operation = plan!.files[i];
    if (!operation) throw Error("Upload session does not match the selected files");
    let completed = draft.completed.find(c => c.key === operation.key);
    if (!completed) { completed = { key: operation.key, parts: [] }; draft.completed.push(completed); }
    if (operation.parts && operation.partSize) {
      for (const part of operation.parts) {
        const start = (part.number - 1) * operation.partSize;
        const blob = f.slice(start, Math.min(f.size, start + operation.partSize));
        if (completed.parts.some(p => p.number === part.number)) { finished += blob.size; continue; }
        const etag = await put(part.url, blob, signal, n => progress(100 * (finished + n) / total));
        if (!etag) throw Error("Storage did not expose the upload ETag. Check storage CORS configuration.");
        completed.parts.push({ number: part.number, etag }); save(draft); finished += blob.size;
      }
    } else if (completed.parts.some(p => p.number === 0)) finished += f.size;
    else {
      await put(operation.url!, f, signal, n => progress(100 * (finished + n) / total));
      completed.parts.push({ number: 0, etag: "complete" }); save(draft); finished += f.size;
    }
    progress(100 * finished / total);
  }
  phase("Confirming uploaded files…");
  await request(`${base}/uploads/${draft.uploadId}/complete`, { files: draft.completed.map(c => ({ key: c.key, parts: c.parts.filter(p => p.number > 0) })) }, signal);
  phase("Queueing reconstruction…");
  const result = await request<Job>(`${base}/jobs`, { uploadId: draft.uploadId, name, profile, idempotencyKey: draft.jobKey }, signal);
  localStorage.removeItem(storageKey);
  return result;
}
function mime(name: string) {
  const extension = name.split(".").pop()?.toLowerCase();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" } as Record<string, string>)[extension || ""] || "application/octet-stream";
}
