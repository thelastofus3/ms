import { useEffect, useSyncExternalStore } from "react";
import { type Capture, frameCount, photoApi } from "../../gaussian/avatarJobs";
import { FaceGallery, type GallerySource } from "./faces";
import type { ImageDetection, PoseLandmark } from "./types";

const SETTING = "room-face-recognition", CHANGED = "room-face-recognition-change";
/** Recognition is on unless the user turned it off; the choice is shared by Live cameras and Room viewer. */
export const recognitionEnabled = () => { try { return localStorage.getItem(SETTING) !== "off"; } catch { return true; } };
export const setRecognitionEnabled = (enabled: boolean) => { try { localStorage.setItem(SETTING, enabled ? "on" : "off"); } catch { /* Applies to this page only. */ } dispatchEvent(new Event(CHANGED)); };
export const useRecognitionEnabled = () => useSyncExternalStore(listener => { addEventListener(CHANGED, listener); addEventListener("storage", listener); return () => { removeEventListener(CHANGED, listener); removeEventListener("storage", listener); }; }, recognitionEnabled);

export const avatarLabel = (item: Capture) => `Avatar · ${item.kind === "video" ? "video" : `${item.photo_count} photos`} · ${new Date(item.created_at).toLocaleDateString("en-US")}`;
export const rigUrl = (avatarId: string) => `${photoApi}/${avatarId}/avatar/rig`;
export type GalleryState = { status: "idle" | "loading" | "ready" | "failed"; done: number; total: number; error?: string; avatars: { id: string; label: string; faces: number }[] };
let state: GalleryState = { status: "idle", done: 0, total: 0, avatars: [] }, started = false;
const listeners = new Set<() => void>(), publish = (next: GalleryState) => { state = next; listeners.forEach(listener => listener()); };
/** Faces of every finished avatar of this account, read once per page from the photos they were built from. */
export const gallery = new FaceGallery();
async function load() {
  publish({ ...state, status: "loading", error: undefined });
  try {
    const response = await fetch(photoApi);
    const captures: Capture[] = response.ok ? await response.json() : [];
    const sources: GallerySource[] = captures.filter(item => item.job?.state === "done" && item.job.result?.rig && frameCount(item) > 0)
      .map(item => ({ id: item.id, label: avatarLabel(item), version: `${item.created_at}:${frameCount(item)}`, photoCount: frameCount(item), photoUrl: index => `${photoApi}/${item.id}/photos/${index}` }));
    await gallery.enrol(sources, new AbortController().signal, (done, total) => publish({ ...state, status: "loading", done, total }));
    publish({ status: "ready", done: sources.length, total: sources.length, avatars: gallery.entries.map(entry => ({ id: entry.avatarId, label: entry.label, faces: entry.descriptors.length })) });
  } catch (reason) { started = false; publish({ ...state, status: "failed", error: reason instanceof Error ? reason.message : "Face recognition is unavailable." }); }
}
let loading: Promise<void> | undefined;
/** Reads the avatars' faces once per page; a failed attempt may be repeated. */
export const loadFaceGallery = () => { if (!started) { started = true; loading = load(); } return loading!; };
/** Starts reading the avatars' faces the first time recognition is wanted. */
export function useFaceGallery(wanted: boolean): GalleryState {
  useEffect(() => { if (wanted) void loadFaceGallery(); }, [wanted]);
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state);
}

export type Crop = { x: number; y: number; width: number; height: number };
/** Square region of the camera image around a person's head, in pixels; undefined when the head is too small to recognise. */
export function headCrop(pose: PoseLandmark[] | undefined, box: ImageDetection | undefined, imageWidth: number, imageHeight: number, minimumFace: number, scale = 6.5): Crop | undefined {
  let centerX: number, centerY: number, face: number;
  const points = (pose ?? []).slice(0, 11).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.visibility ?? 0) >= 0.5 && p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1);
  if (points.length >= 3) {
    const xs = points.map(p => p.x * imageWidth), ys = points.map(p => p.y * imageHeight);
    // Nose, eyes, ears and mouth span roughly the width of the face.
    face = Math.max(Math.max(...xs) - Math.min(...xs), (Math.max(...ys) - Math.min(...ys)) * 1.6);
    centerX = (Math.max(...xs) + Math.min(...xs)) / 2; centerY = (Math.max(...ys) + Math.min(...ys)) / 2;
  } else if (box && box.height * imageHeight <= box.width * imageWidth * 1.8) {
    // A head-shaped box from the object detector, for people the pose model missed.
    face = box.width * imageWidth * 0.7; centerX = (box.x + box.width / 2) * imageWidth; centerY = (box.y + box.height * 0.5) * imageHeight;
  } else return;
  if (!(face >= minimumFace)) return;
  // The face detector misses a face that fills its input: on real captures it found none at 3x the face and nearly all at 6.5x.
  // The margin also covers the person moving between the analysed frame and this crop.
  const side = Math.min(imageWidth, imageHeight, face * scale), x = Math.round(Math.min(imageWidth - side, Math.max(0, centerX - side / 2))), y = Math.round(Math.min(imageHeight - side, Math.max(0, centerY - side / 2)));
  return { x, y, width: Math.floor(side), height: Math.floor(side) };
}
