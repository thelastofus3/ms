import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import * as roomApi from "../api";
import { calibrationFromManifest } from "../calibration";
import { RoomRenderer } from "../renderer";
import type { Job, Point, RoomManifest } from "../types";
import * as trackingApi from "./api";
import { CameraDetector } from "./detector";
import { fitHomography } from "./geometry";
import { PersonTracker } from "./tracker";
import type { CameraCalibration, CameraCaptureControl, Correspondence, DetectorHealth, ImageDetection, ImagePoint, LiveCameraState, PoseLandmark, TrackedPerson } from "./types";
import "../style.css";
import "./tracking.css";

type Dimensions = { width: number; height: number };
type ActiveStream = { jobId: string; camera: CameraCalibration; streamId: string; sequence: number; abort: AbortController; busy: boolean; pending?: { people: TrackedPerson[]; capturedAt: number }; lastQueuedAt: number };
type DetectionState = "idle" | "loading" | "running" | "paused" | "failed";
type AlignmentOperation = { jobId: string; generation: number; captureGeneration: number; sceneVersion: number; cameraId: string | null; revision: string | null; width: number; height: number; stream: MediaStream; abort: AbortController; id?: string; cancelRequested?: boolean; terminal?: boolean };
const bindingKey = (jobId: string, cameraId: string) => `room-camera-source-v1:${jobId}:${cameraId}`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const ignoredAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
const alignmentStageLabel = (stage: string) => {
  const labels: Record<string, string> = { queued: "Waiting for the camera localizer", load_room_map: "Loading room reference data", extract_features: "Finding camera background details", match_room: "Matching camera view to room", estimate_pose: "Calculating camera position", validate_pose: "Checking alignment", complete: "Camera located", ready: "Camera located", applied: "Camera location saved", cancelled: "Alignment stopped", expired: "Alignment expired; locate the camera again", failed: "Camera alignment could not complete" };
  return labels[stage.toLowerCase()] || stage.replace(/_/g, " ").replace(/^./, letter => letter.toUpperCase());
};
const alignmentSteps = ["load_room_map", "extract_features", "match_room", "estimate_pose", "validate_pose", "complete"];
const duration = (seconds: number) => `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
const waitForAlignment = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new DOMException("Alignment stopped", "AbortError")); return; }
  const stop = () => { clearTimeout(timer); reject(new DOMException("Alignment stopped", "AbortError")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, milliseconds);
  signal.addEventListener("abort", stop, { once: true });
});
function sourceBinding(jobId: string, cameraId: string): string | null {
  try { return localStorage.getItem(bindingKey(jobId, cameraId)); } catch { return null; }
}

export function CameraTracking({ jobId, active = true, onState, controlRef }: { jobId: string; active?: boolean; onState?: (state: LiveCameraState | null) => void; controlRef?: MutableRefObject<CameraCaptureControl | null> }) {
  const host = useRef<HTMLDivElement>(null), renderer = useRef<RoomRenderer | undefined>(undefined);
  const video = useRef<HTMLVideoElement>(null), overlay = useRef<HTMLCanvasElement>(null);
  const mounted = useRef(false), captureGeneration = useRef(0), runGeneration = useRef(0), detectorGeneration = useRef(0);
  const sceneRef = useRef<RoomManifest | null>(null), media = useRef<MediaStream | null>(null);
  const detector = useRef<CameraDetector | null>(null), tracker = useRef(new PersonTracker());
  const activeStream = useRef<ActiveStream | null>(null), pendingImage = useRef<ImagePoint | null>(null), pointsRef = useRef<Correspondence[]>([]);
  const lastDetectionAt = useRef(0);
  const alignmentGeneration = useRef(0), alignmentOperation = useRef<AlignmentOperation | null>(null), savedCameraRef = useRef<CameraCalibration | undefined>(undefined);
  const autoPublish = useRef<{ id: string; revision: string } | null>(null), onStateRef = useRef(onState);
  onStateRef.current = onState;
  const calibrationMode = useRef(false), savingRef = useRef(false), requestAbort = useRef(new AbortController());
  const [scene, setScene] = useState<RoomManifest | null>(null), [roomName, setRoomName] = useState("Room");
  const [availableRooms, setAvailableRooms] = useState<Job[]>([]);
  const [saved, setSaved] = useState<CameraCalibration[]>([]), [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("Room camera"), [devices, setDevices] = useState<MediaDeviceInfo[]>([]), [deviceId, setDeviceId] = useState("");
  const [size, setSize] = useState<Dimensions | null>(null), [cameraRunning, setCameraRunning] = useState(false), [captureBusy, setCaptureBusy] = useState(false);
  const [frozen, setFrozen] = useState<string | null>(null), [points, setPoints] = useState<Correspondence[]>([]), [pending, setPending] = useState<ImagePoint | null>(null);
  const [invalidCalibration, setInvalidCalibration] = useState(false), [fixedConfirmed, setFixedConfirmed] = useState(false), [saveBusy, setSaveBusy] = useState(false);
  const [tracking, setTracking] = useState(false), [starting, setStarting] = useState(false), [people, setPeople] = useState<TrackedPerson[]>([]), [detectedCount, setDetectedCount] = useState(0);
  const [detectionState, setDetectionState] = useState<DetectionState>("idle"), [detectionError, setDetectionError] = useState("");
  const [detectionHealth, setDetectionHealth] = useState<DetectorHealth | null>(null);
  const [feetVisible, setFeetVisible] = useState(false);
  const [alignment, setAlignment] = useState<trackingApi.CameraAlignment | null>(null), [alignmentBusy, setAlignmentBusy] = useState(false);
  const [positionMessage, setPositionMessage] = useState("");
  const [progressClock, setProgressClock] = useState(Date.now());
  useEffect(() => {
    if (!alignmentBusy && !cameraRunning) return;
    setProgressClock(Date.now());
    const timer = setInterval(() => setProgressClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [alignmentBusy, cameraRunning]);
  const alignmentStep = alignment ? alignmentSteps.indexOf(alignment.stage) : -1;
  const alignmentElapsed = alignment ? Math.max(0, (progressClock - Date.parse(alignment.createdAt)) / 1000) : 0;
  const stageElapsed = alignment?.progress?.startedAt ? Math.max(0, (progressClock - alignment.progress.startedAt) / 1000) : 0;
  const measuredProgress = alignment?.progress;
  const alignmentPercent = measuredProgress?.percent != null && Number.isFinite(measuredProgress.percent) ? Math.max(0, Math.min(100, measuredProgress.percent)) : undefined;
  const viewerPositionMessage = alignmentBusy ? `${alignmentStep >= 0 ? `Camera alignment · Step ${alignmentStep + 1} of ${alignmentSteps.length}` : "Camera alignment"} · ${alignmentStageLabel(alignment?.stage || "Sending camera frame")} · ${duration(alignmentElapsed)} elapsed${measuredProgress?.total && measuredProgress.completed !== undefined ? ` · ${measuredProgress.completed}/${measuredProgress.total} ${measuredProgress.unit}${alignmentPercent !== undefined ? ` (${alignmentPercent.toFixed(0)}%)` : ""}` : ""}` : positionMessage;
  const [status, setStatus] = useState("Loading your saved room..."), [error, setError] = useState(""), [roomLoading, setRoomLoading] = useState(true), [collision, setCollision] = useState(false);
  const savedCamera = saved.find(camera => camera.id === selectedId);
  savedCameraRef.current = savedCamera;
  const estimatedCount = people.filter(person => person.positionMethod === "estimated").length, floorCount = people.length - estimatedCount;
  const { fit, fitError } = useMemo(() => {
    if (points.length < 4) return { fit: null, fitError: "" };
    try { return { fit: fitHomography(points), fitError: "" }; } catch (e) { return { fit: null, fitError: message(e) }; }
  }, [points]);
  const dimensionsMatch = !!size && !!savedCamera && size.width === savedCamera.imageWidth && size.height === savedCamera.imageHeight;
  const dirty = !savedCamera || name.trim() !== savedCamera.name || JSON.stringify(points) !== JSON.stringify(savedCamera.points);
  const calibrationUsable = !!savedCamera && savedCamera.sceneVersion === scene?.version && dimensionsMatch && !dirty && !invalidCalibration;
  const canTrack = !!scene?.navigation && cameraRunning && !frozen && !alignmentBusy && detectionState === "running" && calibrationUsable && fixedConfirmed;
  const cameraNeedsAlignment = !savedCamera || savedCamera.sceneVersion !== scene?.version || invalidCalibration || cameraRunning && !dimensionsMatch;
  const cameraPositionTitle = alignmentBusy ? "Locating camera in the room"
    : cameraNeedsAlignment ? "Camera not located for this live view"
    : savedCamera.geometry ? "Saved camera location in the room" : "Saved camera floor mapping";
  const cameraPositionHelp = alignmentBusy ? "Person detection continues while the room background is matched. Room positions start automatically after alignment."
    : cameraNeedsAlignment ? "A detected person has image coordinates only. Press Automatically locate camera to convert detections into room coordinates."
    : !cameraRunning ? "Start the same fixed camera to use this location. Confirm it has not moved, or locate it again."
    : !calibrationUsable ? "The camera settings have unsaved changes. Restore the saved settings or locate the camera again before starting room positions."
    : !fixedConfirmed ? "Confirm the saved camera is still fixed, or locate it again if it moved."
    : tracking ? "Live detections use this camera's position and the saved floor. Green markers are floor-based; amber markers are uncertain estimates."
    : starting || detectionState === "loading" ? "The camera is matched. Room positions will start when person detection is ready."
    : "The camera is matched. Press Display humans in 3D to resume room positions.";
  const nextAction = !cameraRunning ? "Start the camera. Person detection starts automatically; room placement can be set afterward."
    : alignmentBusy ? "Locating the fixed camera from its room background. Detection continues locally; room positions start after alignment succeeds."
    : frozen ? "Match at least four floor landmarks in the image and the room, then save the camera position."
    : detectionState === "failed" ? "Retry person detection. Camera matching can be completed while detection is unavailable."
    : detectionState === "loading" ? autoPublish.current ? "Camera position saved. Person detection is loading; live room positions will start automatically." : "Person detection is loading. You can already automatically locate this camera in the room."
    : !calibrationUsable ? "Automatically locate this camera in the reconstructed room. People will then be positioned and tracked automatically."
    : detectionState !== "running" ? "Wait for person detection to finish loading."
    : !fixedConfirmed ? "Confirm that this saved camera has not moved to start live room positions automatically."
    : !tracking ? "The camera is matched. Press Display humans in 3D to see their positions in the room on the right." : "Human markers now move in the room on the right and in the separate viewer.";
  const guidedStep = !cameraRunning ? 1 : frozen || !calibrationUsable ? 2 : 3;

  const changePoints = (value: Correspondence[]) => { pointsRef.current = value; setPoints(value); };
  const clearPending = () => { pendingImage.current = null; setPending(null); };
  const clearOverlay = () => { const canvas = overlay.current; canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height); };
  const cancelAlignment = (operation: AlignmentOperation) => {
    if (!operation.id || operation.cancelRequested || operation.terminal) return;
    operation.cancelRequested = true;
    void trackingApi.cancelAlignment(operation.jobId, operation.id).catch(() => {});
  };
  const stopTracking = () => {
    ++runGeneration.current;
    autoPublish.current = null;
    tracker.current.reset();
    const session = activeStream.current; activeStream.current = null;
    if (session) { session.pending = undefined; session.abort.abort(); void trackingApi.stop(session.jobId, session.camera.id, session.streamId).catch(() => {}); }
    renderer.current?.setPeople([]);
    if (mounted.current) { setTracking(false); setStarting(false); setPeople([]); setPositionMessage(""); }
  };
  const stopAlignment = (notice = false) => {
    ++alignmentGeneration.current;
    const operation = alignmentOperation.current; alignmentOperation.current = null;
    if (operation) cancelAlignment(operation);
    operation?.abort.abort();
    if (mounted.current) {
      setAlignmentBusy(false);
      if (operation) { setPositionMessage(""); setAlignment(current => current ? { ...current, state: "CANCELLED", stage: "Cancelled", error: null } : null); }
      if (notice) setStatus("Automatic camera alignment stopped. Its result will not start live positions; the temporary frame is removed by the service.");
    }
  };
  const stopPreview = (state: DetectionState = "idle") => {
    ++detectorGeneration.current; lastDetectionAt.current = 0;
    detector.current?.stop(); detector.current = null; clearOverlay();
    if (mounted.current) { setDetectionState(state); setDetectedCount(0); setFeetVisible(false); setDetectionHealth(null); }
  };
  const stopCamera = () => {
    stopAlignment(); ++captureGeneration.current; stopTracking(); stopPreview();
    media.current?.getTracks().forEach(track => { track.onended = null; track.stop(); }); media.current = null;
    if (video.current) video.current.srcObject = null;
    calibrationMode.current = false; clearPending();
    if (mounted.current) { setCameraRunning(false); setCaptureBusy(false); setFrozen(null); setFixedConfirmed(false); setSize(null); }
    renderer.current?.setTool("review");
  };
  useEffect(() => {
    if (!controlRef) return;
    const controls = { stopCamera }; controlRef.current = controls;
    return () => { if (controlRef.current === controls) controlRef.current = null; };
  }, [controlRef]);
  useEffect(() => {
    const publish = () => onStateRef.current?.({ jobId, name, cameraRunning, detectionState, detectionHealth: detectionHealth ?? undefined, tracking, starting, detectedCount, positionedCount: people.length, feetVisible, calibrationUsable, fixedConfirmed, lastDetectionAt: lastDetectionAt.current, error: error || detectionError, positionMessage: viewerPositionMessage, estimatedCount });
    publish();
    // Keep the shell's freshness indicator current even when a still person
    // produces the same count on every frame and React does not rerender.
    const timer = cameraRunning ? setInterval(publish, 500) : undefined;
    return () => clearInterval(timer);
  }, [jobId, name, cameraRunning, detectionState, detectionHealth, tracking, starting, detectedCount, people.length, feetVisible, calibrationUsable, fixedConfirmed, error, detectionError, viewerPositionMessage, estimatedCount]);
  useEffect(() => () => onStateRef.current?.(null), []);
  const refreshDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const result = await navigator.mediaDevices.enumerateDevices();
    if (mounted.current) setDevices(result.filter(device => device.kind === "videoinput"));
  };
  useEffect(() => {
    mounted.current = true; requestAbort.current = new AbortController();
    const abort = requestAbort.current;
    setRoomLoading(true); setError(""); setScene(null); setSaved([]); setSelectedId(null); setName("Room camera"); setDeviceId(""); changePoints([]); clearPending();
    setCameraRunning(false); setTracking(false); setStarting(false); setFrozen(null); setSize(null); setInvalidCalibration(false); setFixedConfirmed(false);
    if (!jobId) {
      setStatus("Choose a saved room to configure its cameras.");
      void roomApi.jobs(abort.signal).then(jobs => { if (!abort.signal.aborted) setAvailableRooms(jobs.filter(job => job.state === "READY")); }).catch(e => { if (!abort.signal.aborted) setError(message(e)); }).finally(() => { if (!abort.signal.aborted) setRoomLoading(false); });
      return () => { mounted.current = false; abort.abort(); };
    }
    const view = new RoomRenderer(host.current!); renderer.current = view;
    view.onStatus = value => { if (mounted.current) setStatus(value); };
    view.onPick = (raw: Point) => {
      const image = pendingImage.current, manifest = sceneRef.current;
      if (savingRef.current || pointsRef.current.length >= 16) return;
      if (!calibrationMode.current || !image || !manifest) { if (calibrationMode.current) setStatus("First select a visible floor landmark in the frozen camera image, then its matching point in the room."); return; }
      const world = new THREE.Vector3(raw.x, raw.y, raw.z).applyMatrix4(new THREE.Matrix4().fromArray(manifest.worldFromReconstruction));
      changePoints([...pointsRef.current, { image, world: { x: world.x, z: world.z } }]); clearPending();
      setStatus(`Pair ${pointsRef.current.length} added. Spread reference points over the visible floor.`);
    };
    const load = async () => {
      try {
        const job = await roomApi.request<Job>(`/v1/rooms/jobs/${encodeURIComponent(jobId)}`, undefined, abort.signal);
        if (!job.manifestUrl) throw Error("This room has no scene yet. Complete reconstruction and room setup first.");
        const manifest = await roomApi.manifest(job.manifestUrl);
        if (abort.signal.aborted) return;
        if (!manifest.ready || !manifest.navigation) throw Error("Save the room's scale, floor and walking area before calibrating cameras.");
        const configs = await trackingApi.cameras(jobId, abort.signal);
        await view.load(manifest); if (abort.signal.aborted) return;
        sceneRef.current = manifest; setScene(manifest); setRoomName(job.name); setSaved(configs);
        view.mark(calibrationFromManifest(manifest), "boundary", null, true); view.setTool("review"); view.topView();
        const current = configs.find(camera => camera.sceneVersion === manifest.version);
        if (current) { setSelectedId(current.id); setName(current.name); changePoints(current.points); setDeviceId(sourceBinding(jobId, current.id) ?? ""); }
        setStatus("Start a fixed camera, then automatically locate it in this room. People are recognized and tracked without manual tags.");
      } catch (e) { if (!abort.signal.aborted && mounted.current) setError(message(e)); }
      finally { if (!abort.signal.aborted && mounted.current) setRoomLoading(false); }
    };
    void load(); void refreshDevices().catch(() => {});
    const deviceChange = () => void refreshDevices().catch(() => {});
    navigator.mediaDevices?.addEventListener("devicechange", deviceChange);
    return () => {
      mounted.current = false; abort.abort(); stopCamera(); view.setTrackingCameras([]); view.dispose(); renderer.current = undefined; sceneRef.current = null;
      navigator.mediaDevices?.removeEventListener("devicechange", deviceChange);
    };
  }, [jobId]);
  useEffect(() => { renderer.current?.setPaused(!active); }, [active, scene]);
  useEffect(() => { renderer.current?.markFloorReferences(points.map(pair => pair.world)); }, [points, scene]);
  useEffect(() => {
    renderer.current?.setTrackingCameras(scene ? saved.filter(camera => camera.sceneVersion === scene.version) : [], selectedId ?? undefined);
  }, [saved, selectedId, scene]);
  useEffect(() => {
    if (!cameraRunning || frozen) return;
    const timer = setInterval(() => {
      if (lastDetectionAt.current && Date.now() - lastDetectionAt.current >= 1500) {
        lastDetectionAt.current = 0; setPeople([]); setDetectedCount(0); setFeetVisible(false); setPositionMessage("Waiting for a fresh camera frame. Old positions have expired."); clearOverlay(); renderer.current?.setPeople([]);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [cameraRunning, frozen]);
  useEffect(() => {
    const pending = autoPublish.current;
    if (!pending || !canTrack || savedCamera?.id !== pending.id || savedCamera.revision !== pending.revision) return;
    autoPublish.current = null;
    void startTracking();
  }, [canTrack, savedCamera?.id, savedCamera?.revision, detectionState]);

  const selectCamera = (id: string) => {
    stopCamera(); setError(""); setInvalidCalibration(false);
    const camera = saved.find(value => value.id === id);
    setSelectedId(camera?.id ?? null); setName(camera?.name ?? `Room camera ${saved.length + 1}`); changePoints(camera?.points ?? []);
    setDeviceId(camera ? sourceBinding(jobId, camera.id) ?? "" : "");
  };
  const startCamera = async () => {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) { setError("Camera capture requires HTTPS or localhost and a browser with camera support."); return; }
    const generation = ++captureGeneration.current; setCaptureBusy(true);
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "environment" }), width: { ideal: savedCamera?.imageWidth ?? 1280 }, height: { ideal: savedCamera?.imageHeight ?? 720 } } });
      if (!mounted.current || generation !== captureGeneration.current) { stream.getTracks().forEach(track => track.stop()); return; }
      media.current = stream;
      const element = video.current!; element.srcObject = stream;
      await element.play();
      if (!element.videoWidth || !element.videoHeight) throw Error("Camera did not provide a usable video frame. Choose another camera and retry.");
      if (!mounted.current || generation !== captureGeneration.current) { stream.getTracks().forEach(track => track.stop()); if (media.current === stream) media.current = null; return; }
      const nextSize = { width: element.videoWidth, height: element.videoHeight }; setSize(nextSize); setCameraRunning(true); setFixedConfirmed(false);
      const actualDevice = stream.getVideoTracks()[0]?.getSettings().deviceId;
      const binding = savedCamera && sourceBinding(jobId, savedCamera.id);
      if (savedCamera && (savedCamera.imageWidth !== nextSize.width || savedCamera.imageHeight !== nextSize.height || (binding && binding !== actualDevice))) {
        setInvalidCalibration(true); setStatus("The source or frame dimensions changed. Automatically locate this camera again.");
      } else setStatus("Camera is live. Keep its position, zoom and crop fixed.");
      stream.getVideoTracks().forEach(track => { track.onended = () => { if (mounted.current && media.current === stream) { stopCamera(); setError("Camera disconnected or permission was revoked. Start the camera again."); } }; });
      await refreshDevices().catch(() => {});
      if (mounted.current && generation === captureGeneration.current && media.current === stream) void startPreview();
    } catch (e) {
      stream?.getTracks().forEach(track => track.stop());
      if (mounted.current && generation === captureGeneration.current) { media.current = null; if (video.current) video.current.srcObject = null; setCameraRunning(false); setError(message(e)); }
    } finally { if (mounted.current && generation === captureGeneration.current) setCaptureBusy(false); }
  };
  const freezeFrame = () => {
    if (!video.current || !size || !cameraRunning) return;
    stopAlignment();
    stopTracking(); stopPreview("paused");
    const canvas = document.createElement("canvas"); canvas.width = video.current.videoWidth; canvas.height = video.current.videoHeight;
    if (!canvas.width || !canvas.height) { setError("The camera has no current frame. Wait for it to reconnect and try again."); void startPreview(); return; }
    const context = canvas.getContext("2d"); if (!context) { setError("Could not capture a calibration image."); void startPreview(); return; }
    context.drawImage(video.current, 0, 0);
    setSize({ width: canvas.width, height: canvas.height });
    setFrozen(canvas.toDataURL("image/png")); calibrationMode.current = true; setInvalidCalibration(true); setFixedConfirmed(false); changePoints([]); clearPending();
    renderer.current?.setTool("boundary");
    setStatus("Select a floor landmark in the image, then click the same landmark on the room floor. Add at least four spread-out pairs.");
  };
  const pickImage = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!frozen || !size || points.length >= 16 || saveBusy) return;
    const rect = event.currentTarget.getBoundingClientRect(), scale = Math.min(rect.width / size.width, rect.height / size.height);
    const width = size.width * scale, height = size.height * scale;
    const x = (event.clientX - rect.left - (rect.width - width) / 2) / width, y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    const image = { x, y }; pendingImage.current = image; setPending(image);
    setStatus(`Image point ${points.length + 1} selected. Click its matching floor location in the 3D room.`);
    host.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  const saveCalibration = async () => {
    if (!scene || !size || !fit || !frozen || !name.trim()) return;
    if (!media.current || !video.current || video.current.videoWidth !== size.width || video.current.videoHeight !== size.height) { setError("The video source changed during matching. Take a new frame and match the camera again."); return; }
    const savedCaptureGeneration = captureGeneration.current;
    savingRef.current = true; setSaveBusy(true); setError("");
    try {
      const camera = await trackingApi.saveCamera(jobId, selectedId, { name: name.trim(), sceneVersion: scene.version, imageWidth: size.width, imageHeight: size.height, points }, requestAbort.current.signal);
      if (!mounted.current) return;
      const actualDevice = media.current?.getVideoTracks()[0]?.getSettings().deviceId;
      try { if (actualDevice) localStorage.setItem(bindingKey(jobId, camera.id), actualDevice); } catch { /* Physical camera confirmation remains required. */ }
      setSaved(current => [...current.filter(value => value.id !== camera.id), camera]); setSelectedId(camera.id); setName(camera.name); changePoints(camera.points);
      const stillCapturing = savedCaptureGeneration === captureGeneration.current && !!media.current && !!video.current;
      const sourceChanged = !!video.current && !!media.current && (video.current.videoWidth !== camera.imageWidth || video.current.videoHeight !== camera.imageHeight);
      calibrationMode.current = false; renderer.current?.setTool("review"); clearPending(); setFrozen(null); setInvalidCalibration(sourceChanged); setFixedConfirmed(stillCapturing && !sourceChanged);
      autoPublish.current = stillCapturing && !sourceChanged ? { id: camera.id, revision: camera.revision } : null;
      setStatus(`Camera position saved. Fit residual: ${(camera.fitErrorMeters * 100).toFixed(1)} cm. ${autoPublish.current ? "Starting live room positions as soon as detection is ready." : "Camera capture is stopped or changed; restart or match it before displaying positions."}`);
      if (stillCapturing) void startPreview();
    } catch (e) { if (mounted.current && !ignoredAbort(e)) setError(message(e)); }
    finally { savingRef.current = false; if (mounted.current) setSaveBusy(false); }
  };
  const locateCamera = async () => {
    const element = video.current, stream = media.current, manifest = sceneRef.current;
    if (!element || !stream || !manifest?.navigation || !cameraRunning || frozen || saveBusy || !name.trim()) return;
    const width = element.videoWidth, height = element.videoHeight;
    if (!width || !height || width > 4096 || height > 4096) { setError("A live camera frame up to 4096 pixels per side is required. Choose a lower camera resolution and try again."); return; }
    // This is the sole camera-image transfer. Continuous inference stays local.
    const canvas = document.createElement("canvas"), scale = Math.min(1, 1280 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) { setError("Could not capture the camera alignment image."); return; }
    let imageDataUrl: string;
    try { context.drawImage(element, 0, 0, canvas.width, canvas.height); imageDataUrl = canvas.toDataURL("image/jpeg", 0.88); }
    catch (e) { setError(`Could not capture the camera alignment image: ${message(e)}`); return; }
    if (!imageDataUrl.startsWith("data:image/jpeg;base64,") || imageDataUrl.length * 0.75 > 2 * 1024 * 1024) { setError("The alignment frame is too large. Choose a lower camera resolution and try again."); return; }
    stopAlignment(); stopTracking(); setError(""); setFixedConfirmed(false);
    const currentCamera = savedCameraRef.current;
    const operation: AlignmentOperation = { jobId, generation: ++alignmentGeneration.current, captureGeneration: captureGeneration.current, sceneVersion: manifest.version, cameraId: currentCamera?.id ?? null, revision: currentCamera?.revision ?? null, width, height, stream, abort: new AbortController() };
    alignmentOperation.current = operation; setAlignmentBusy(true); setAlignment(null); setPositionMessage("Automatically locating the fixed camera in this room. Person detection continues locally.");
    const current = () => mounted.current && alignmentOperation.current === operation && alignmentGeneration.current === operation.generation && captureGeneration.current === operation.captureGeneration && !operation.abort.signal.aborted && sceneRef.current?.version === operation.sceneVersion && media.current === operation.stream && video.current?.videoWidth === operation.width && video.current?.videoHeight === operation.height && (savedCameraRef.current?.id ?? null) === operation.cameraId && (savedCameraRef.current?.revision ?? null) === operation.revision;
    const requireCurrent = () => { if (!current()) throw new DOMException("Camera source or room changed", "AbortError"); };
    let applied = false;
    try {
      let result = await trackingApi.locateCamera(jobId, { name: name.trim(), cameraId: operation.cameraId, sceneVersion: operation.sceneVersion, imageWidth: width, imageHeight: height, imageDataUrl }, operation.abort.signal);
      operation.id = result.id;
      operation.terminal = ["FAILED", "CANCELLED", "APPLIED"].includes(result.state);
      requireCurrent(); setAlignment(result); setPositionMessage(`Automatically locating camera: ${alignmentStageLabel(result.stage || result.state)}.`);
      const deadline = Date.now() + 10 * 60 * 1000;
      while (result.state === "QUEUED" || result.state === "RUNNING") {
        if (Date.now() >= deadline) throw Error("Camera alignment timed out. Keep more static room background visible and try again.");
        await waitForAlignment(1200, operation.abort.signal); requireCurrent();
        result = await trackingApi.alignment(jobId, result.id, operation.abort.signal);
        operation.terminal = ["FAILED", "CANCELLED", "APPLIED"].includes(result.state);
        requireCurrent(); setAlignment(result); setPositionMessage(`Automatically locating camera: ${alignmentStageLabel(result.stage || result.state)}.`);
      }
      if (result.state !== "READY" && result.state !== "APPLIED") throw Error(result.error || (result.state === "CANCELLED" ? "Camera alignment was cancelled." : "The camera could not be located. Show more background from the reconstructed room, or use manual camera calibration."));
      requireCurrent(); setAlignment({ ...result, stage: "Saving camera pose" });
      const camera = await trackingApi.applyAlignment(jobId, result.id, operation.abort.signal);
      requireCurrent();
      if (camera.sceneVersion !== operation.sceneVersion || camera.imageWidth !== width || camera.imageHeight !== height || !camera.geometry) throw Error("The returned camera does not match this live source. Reload the room and locate the camera again.");
      applied = true;
      const actualDevice = operation.stream.getVideoTracks()[0]?.getSettings().deviceId;
      try { if (actualDevice) localStorage.setItem(bindingKey(jobId, camera.id), actualDevice); } catch { /* Confirmation applies only to this active capture. */ }
      setSaved(values => [...values.filter(value => value.id !== camera.id), camera]); setSelectedId(camera.id); setName(camera.name); changePoints(camera.points);
      calibrationMode.current = false; clearPending(); setFrozen(null); renderer.current?.setTool("review"); setInvalidCalibration(false); setFixedConfirmed(true);
      autoPublish.current = { id: camera.id, revision: camera.revision };
      setAlignment({ ...result, state: "APPLIED", stage: "Camera located", error: null });
      setStatus(`Camera located from ${camera.geometry.inliers} background matches (${camera.geometry.reprojectionErrorPx.toFixed(1)} px reprojection error). Live human positions start automatically; body-depth estimates are labelled separately.`);
    } catch (e) {
      if (!applied) cancelAlignment(operation);
      if (alignmentOperation.current === operation && mounted.current) {
        autoPublish.current = null;
        const detail = ignoredAbort(e) ? "The camera source or room changed. Locate the current camera again; the old result was discarded." : message(e);
        setAlignment(value => value ? { ...value, state: ignoredAbort(e) ? "CANCELLED" : "FAILED", error: detail } : null); setError(detail);
      }
    } finally {
      if (alignmentOperation.current === operation) { alignmentOperation.current = null; if (mounted.current) setAlignmentBusy(false); }
    }
  };
  const previewBoxes = (detections: ImageDetection[] = []) => detections.filter(box => [box.x, box.y, box.width, box.height, box.confidence].every(Number.isFinite) && box.width > 0 && box.height > 0 && box.confidence >= 0.35);
  const drawDetection = (landmarks: PoseLandmark[][], detections: ImageDetection[] = []) => {
    const canvas = overlay.current; if (!canvas || !video.current) return;
    canvas.width = video.current.videoWidth; canvas.height = video.current.videoHeight;
    const context = canvas.getContext("2d"); if (!context) return;
    context.strokeStyle = "#aee9c6"; context.fillStyle = "#aee9c6"; context.lineWidth = Math.max(2, canvas.width / 600); context.font = `${Math.max(16, canvas.width / 55)}px sans-serif`;
    const boxes = previewBoxes(detections);
    const drawBox = (left: number, top: number, right: number, bottom: number, label: string) => {
      const x = Math.max(0, left), y = Math.max(0, top), endX = Math.min(canvas.width, right), endY = Math.min(canvas.height, bottom);
      if (endX <= x || endY <= y) return;
      context.strokeRect(x, y, endX - x, endY - y);
      context.fillText(label, Math.max(4, Math.min(x, canvas.width - canvas.width * 0.3)), Math.max(24, y - 14));
    };
    boxes.forEach((box, index) => drawBox(box.x * canvas.width, box.y * canvas.height, (box.x + box.width) * canvas.width, (box.y + box.height) * canvas.height, `Human detected${boxes.length > 1 ? ` ${index + 1}` : ""}`));
    landmarks.forEach((pose, index) => {
      const visible = (i: number) => pose[i] && Number.isFinite(pose[i].x) && Number.isFinite(pose[i].y) && pose[i].x >= 0 && pose[i].x <= 1 && pose[i].y >= 0 && pose[i].y <= 1 && (pose[i].visibility ?? 1) >= 0.5;
      [[11, 12], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [29, 31], [28, 30], [30, 32]].forEach(([a, b]) => {
        if (!visible(a) || !visible(b)) return;
        context.beginPath(); context.moveTo(pose[a].x * canvas.width, pose[a].y * canvas.height); context.lineTo(pose[b].x * canvas.width, pose[b].y * canvas.height); context.stroke();
      });
      const reliable = pose.filter((_, i) => visible(i));
      if (!boxes.length && reliable.length) {
        const left = Math.min(...reliable.map(p => p.x)) * canvas.width, top = Math.min(...reliable.map(p => p.y)) * canvas.height;
        const right = Math.max(...reliable.map(p => p.x)) * canvas.width, bottom = Math.max(...reliable.map(p => p.y)) * canvas.height;
        drawBox(left - 8, top - 8, right + 8, bottom + 8, `Human detected${landmarks.length > 1 ? ` ${index + 1}` : ""}`);
      }
      [29, 30, 31, 32].forEach(i => { if (visible(i)) { context.beginPath(); context.arc(pose[i].x * canvas.width, pose[i].y * canvas.height, 4, 0, Math.PI * 2); context.fill(); } });
    });
  };
  const publishLatest = async (session: ActiveStream) => {
    if (session.busy || activeStream.current !== session || !session.pending) return;
    const observation = session.pending; session.pending = undefined;
    if (Date.now() - observation.capturedAt > 1000) return;
    session.busy = true;
    try {
      await trackingApi.frame(session.jobId, session.camera.id, { sceneVersion: session.camera.sceneVersion, calibrationRevision: session.camera.revision, streamId: session.streamId, sequence: ++session.sequence, ...observation }, session.abort.signal);
    } catch (e) {
      if (activeStream.current === session && !session.abort.signal.aborted && mounted.current) { stopTracking(); setError(`${message(e)} Tracking stopped; reopen the room if its setup changed.`); }
    } finally {
      session.busy = false;
      if (activeStream.current === session && session.pending) void publishLatest(session);
    }
  };
  const startPreview = async () => {
    if (!mounted.current || !media.current || !video.current || calibrationMode.current) return;
    stopPreview(); setDetectionError(""); setDetectionState("loading");
    const generation = ++detectorGeneration.current, element = video.current;
    const instance = new CameraDetector(); detector.current = instance;
    const active = () => mounted.current && generation === detectorGeneration.current && detector.current === instance;
    const fail = (detail: string) => {
      if (!active()) return;
      const source = video.current, camera = activeStream.current?.camera;
      if (/resolution|dimension|source.*chang/i.test(detail) || source && camera && (source.videoWidth !== camera.imageWidth || source.videoHeight !== camera.imageHeight)) {
        setInvalidCalibration(true); setFixedConfirmed(false);
        if (source?.videoWidth && source.videoHeight) setSize({ width: source.videoWidth, height: source.videoHeight });
      }
      stopAlignment(); stopTracking(); stopPreview("failed"); setDetectionError(detail);
    };
    try {
      await instance.start(element, (landmarks, timestamp, detections) => {
        if (!active() || calibrationMode.current || !video.current) return;
        const validFoot = (p: PoseLandmark | undefined) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > 0.005 && p.x < 0.995 && p.y > 0.005 && p.y < 0.995 && (p.visibility ?? 0) >= 0.65 && (p.presence ?? 1) >= 0.65;
        setFeetVisible(landmarks.some(pose => validFoot(pose[29]) && validFoot(pose[31]) || validFoot(pose[30]) && validFoot(pose[32])));
        lastDetectionAt.current = timestamp; setDetectedCount(Math.max(landmarks.length, previewBoxes(detections).length)); drawDetection(landmarks, detections);
        const alignment = alignmentOperation.current;
        if (alignment && (video.current.videoWidth !== alignment.width || video.current.videoHeight !== alignment.height)) { stopAlignment(); setInvalidCalibration(true); setFixedConfirmed(false); setError("Camera dimensions changed during alignment. Locate this camera again."); }
        const session = activeStream.current, navigation = sceneRef.current?.navigation;
        if (!session || !navigation) return;
        const camera = session.camera;
        if (video.current.videoWidth !== camera.imageWidth || video.current.videoHeight !== camera.imageHeight) {
          stopAlignment();
          setInvalidCalibration(true); setFixedConfirmed(false);
          if (video.current.videoWidth && video.current.videoHeight) setSize({ width: video.current.videoWidth, height: video.current.videoHeight });
          stopTracking(); setError("Video frame size changed. Match the camera to the room again before displaying positions."); return;
        }
        const positions = tracker.current.update(landmarks, camera, navigation, timestamp);
        setPeople(positions);
        const diagnostics = [...new Set(tracker.current.diagnostics)];
        setPositionMessage(diagnostics.length ? diagnostics.join(" ") : positions.length ? positions.some(person => person.positionMethod === "estimated") ? "Estimated positions use assumed adult body dimensions. Visible feet provide a floor-based position instead." : "Visible feet are positioned on the calibrated room floor."
          : Math.max(landmarks.length, previewBoxes(detections).length) ? camera.geometry ? "Human detected, but usable feet, paired shoulders or face landmarks are unavailable. Show more of the body and room background." : "Human detected. This manual floor calibration needs clearly visible feet; automatically locate the camera to enable body-depth estimates." : "No human is detected in the current camera frame.");
        renderer.current?.setPeople(positions.map(person => ({ ...person, id: `${camera.id}:${session.streamId}:${person.id}`, label: `Human ${person.id} - ${camera.name}${person.positionMethod === "estimated" ? ` - Estimated +/- ${(person.uncertaintyMeters ?? 0).toFixed(1)} m` : ""}`, expiresAt: timestamp + 1500 })));
        if (timestamp - session.lastQueuedAt >= 200) { session.lastQueuedAt = timestamp; session.pending = { people: positions, capturedAt: timestamp }; void publishLatest(session); }
      }, fail, health => {
        if (!active() || calibrationMode.current) return;
        setDetectionHealth(health);
        if (health.status !== "stale") {
          if (health.recovered && !activeStream.current) setPositionMessage("");
          return;
        }
        lastDetectionAt.current = 0; setPeople([]); setDetectedCount(0); setFeetVisible(false); clearOverlay(); renderer.current?.setPeople([]);
        if (health.consecutiveStaleFrames === 1) tracker.current.reset();
        setPositionMessage(`Detection took ${(health.inferenceMs / 1000).toFixed(1)}s, so this old observation cannot be used as a live room position. Stop heavy tasks or use a faster device. Tracking will resume automatically with fresh frames.`);
      });
      if (active()) setDetectionState("running");
    } catch (e) { if (active()) fail(message(e)); }
  };
  const startTracking = async () => {
    if (!canTrack || !savedCamera || !video.current || !scene?.navigation) return;
    stopTracking(); setError(""); setStarting(true); const generation = ++runGeneration.current;
    const camera = savedCamera;
    let session: ActiveStream | undefined;
    try {
      const result = await trackingApi.start(jobId, camera.id, requestAbort.current.signal);
      session = { jobId, camera, streamId: result.streamId, sequence: 0, abort: new AbortController(), busy: false, lastQueuedAt: 0 };
      if (!mounted.current || generation !== runGeneration.current) { void trackingApi.stop(jobId, camera.id, result.streamId).catch(() => {}); return; }
      activeStream.current = session; tracker.current.reset();
      setTracking(true); setStarting(false); setStatus("Live human positions appear in the room on the right. Open the separate viewer to walk around them.");
    } catch (e) { if (mounted.current && generation === runGeneration.current) { stopTracking(); if (!ignoredAbort(e)) setError(message(e)); } else if (session) void trackingApi.stop(jobId, camera.id, session.streamId).catch(() => {}); }
  };

  if (!jobId) return <main className="room-tracking" hidden={!active}><header className="room-tracking-heading"><div><p className="eyebrow">Live camera tracking</p><h1>Choose a room</h1><p>Select a saved room to configure its cameras.</p><a className="room-link-button" href="#rooms">Open room library</a></div></header>{error && <p className="room-error" role="alert">{error}</p>}{roomLoading ? <p role="status">Loading rooms...</p> : availableRooms.length ? <div className="room-camera-room-list">{availableRooms.map(job => <a key={job.id} className="room-link-button" href={`#room-tracking?job=${encodeURIComponent(job.id)}`}>{job.name}</a>)}</div> : <p className="room-help">Save a room's scale and floor in the room library first.</p>}</main>;
  return <main className="room-tracking" hidden={!active}>
    <header className="room-tracking-heading"><div><p className="eyebrow">Live camera tracking</p><h1>{roomName}</h1><p>Locate a fixed camera once. People are then recognized and positioned automatically, without manual human tags.</p></div>
      <div className="room-tracking-actions"><a className="room-link-button" href={`#room-viewer?job=${encodeURIComponent(jobId)}`}>Open viewer</a><a className="room-link-button" href={`#room-viewer?job=${encodeURIComponent(jobId)}`} target="_blank" rel="noopener">Open viewer in new tab</a><a href={`#rooms?job=${encodeURIComponent(jobId)}`}>Edit room setup</a></div></header>
    {error && <p className="room-error" role="alert">{error}</p>}
    <ol className="room-camera-guide" aria-label="Camera setup steps"><li data-active={guidedStep === 1}><span>1</span><div><strong>Start camera</strong><small>People are detected automatically in the video.</small></div></li><li data-active={guidedStep === 2}><span>2</span><div><strong>Automatically locate camera</strong><small>Match its static room background to the reconstruction.</small></div></li><li data-active={guidedStep === 3}><span>3</span><div><strong>People move in 3D</strong><small>Floor positions and body-depth estimates are labelled separately.</small></div></li></ol>
    <div className="room-tracking-layout">
      <section className="room-tracking-camera">
        <h2>Camera and automatic person detection</h2>
        <div className="room-tracking-settings"><label>Camera configuration<select value={selectedId ?? ""} disabled={tracking || starting || saveBusy || alignmentBusy} onChange={event => selectCamera(event.target.value)}><option value="">New camera</option>{saved.map(camera => <option key={camera.id} value={camera.id}>{camera.name}{camera.sceneVersion !== scene?.version ? " (needs recalibration)" : ""}</option>)}</select></label>
          <label>Name<input value={name} maxLength={80} disabled={tracking || starting || saveBusy || alignmentBusy} onChange={event => setName(event.target.value)} /></label>
          <label>Video source<select value={deviceId} disabled={captureBusy || tracking || starting || saveBusy || alignmentBusy} onChange={event => { stopCamera(); setDeviceId(event.target.value); setInvalidCalibration(true); changePoints([]); }}><option value="">Default camera</option>{devices.map((device, i) => <option key={device.deviceId || i} value={device.deviceId}>{device.label || `Camera ${i + 1}`}</option>)}{deviceId && !devices.some(device => device.deviceId === deviceId) && <option value={deviceId}>Previously selected camera</option>}</select></label></div>
        <div className="room-tracking-actions"><button className="primary" disabled={roomLoading || !scene || captureBusy || cameraRunning} onClick={() => void startCamera()}>{captureBusy ? "Starting camera..." : "Start camera"}</button><button disabled={!cameraRunning && !captureBusy} onClick={() => { stopCamera(); setStatus("Camera stopped. Live markers expire automatically."); }}>Stop camera</button></div>
        <div className="room-detection-status" data-state={detectionState} data-health={detectionHealth?.status} role="status">{detectionState === "loading" ? "Loading automatic person detection..." : detectionState === "running" ? detectionHealth?.status === "stale" ? "Detection is too slow for live positions. Waiting for fresh results." : `Automatic detection on · ${detectedCount} human${detectedCount === 1 ? "" : "s"} detected` : detectionState === "paused" ? "Detection is paused while matching the camera to the room." : detectionState === "failed" ? `Person detection could not run: ${detectionError}` : "Start camera to detect people automatically."}{detectionState === "failed" && cameraRunning && !frozen && <button onClick={() => void startPreview()}>Retry detection</button>}</div>
        {detectionState === "running" && <p className="room-help">{detectionHealth?.status === "stale" ? `The last result took ${(detectionHealth.inferenceMs / 1000).toFixed(1)}s. Old detections and markers are hidden. Stop heavy tasks or use a faster device; fresh results resume automatically.` : lastDetectionAt.current ? `Last analyzed camera frame ${Math.max(0, (progressClock - lastDetectionAt.current) / 1000).toFixed(1)}s ago${detectionHealth ? ` · ${(detectionHealth.inferenceMs / 1000).toFixed(2)}s processing time` : ""}. Person detection runs continuously; it has no completion percentage.` : "Waiting for the first analyzed camera frame."}</p>}
        <div className={`room-camera-frame${frozen ? " is-calibrating" : ""}`} style={{ aspectRatio: size ? `${size.width}/${size.height}` : "16/9" }} onClick={pickImage}>
          <video ref={video} autoPlay playsInline muted className={frozen ? "room-camera-hidden" : ""} aria-label="Live camera, unmirrored" />
          {frozen && <img src={frozen} alt="Frozen calibration frame; click a floor reference point" draggable={false} />}
          <canvas ref={overlay} className="room-camera-overlay" aria-hidden="true" />
          {!cameraRunning && <p className="room-camera-placeholder">Start the camera to see its image. Camera permission is requested only when you press Start.</p>}
          {frozen && <div className="room-camera-points" aria-hidden="true">{points.map((pair, i) => <span key={i} style={{ left: `${pair.image.x * 100}%`, top: `${pair.image.y * 100}%` }}>{i + 1}</span>)}{pending && <span className="pending" style={{ left: `${pending.x * 100}%`, top: `${pending.y * 100}%` }}>{points.length + 1}</span>}</div>}
        </div>
        <p className="room-help">{size ? `${size.width} × ${size.height} · ` : ""}Live person detection runs in this browser. “Human detected” confirms recognition in the image; a calibrated camera provides room positions. Open viewer keeps this camera running.</p>
        <div className="room-camera-auto-alignment"><div className="room-camera-step-action"><div><h3>Automatically locate camera</h3><p>Keep the camera fixed and show static background from this reconstructed room. Once located, human positions start automatically.</p></div><button className="primary" disabled={!cameraRunning || !!frozen || !scene || !name.trim() || alignmentBusy || saveBusy || starting} onClick={() => void locateCamera()}>{alignmentBusy ? "Locating camera..." : savedCamera?.geometry ? "Locate camera again" : "Automatically locate camera"}</button></div>
          <p className="room-alignment-privacy">Pressing this button sends one resized camera JPEG to the local room service for alignment. That temporary frame is deleted after processing or expiry. Continuous video frames are not uploaded.</p>
          {alignmentBusy && <div className="room-alignment-progress" role="status"><progress aria-label="Current camera alignment step" max={100} value={alignmentPercent} /><div><strong>{alignment?.state === "QUEUED" ? "Waiting for the camera localizer" : alignmentStep >= 0 ? `Step ${alignmentStep + 1} of ${alignmentSteps.length} · ${alignmentStageLabel(alignment?.stage || "")}` : "Locating camera in the room"}</strong><span>{alignment ? `${duration(alignmentElapsed)} elapsed${measuredProgress?.startedAt ? ` · ${duration(stageElapsed)} in this step` : ""}` : "Sending one camera frame"}</span>{measuredProgress?.total && measuredProgress.completed !== undefined ? <span>{measuredProgress.completed.toLocaleString()} / {measuredProgress.total.toLocaleString()} {measuredProgress.unit}{alignmentPercent !== undefined ? ` · ${alignmentPercent.toFixed(0)}% of this step` : ""}</span> : <span>{measuredProgress?.activity || "Processing this step; its percentage is not available."}</span>}{alignment && alignmentElapsed > 20 && <span>Keep the camera fixed. You can stay on this page while background matching runs.</span>}</div><button onClick={() => stopAlignment(true)}>Stop alignment</button><ol className="room-alignment-steps" aria-label="Camera alignment steps">{alignmentSteps.map((step, index) => <li key={step} data-state={index < alignmentStep ? "done" : index === alignmentStep ? "current" : "waiting"}>{index < alignmentStep ? "✓ " : ""}{alignmentStageLabel(step)}</li>)}</ol></div>}
          {alignment && !alignmentBusy && <p className={alignment.state === "APPLIED" ? "room-success" : alignment.state === "FAILED" ? "room-notice" : "room-help"} role="status">{alignment.state === "APPLIED" ? "Camera located. Automatic room positioning is available." : alignment.state === "CANCELLED" ? "Camera alignment stopped. No result will start tracking." : alignment.error || alignmentStageLabel(alignment.stage)}</p>}
          {alignment?.state === "FAILED" && !alignmentBusy && <p className="room-help">Leave the camera fixed, step out of its view, and retry with the room background unobstructed. Show textured furniture or wall details present in the original capture; changing screen contents and people cannot anchor the camera. After alignment, return to the view. Keep feet visible for floor-based positions; hidden feet require a usable body-depth estimate.</p>}
          {!cameraRunning && <p className="room-help">Start the camera to locate it in the room.</p>}{frozen && <p className="room-help">Finish manual calibration or return to automatic alignment below.</p>}
        </div>
        <p className="room-camera-next-action" role="status">{nextAction}</p>
        <details className="room-manual-calibration" open={!!frozen}><summary>Manual camera calibration (fallback)</summary><p className="room-help">Use this if automatic camera alignment cannot match enough room background. These points calibrate the camera, not a person. This fallback locates visible feet on the floor; body-depth estimates need automatic camera geometry.</p><div className="room-tracking-actions"><button disabled={!cameraRunning || saveBusy || starting || alignmentBusy} onClick={freezeFrame}>{frozen ? "Take a new frame" : savedCamera ? "Match camera again" : "Match camera to room"}</button>{frozen && <button disabled={saveBusy} onClick={() => { calibrationMode.current = false; setFrozen(null); clearPending(); changePoints(savedCamera?.points ?? []); setFixedConfirmed(false); renderer.current?.setTool("review"); void startPreview(); }}>Return to automatic alignment</button>}</div>
        {frozen && <div className="room-tracking-calibration"><h2>Match the floor</h2><ol><li>Click a visible landmark on the real floor in the frozen image.</li><li>Click the same landmark on the floor in the 3D room.</li><li>Add at least four widely spaced pairs, covering the area where people will walk.</li></ol><p className="room-counter">{points.length} / 16 reference pairs{pending ? " · waiting for room point" : ""}</p>
          <div className="room-tracking-actions"><button disabled={!points.length && !pending || saveBusy} onClick={() => { if (pendingImage.current) clearPending(); else changePoints(points.slice(0, -1)); }}>Undo last point</button><button disabled={!points.length && !pending || saveBusy} onClick={() => { changePoints([]); clearPending(); }}>Clear pairs</button></div>
          {fit && <p className="room-success">Fit residual: {(fit.fitErrorMeters * 100).toFixed(1)} cm. {points.length === 4 ? "Four pairs define the projection exactly; add a fifth or more for a consistency check." : "This measures reference consistency, not physical accuracy."}</p>}{fitError && <p className="room-error">{fitError}</p>}
          {!!points.length && <div className="room-camera-pair-list">{points.map((pair, i) => <span key={i}>#{i + 1} · X {pair.world.x.toFixed(2)} m, Z {pair.world.z.toFixed(2)} m</span>)}</div>}
          <button className="primary" disabled={!fit || !!pending || !name.trim() || saveBusy} onClick={() => void saveCalibration()}>{saveBusy ? "Saving..." : "Save camera position"}</button></div>}</details>
          {!frozen && <div className="room-tracking-controls"><h2>Display humans in the room</h2>
            {savedCamera && <p className="room-help">Saved camera · room version {savedCamera.sceneVersion} · {savedCamera.geometry ? `automatically aligned with ${savedCamera.geometry.inliers} background matches; ${savedCamera.geometry.reprojectionErrorPx.toFixed(1)} px reprojection error` : `manual floor calibration; ${(savedCamera.fitErrorMeters * 100).toFixed(1)} cm reference fit residual (not physical accuracy)`}</p>}
            {cameraRunning && savedCamera && (!dimensionsMatch || invalidCalibration || savedCamera.sceneVersion !== scene?.version) && <p className="room-notice">The camera source, frame size or room setup changed. Recalibrate before tracking.</p>}
            {cameraRunning && calibrationUsable && <label className="room-tracking-confirm"><input type="checkbox" checked={fixedConfirmed} disabled={tracking || starting || alignmentBusy} onChange={event => {
              const checked = event.target.checked; setFixedConfirmed(checked);
              if (checked && savedCamera) autoPublish.current = { id: savedCamera.id, revision: savedCamera.revision };
              else stopTracking();
            }} /><span>Confirm this is the saved camera, still fixed in the same position, with the same zoom and crop, to start live room positions automatically.</span></label>}
            <div className="room-tracking-actions"><button className="primary" disabled={!canTrack || tracking || starting} onClick={() => void startTracking()}>{starting ? "Connecting room positions..." : "Display humans in 3D"}</button><button disabled={!tracking && !starting && !autoPublish.current} onClick={() => { stopTracking(); setStatus("3D positions stopped. Automatic person detection continues in the camera image."); }}>Stop 3D positions</button></div>
            <p aria-live="polite" className="room-tracking-count">{tracking ? `${detectedCount} detected in video · ${floorCount} floor-based · ${estimatedCount} estimated position${estimatedCount === 1 ? "" : "s"}` : detectionState === "running" ? `${detectedCount} detected in video · 3D positions are not enabled` : "3D positions are not enabled"}</p>
            {positionMessage && tracking ? <p className="room-position-reason" role="status">{positionMessage}</p> : detectedCount > 0 && <p className="room-help">{!calibrationUsable ? "People are recognized automatically. Locate the camera once to place them in the room; you never need to tag a human." : !tracking ? "People are recognized in the image. Confirm the fixed camera or display humans in 3D to enable automatic room positions." : "Waiting for usable body landmarks to locate this person."}{!feetVisible && !savedCamera?.geometry ? " Feet are not reliably visible; manual floor calibration needs visible feet, or use automatic camera alignment for body-depth estimates." : ""}</p>}
            {people.length > 0 && <ul className="room-tracking-people">{people.map(person => <li key={person.id} data-estimated={person.positionMethod === "estimated"}><strong>Human {person.id}</strong><span>{person.positionMethod === "estimated" ? `Estimated +/- ${(person.uncertaintyMeters ?? 0).toFixed(1)} m · ` : "Floor-based · "}X {person.position.x.toFixed(2)} m · Z {person.position.z.toFixed(2)} m</span></li>)}</ul>}
          </div>}
      </section>
      <section className="room-tracking-map"><h2>{frozen ? `Select matching room point ${points.length + 1}` : tracking ? "Live human positions in your room" : "Your room and camera placement"}</h2><p className="room-help">{frozen ? pending ? "Click the room floor at the image landmark. Drag to rotate; scroll to zoom." : "Select the image landmark first. Keep your current view, or choose Top view below to locate the floor." : tracking ? "Green markers use visible feet on the floor. Amber markers estimate body depth and show an uncertainty radius." : "Automatically locate the camera once. Human markers then follow detections here and in the room viewer without manual tags."}</p>
        {!frozen && <div className="room-camera-location" data-state={alignmentBusy ? "locating" : cameraNeedsAlignment ? "unlocated" : "located"} role="status"><strong>{cameraPositionTitle}</strong><p>{cameraPositionHelp}</p>{savedCamera?.geometry && savedCamera.sceneVersion === scene?.version && <><span>{savedCamera.name}: X {savedCamera.geometry.center.x.toFixed(2)} m · Y {savedCamera.geometry.center.y.toFixed(2)} m · Z {savedCamera.geometry.center.z.toFixed(2)} m</span><small>The camera marker and view direction show the saved alignment. {cameraNeedsAlignment ? "This alignment must be updated for the current source." : "Keep the real camera at this position with the same zoom and crop."}</small></>}</div>}
        <div className="room-view room-tracking-view" ref={host} />
        <div className="room-tracking-actions"><button disabled={!scene || roomLoading} onClick={() => renderer.current?.topView()}>Top view</button><button disabled={!scene || roomLoading} onClick={() => renderer.current?.resetView()}>Reset view</button><button disabled={!people.length} onClick={() => { if (renderer.current?.focusPeople()) setStatus("Showing current human positions in the room."); }}>Find humans</button><label><input type="checkbox" checked={collision} disabled={!scene} onChange={event => { setCollision(event.target.checked); renderer.current?.showCollision(event.target.checked); }} /> Show surfaces</label></div>
        <p className="room-tracking-status" role="status">{status}</p>
        <details className="room-tracking-notes"><summary>Placement and accuracy</summary><p>Show static room background so automatic alignment can locate the fixed camera. If that fails, the optional manual fallback matches floor landmarks such as tile corners; furniture tops and wall points cannot calibrate the floor.</p><p>Visible feet provide a floor-based position. When feet are hidden, automatic camera geometry can estimate depth from shoulders or facial landmarks using assumed adult body dimensions. These amber estimates have uncertainty and may be unavailable when the body is too cropped or ambiguous. Children, unusual body proportions and tilted poses can reduce accuracy.</p><p>Keep the camera fixed. Moving it, changing zoom or crop, or editing room setup requires recalibration. Background-match residuals measure alignment consistency, not the physical accuracy of a person's position.</p><p>Labels identify temporary anonymous tracks, not a person's identity. Each camera has separate tracks; the system does not recognize identity or merge people across cameras.</p></details>
      </section>
    </div>
  </main>;
}
