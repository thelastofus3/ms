import { useEffect, useRef, useState } from "react";
import * as api from "./api";
import { RoomRenderer } from "./renderer";
import type { Job, RoomManifest } from "./types";
import * as trackingApi from "./tracking/api";
import type { CameraCalibration, LiveCameraState, TrackingSnapshot, WorldPerson } from "./tracking/types";
import "./style.css";
import "./viewer.css";

export function RoomViewer({ jobId, localCamera, stopCamera }: { jobId: string; localCamera?: LiveCameraState | null; stopCamera?: () => void }) {
  const container = useRef<HTMLElement>(null), host = useRef<HTMLDivElement>(null), renderer = useRef<RoomRenderer | undefined>(undefined);
  const [room, setRoom] = useState<Job | null>(null), [scene, setScene] = useState<RoomManifest | null>(null), [rooms, setRooms] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [status, setStatus] = useState("Opening your room…");
  const [walking, setWalking] = useState(false), [fullscreen, setFullscreen] = useState(false), [live, setLive] = useState(true);
  const [people, setPeople] = useState<WorldPerson[]>([]), [cameraCount, setCameraCount] = useState(0), [trackingError, setTrackingError] = useState("");
  const [cameras, setCameras] = useState<CameraCalibration[]>([]), [referenceCamera, setReferenceCamera] = useState("");
  const [showReferences, setShowReferences] = useState(true);
  const [showCameraPositions, setShowCameraPositions] = useState(true);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const view = jobId && host.current ? new RoomRenderer(host.current) : undefined;
    renderer.current = view;
    if (view) view.onStatus = setStatus;
    const load = async () => {
      try {
        if (!jobId) { const list = await api.jobs(controller.signal); if (active) setRooms(list.filter(job => job.state === "READY" && job.manifestUrl)); return; }
        const job = await api.job(jobId);
        if (!active) return;
        setRoom(job);
        if (!job.manifestUrl) throw Error("This room is still reconstructing. Open its setup page to see progress.");
        const manifest = await api.manifest(job.manifestUrl);
        if (!active) return;
        if (!manifest.ready) throw Error("Finish the room scale, floor and walking-area setup before opening the viewer.");
        await view!.load(manifest);
        if (!active) return;
        view!.setTool("review"); setScene(manifest); setStatus("Room ready. Start walking or explore from above.");
      } catch (e) { if (active) setError(e instanceof Error ? e.message : String(e)); }
      finally { if (active) setLoading(false); }
    };
    void load();
    const changed = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener("fullscreenchange", changed);
    return () => { active = false; controller.abort(); document.removeEventListener("fullscreenchange", changed); view?.dispose(); renderer.current = undefined; };
  }, [jobId]);
  useEffect(() => {
    setCameras([]);
    if (!scene) return;
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const configs = await trackingApi.cameras(jobId, controller.signal);
        if (!active) return;
        const current = configs.filter(camera => camera.sceneVersion === scene.version);
        setCameras(current);
        setReferenceCamera(selected => current.some(camera => camera.id === selected && camera.points.length) ? selected : current.find(camera => camera.points.length)?.id ?? "");
      } catch { /* Live snapshot errors are displayed separately. */ }
      finally { if (active) timer = setTimeout(() => void refresh(), 5000); }
    };
    void refresh();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [jobId, scene, localCamera?.calibrationUsable]);
  useEffect(() => {
    renderer.current?.setTrackingCameras(showCameraPositions ? cameras : []);
  }, [cameras, scene, showCameraPositions]);
  useEffect(() => {
    renderer.current?.markFloorReferences(showReferences ? cameras.find(camera => camera.id === referenceCamera)?.points.map(pair => pair.world) ?? [] : []);
  }, [cameras, referenceCamera, showReferences, scene]);
  useEffect(() => {
    renderer.current?.setPeople([]); setPeople([]); setCameraCount(0); setTrackingError("");
    if (!scene || !live) return;
    let active = true, timer: ReturnType<typeof setTimeout> | undefined, lastSuccess = Date.now();
    const controller = new AbortController();
    const poll = async () => {
      const started = Date.now();
      try {
        const snapshot = await api.request<TrackingSnapshot>(`/v1/rooms/jobs/${jobId}/tracking?sceneVersion=${scene.version}`, undefined, controller.signal);
        if (!active) return;
        const now = Date.now(), delay = now - started;
        const observations: WorldPerson[] = snapshot.cameras.flatMap(camera => camera.people.map(person => ({
          id: `${camera.cameraId}:${camera.streamId}:${person.id}`, label: `Human ${person.id} - ${camera.name}${person.positionMethod === "estimated" ? ` - Estimated +/- ${(person.uncertaintyMeters ?? 0).toFixed(1)} m` : ""}`,
          position: person.position, confidence: person.confidence, expiresAt: now + Math.max(0, 1500 - camera.ageMs - delay),
          positionMethod: person.positionMethod, uncertaintyMeters: person.uncertaintyMeters,
        }))).filter(person => person.expiresAt > now);
        renderer.current?.setPeople(observations); setPeople(observations); setCameraCount(snapshot.cameras.length); setTrackingError(""); lastSuccess = now;
      } catch (e) { if (active) { renderer.current?.setPeople([]); setPeople([]); setCameraCount(0); setTrackingError(e instanceof Error ? e.message : String(e)); } }
      finally { if (active) timer = setTimeout(() => void poll(), 250); }
    };
    void poll();
    const expiry = setInterval(() => {
      setPeople(current => current.some(person => person.expiresAt <= Date.now()) ? current.filter(person => person.expiresAt > Date.now()) : current);
      if (Date.now() - lastSuccess >= 1500) setCameraCount(0);
    }, 200);
    return () => { active = false; controller.abort(); clearTimeout(timer); clearInterval(expiry); renderer.current?.setPeople([]); };
  }, [scene, live, jobId]);
  const walk = async () => {
    try { setError(""); await renderer.current?.walk(); setWalking(true); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const inspect = () => { renderer.current?.inspect(); setWalking(false); };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === container.current) await document.exitFullscreen();
      else { if (document.pointerLockElement) document.exitPointerLock(); await container.current?.requestFullscreen(); }
    } catch (e) { setError(e instanceof Error ? e.message : "Fullscreen is unavailable in this browser."); }
  };
  const local = localCamera?.jobId === jobId ? localCamera : null;
  const estimatedCount = people.filter(person => person.positionMethod === "estimated").length;
  const referenceCameras = cameras.filter(camera => camera.points.length > 0);
  const liveStatus = !live ? "Live markers are hidden. Camera capture continues until you stop it."
    : people.length ? `${people.length - estimatedCount} floor-based position${people.length - estimatedCount === 1 ? "" : "s"} and ${estimatedCount} body-depth estimate${estimatedCount === 1 ? "" : "s"}. Amber estimates include an uncertainty radius. Use Find humans to bring markers into view.`
    : local?.cameraRunning ? local.error ? local.error
      : local.detectionState === "failed" ? "Person detection stopped. Open camera controls to retry."
      : local.detectionState === "paused" ? "Manual camera calibration is in progress. Save the floor matches or return to automatic camera alignment."
      : local.positionMessage ? local.positionMessage
      : !local.calibrationUsable ? "People are recognized automatically. Open Camera controls and automatically locate this camera once to display room positions."
      : !local.fixedConfirmed ? "Confirm that the saved camera has not moved in Camera controls."
      : local.starting || local.detectionState === "loading" ? "Starting live person tracking..."
      : !local.tracking ? "Camera is on, but 3D tracking is stopped. Enable it in Camera controls."
      : Date.now() - local.lastDetectionAt >= 1500 ? "Waiting for a fresh camera frame. Old positions have expired."
      : !local.detectedCount ? "Camera tracking is live. No person is detected in the video."
      : "Human detected, but no usable room position is available. Camera controls show the positioning reason."
    : cameraCount ? "A camera is live, but has no usable human positions yet. Open its Camera controls to see the positioning reason."
    : cameras.length ? "Camera calibration is saved. Start its camera and confirm it is still fixed to display live human positions."
    : "Connect and automatically locate a fixed camera to display live human positions.";
  if (!jobId) return <main className="room-studio room-viewer-library"><header className="room-heading"><div><p className="eyebrow">ROOM VIEWER</p><h1>Explore a room</h1><p>Choose a calibrated room to walk through it in fullscreen.</p></div></header>
    {loading && <p role="status">Loading your rooms…</p>}{error && <p className="room-error" role="alert">{error}</p>}
    <div className="room-viewer-choices">{rooms.map(job => <a key={job.id} href={`#room-viewer?job=${job.id}`}><strong>{job.name}</strong><span>Open viewer →</span></a>)}</div>
    {!loading && !rooms.length && <p>No calibrated rooms yet. <a href="#rooms">Open room reconstruction</a> to finish setup.</p>}
  </main>;
  return <main className="room-studio room-viewer-page">
    <header className="room-viewer-heading"><div><p className="eyebrow">ROOM VIEWER</p><h1>{room?.name || "Your room"}</h1><p>WASD to move · Mouse to look · Escape releases the mouse</p></div><div className="room-tool-actions"><a href={`#rooms?job=${jobId}`}>Edit room setup</a><a href={`#room-tracking?job=${jobId}`}>Set up live cameras</a></div></header>
    <section className="room-explorer" ref={container} aria-label="Room walking viewer">
      <div className="room-explorer-canvas" ref={host} />
      <div className="room-explorer-toolbar">
        <div className="room-tool-actions"><button className="room-primary" disabled={loading || !scene} onClick={() => void walk()}>{walking ? "Restart at start point" : "Start walking"}</button><button disabled={!scene} onClick={inspect}>Orbit view</button><button disabled={!scene} onClick={() => { inspect(); renderer.current?.topView(); }}>Top view</button><button disabled={!scene} onClick={() => { inspect(); renderer.current?.resetView(); }}>Reset view</button><button disabled={!people.length} onClick={() => { if (renderer.current?.focusPeople()) { setWalking(false); setStatus("Showing current human positions."); } }}>Find humans</button></div>
        <button disabled={!document.fullscreenEnabled} onClick={() => void toggleFullscreen()}>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</button>
      </div>
      <div className="room-explorer-status" role="status">{loading ? "Downloading reconstructed room…" : status}</div>
      {error && <p className="room-error room-explorer-error" role="alert">{error} <a href={`#rooms?job=${jobId}`}>Open setup</a></p>}
      <div className="room-explorer-live"><label><input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} /> Live human markers</label>{scene && <span>{people.length - estimatedCount} floor-based · {estimatedCount} estimated · {cameraCount} active camera{cameraCount === 1 ? "" : "s"}</span>}{live && !cameraCount && !loading && <a href={`#room-tracking?job=${jobId}`}>{cameras.length ? "Camera controls" : "Connect a camera"}</a>}</div>
    </section>
    {trackingError && live && <p className="room-help" role="status">Live tracking unavailable: {trackingError}</p>}
    {!loading && scene && <div className="room-viewer-camera-status" role="status"><p>{liveStatus}</p><a href={`#room-tracking?job=${jobId}`}>Camera controls</a>{local?.cameraRunning && stopCamera && <button onClick={stopCamera}>Stop camera</button>}</div>}
    {cameras.some(camera => camera.geometry) && <div className="room-viewer-reference-controls"><label><input type="checkbox" checked={showCameraPositions} onChange={e => setShowCameraPositions(e.target.checked)} /> Show camera positions</label><span>Blue cameras show their saved location and viewing direction. Green and amber markers show people.</span></div>}
    {!!referenceCameras.length && <div className="room-viewer-reference-controls"><label><input type="checkbox" checked={showReferences} onChange={e => setShowReferences(e.target.checked)} /> Show manual camera floor matches</label>{referenceCameras.length > 1 && <select aria-label="Camera floor matches" value={referenceCamera} onChange={e => setReferenceCamera(e.target.value)}>{referenceCameras.map(camera => <option key={camera.id} value={camera.id}>{camera.name}</option>)}</select>}<span>The gold reference points calibrate a camera. They do not mark a person.</span></div>}
    <p className="room-help">Your started camera keeps tracking while you use this viewer. Green markers use visible feet on the floor; amber body-depth estimates use assumed adult body dimensions and show uncertainty. Labels are anonymous tracks, not identity recognition. Stop camera or close this tab to end capture; stale detections disappear automatically.</p>
  </main>;
}
