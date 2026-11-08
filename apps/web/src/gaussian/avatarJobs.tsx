import { useState } from "react";
import { expireSession, sessionRevision } from "../session";

export type StageState = "pending" | "running" | "done" | "failed" | "cancelled";
export type AvatarStage = {
  id: string; label: string; state: StageState; progress: number; message?: string;
  startedAt?: string; finishedAt?: string; metrics?: Record<string, number>;
};
export type AvatarJob = {
  state: "queued" | "running" | "done" | "failed" | "cancelled"; stage: string | null;
  createdAt: string; startedAt?: string; finishedAt?: string; error: string | null; cancelling?: boolean;
  stages: AvatarStage[]; logTail?: string[];
  result?: { model: string; bytes: number; gaussians: number; rig?: boolean; heldOut: { psnr?: number; ssim?: number; lpips?: number }; previews: string[] };
};
export type Capture = {
  id: string; created_at: string; photo_count: number; status: "photos_ready"; job: AvatarJob | null;
  kind?: "photos" | "video"; video?: { file: string; bytes: number; name: string };
};
export const MAX_VIDEO_BYTES = 1024 ** 3;
/** Number of frames the worker extracted from a video set (0 until the frames stage ran). */
export const frameCount = (item: Capture) => item.kind === "video" ? item.job?.stages.find(stage => stage.id === "frames")?.metrics?.frames ?? 0 : item.photo_count;
/** Raw-body upload with progress; XHR because fetch cannot report upload progress. */
export function uploadVideo(file: File, onProgress: (fraction: number) => void): Promise<Capture> {
  const requestedRevision = sessionRevision();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${photoApi}/video`);
    // Some browsers leave .mov/.webm without a MIME type.
    const extension = file.name.toLowerCase().split(".").pop();
    xhr.setRequestHeader("Content-Type", file.type || (extension === "mov" ? "video/quicktime" : extension === "webm" ? "video/webm" : "video/mp4"));
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name).slice(0, 200));
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    xhr.onload = () => {
      let body: { detail?: unknown } = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* Non-JSON errors use the generic message. */ }
      if (xhr.status === 201) { resolve(body as Capture); return; }
      if (xhr.status === 401) expireSession(requestedRevision);
      reject(Error(typeof body.detail === "string" ? body.detail : xhr.status === 413 ? "The video exceeds 1 GB." : "The video could not be uploaded."));
    };
    xhr.onerror = () => reject(Error("The video upload was interrupted. Check the connection and try again."));
    xhr.send(file);
  });
}

export const photoApi = "/v1/photo-captures";
export const MIN_AVATAR_PHOTOS = 8;
export async function photoRequest(path = "", options?: RequestInit) {
  const requestedRevision = sessionRevision();
  const response = await fetch(photoApi + path, options);
  if (!response.ok) {
    if (response.status === 401) expireSession(requestedRevision);
    const body = await response.json().catch(() => ({}));
    throw Error(typeof body.detail === "string" ? body.detail : "The photo service is unavailable. Try again later.");
  }
  return response.status === 204 ? null : response.json();
}
export const isActive = (job: AvatarJob | null | undefined) => !!job && (job.state === "queued" || job.state === "running");
// Rough share of wall time per stage, so one bar can show the whole job.
const WEIGHTS: Record<string, number> = { frames: 0.03, cameras: 0.05, masks: 0.28, prepare: 0.03, train: 0.57, skeleton: 0.02, rig: 0.02 };
export const overallProgress = (job: AvatarJob) =>
  job.state === "done" ? 1 : job.stages.reduce((sum, stage) => sum + (WEIGHTS[stage.id] ?? 0) * (stage.state === "done" ? 1 : stage.progress || 0), 0);
export const duration = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
};
const since = (start?: string, end?: string) => start ? ((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000 : 0;
const STATE_TEXT: Record<AvatarJob["state"], string> = { queued: "Waiting for the GPU worker", running: "Building avatar", done: "Avatar ready", failed: "Build failed", cancelled: "Cancelled" };

export function JobProgress({ captureId, job, onCancel }: { captureId: string; job: AvatarJob; onCancel?: () => void }) {
  const [log, setLog] = useState<string[] | null>(null);
  const showLog = async () => {
    if (log) { setLog(null); return; }
    const detail: AvatarJob = await photoRequest(`/${captureId}/job`).catch(() => ({ logTail: ["The job log is unavailable."] }));
    setLog(detail.logTail?.length ? detail.logTail : ["No log output yet."]);
  };
  const percent = Math.round(overallProgress(job) * 100);
  return <div className="avatar-job" data-state={job.state} aria-label="Avatar build progress">
    <div className="avatar-job-head">
      <strong>{job.cancelling ? "Cancelling…" : STATE_TEXT[job.state]}</strong>
      <span>{job.state === "queued" ? "" : `${percent}% · ${duration(since(job.startedAt, job.finishedAt))}`}</span>
    </div>
    <div className="avatar-job-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div>
    <ol className="avatar-job-stages">
      {job.stages.map(stage => <li key={stage.id} data-state={stage.state}>
        <span className="avatar-job-dot" aria-hidden="true" />
        <div>
          <b>{stage.label}</b>
          {stage.state === "running" && <em> {Math.round((stage.progress || 0) * 100)}%</em>}
          {stage.state !== "pending" && stage.startedAt && <em> · {duration(since(stage.startedAt, stage.finishedAt))}</em>}
          {stage.message && <small>{stage.message}{stage.state === "running" && stage.metrics?.etaSeconds ? ` · about ${duration(stage.metrics.etaSeconds)} left` : ""}</small>}
        </div>
      </li>)}
    </ol>
    {job.error && <p className="error" role="alert">{job.error}</p>}
    <div className="avatar-job-actions">
      {isActive(job) && onCancel && <button disabled={job.cancelling} onClick={onCancel}>Cancel build</button>}
      {job.state !== "queued" && <button onClick={() => void showLog()}>{log ? "Hide log" : "Show log"}</button>}
    </div>
    {log && <pre className="avatar-job-log">{log.join("\n")}</pre>}
  </div>;
}
