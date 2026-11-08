import { parseManifest, type Calibration, type Job } from "./types";
import { mediaContentType, validatePlyUpload } from "./uploadValidation";
import { canUploadCapture, currentAccount, expireSession, sessionRevision } from "../session";

const base = "/v1/rooms";
export class RoomServiceError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly dimension?: string) {
    super(message);
    this.name = "RoomServiceError";
  }
}
export async function request<T>(path: string, body?: unknown, signal?: AbortSignal, method?: "PATCH" | "DELETE", timeoutMs = 15000): Promise<T> {
  if (path.startsWith(base) && !path.startsWith(`${base}/auth/`) && path !== `${base}/session/recover`) await recoverSession();
  const requestedRevision = sessionRevision();
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    response = await fetch(path, { method: method ?? (body === undefined ? "GET" : "POST"), credentials: "same-origin", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw Error("Cannot connect to the room service. Check that the services are running and retry shortly.");
  }
  if (!response.ok) {
    if (response.status === 401) expireSession(requestedRevision);
    const data = await response.json().catch(() => ({}));
    throw new RoomServiceError(data.message || (response.status >= 500 ? "Room service is unavailable. Retry when the service reconnects." : `Room service returned ${response.status}`), response.status, data.code, data.dimension);
  }
  return response.status === 204 ? undefined as T : response.json();
}
let recoveryAttempt: Promise<void> | undefined;
let recoveredJob: string | undefined;
let recoveryOwner: string | undefined;
export const recoveredJobId = () => recoveredJob;
function recoverSession(): Promise<void> {
  const owner = currentAccount()?.id;
  if (!owner) return Promise.resolve();
  if (owner !== recoveryOwner) { recoveryAttempt = undefined; recoveredJob = undefined; recoveryOwner = owner; }
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
export type QuotaLimits = { storageLimitBytes: number; pendingUploadLimit: number; activeJobLimit: number };
export type QuotaUpload = { id: string; kind: "capture" | "splat"; sealed: boolean; createdAt: string; expiresAt: string | null; discardedAt: string | null; discardable: boolean };
export type RoomQuota = QuotaLimits & { storageChargedBytes: number; storageConfirmedBytes: number; pendingUploads: number; activeJobs: number; uploads: QuotaUpload[] };
export const quota = (signal?: AbortSignal) => request<RoomQuota>(`${base}/quota`, undefined, signal);
export const discardUpload = (id: string) => request(`${base}/uploads/${encodeURIComponent(id)}`, undefined, undefined, "DELETE");
export const accountQuota = (id: string, signal?: AbortSignal) => request<QuotaLimits>(`${base}/auth/users/${encodeURIComponent(id)}/quota`, undefined, signal);
export const saveAccountQuota = (id: string, limits: QuotaLimits) => request<QuotaLimits>(`${base}/auth/users/${encodeURIComponent(id)}/quota`, limits, undefined, "PATCH");
type Part = { number: number; url: string };
type Operation = { key: string; url?: string; partSize?: number; parts?: Part[] };
export type UploadKind = "capture" | "splat";
type UploadPlan = { id: string; kind?: UploadKind; sealed?: boolean; files: Operation[] };
type Draft = { fingerprint: string; uploadId: string; completed: { key: string; parts: { number: number; etag: string }[] }[]; jobKey: string; jobRequest?: { name: string; profile: string } };
function save(draft: Draft, storageKey: string) { try { localStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* Upload continues when local persistence is unavailable. */ } }
function put(url: string, blob: Blob, signal: AbortSignal, progress: (bytes: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const requestedRevision = sessionRevision();
    const stop = () => xhr.abort();
    const cleanup = () => signal.removeEventListener("abort", stop);
    xhr.open("PUT", url);
    xhr.upload.onprogress = event => progress(event.loaded);
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) { resolve(xhr.getResponseHeader("ETag") || ""); return; }
      if (xhr.status === 401) expireSession(requestedRevision);
      let detail: { message?: string; code?: string; dimension?: string } = {};
      try { detail = JSON.parse(xhr.responseText); } catch { /* Gateways may return plain text. */ }
      reject(new RoomServiceError(detail?.message || (xhr.status === 410 ? "This upload has expired or was discarded. Start a new upload." : `Upload failed (${xhr.status}). Select the same files to resume.`), xhr.status, detail?.code, detail?.dimension));
    };
    xhr.onerror = () => { cleanup(); reject(Error("Upload connection failed. Select the same files to resume.")); };
    xhr.onabort = () => { cleanup(); reject(new DOMException("Upload paused", "AbortError")); };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) { cleanup(); reject(new DOMException("Upload paused", "AbortError")); return; }
    xhr.send(blob);
  });
}
export async function upload(files: File[], name: string, profile: string, signal: AbortSignal, progress: (percent: number) => void, phase: (message: string) => void = () => {}, kind: UploadKind = "capture"): Promise<Job> {
  const account = currentAccount();
  if (!account) throw Error("Sign in to upload a scene");
  if (kind === "capture" && !canUploadCapture(account)) throw Error("Your role can import Gaussian PLY files only");
  if (kind === "splat") { const error = validatePlyUpload(files); if (error) throw Error(error); }
  const storageKey = `room-upload-draft-v2:${encodeURIComponent(account.id)}:${kind}`;
  phase("Preparing upload session…");
  const fingerprint = JSON.stringify(files.map(f => [f.name, f.size, f.lastModified]));
  let draft: Draft | undefined;
  try { const saved = JSON.parse(localStorage.getItem(storageKey) || "null") as Draft | null; if (saved?.fingerprint === fingerprint) draft = saved; } catch { /* Fresh upload. */ }
  let plan: UploadPlan;
  if (draft) {
    try { plan = await request<UploadPlan>(`${base}/uploads/${draft.uploadId}`, undefined, signal); if ((plan.kind ?? "capture") !== kind) throw Error("Upload session kind does not match the selected workflow"); }
    catch (error) {
      // Only a missing session invalidates the saved parts. Temporary outages
      // must preserve the upload and its job idempotency key for the next retry.
      if (signal.aborted || !(error instanceof RoomServiceError) || ![404, 410].includes(error.status)) throw error;
      draft = undefined;
    }
  }
  if (!draft) {
    plan = await request<UploadPlan>(`${base}/uploads`, { kind, files: files.map(f => ({ name: f.name, size: f.size, contentType: kind === "splat" ? "application/octet-stream" : mediaContentType(f) })) }, signal);
    draft = { fingerprint, uploadId: plan.id, completed: [], jobKey: crypto.randomUUID() }; save(draft, storageKey);
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);
  let finished = 0;
  if (plan!.sealed) progress(100);
  else {
    phase(kind === "splat" ? "Uploading Gaussian PLY…" : "Uploading capture…");
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
          completed.parts.push({ number: part.number, etag }); save(draft, storageKey); finished += blob.size;
        }
      } else if (completed.parts.some(p => p.number === 0)) finished += f.size;
      else {
        await put(operation.url!, f, signal, n => progress(100 * (finished + n) / total));
        completed.parts.push({ number: 0, etag: "complete" }); save(draft, storageKey); finished += f.size;
      }
      progress(100 * finished / total);
    }
  }
  phase("Confirming uploaded files…");
  await request(`${base}/uploads/${draft.uploadId}/complete`, { files: draft.completed.map(c => ({ key: c.key, parts: c.parts.filter(p => p.number > 0) })) }, signal, undefined, 120000);
  phase(draft.jobRequest && (draft.jobRequest.name !== name || draft.jobRequest.profile !== profile)
    ? "Recovering the previous scene request…" : kind === "splat" ? "Queueing PLY import…" : "Queueing reconstruction…");
  // A lost response may mean the original job already exists. Retry its exact
  // inputs even if the form was edited, so the saved key cannot become a 409.
  if (!draft.jobRequest) { draft.jobRequest = { name, profile }; save(draft, storageKey); }
  const result = await request<Job>(`${base}/jobs`, { uploadId: draft.uploadId, ...draft.jobRequest, idempotencyKey: draft.jobKey }, signal);
  try { localStorage.removeItem(storageKey); } catch { /* The server has already queued the job successfully. */ }
  return result;
}
