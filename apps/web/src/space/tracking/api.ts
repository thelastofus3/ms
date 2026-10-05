import { request } from "../api";
import type { CameraCalibration, Correspondence, TrackedPerson, TrackingSnapshot } from "./types";

const path = (jobId: string) => `/v1/rooms/jobs/${encodeURIComponent(jobId)}/tracking`;
export type CameraDraft = { name: string; sceneVersion: number; imageWidth: number; imageHeight: number; points: Correspondence[] };
export const cameras = (jobId: string, signal?: AbortSignal) => request<CameraCalibration[]>(`${path(jobId)}/cameras`, undefined, signal);
export const saveCamera = (jobId: string, cameraId: string | null, draft: CameraDraft, signal?: AbortSignal) => request<CameraCalibration>(`${path(jobId)}/cameras${cameraId ? `/${encodeURIComponent(cameraId)}` : ""}`, draft, signal);
export const start = (jobId: string, cameraId: string, signal?: AbortSignal) => request<{ streamId: string }>(`${path(jobId)}/cameras/${encodeURIComponent(cameraId)}/start`, {}, signal);
export const stop = (jobId: string, cameraId: string, streamId: string, signal?: AbortSignal) => request<{ stopped: boolean }>(`${path(jobId)}/cameras/${encodeURIComponent(cameraId)}/stop`, { streamId }, signal);
export const frame = (jobId: string, cameraId: string, body: { sceneVersion: number; calibrationRevision: string; streamId: string; sequence: number; capturedAt: number; people: TrackedPerson[] }, signal?: AbortSignal) => request<{ accepted: boolean }>(`${path(jobId)}/cameras/${encodeURIComponent(cameraId)}/frames`, body, signal);
export const snapshot = (jobId: string, sceneVersion: number, signal?: AbortSignal) => request<TrackingSnapshot>(`${path(jobId)}?sceneVersion=${sceneVersion}`, undefined, signal);
export type AlignmentProgress = { startedAt?: number; updatedAt?: number; completed?: number; total?: number; unit?: string; activity?: string; percent?: number | null };
export type CameraAlignment = { id: string; state: "QUEUED" | "RUNNING" | "READY" | "FAILED" | "APPLIED" | "CANCELLED"; stage: string; error: string | null; createdAt: string; updatedAt?: string; progress?: AlignmentProgress };
export const locateCamera = (jobId: string, body: { name: string; cameraId: string | null; sceneVersion: number; imageWidth: number; imageHeight: number; imageDataUrl: string }, signal?: AbortSignal) => request<CameraAlignment>(`${path(jobId)}/alignments`, body, signal);
export const alignment = (jobId: string, id: string, signal?: AbortSignal) => request<CameraAlignment>(`${path(jobId)}/alignments/${encodeURIComponent(id)}`, undefined, signal);
export const applyAlignment = (jobId: string, id: string, signal?: AbortSignal) => request<CameraCalibration>(`${path(jobId)}/alignments/${encodeURIComponent(id)}/apply`, {}, signal);
export const cancelAlignment = (jobId: string, id: string) => request<CameraAlignment>(`${path(jobId)}/alignments/${encodeURIComponent(id)}/cancel`, {});
