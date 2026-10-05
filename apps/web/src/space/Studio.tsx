import { useEffect, useRef, useState } from "react";
import * as api from "./api";
import { RoomRenderer } from "./renderer";
import type { Calibration, CalibrationTool, Job, LiveProgress, Point, RoomManifest } from "./types";
import { CalibrationPanel } from "./CalibrationPanel";
import { calibrationFromManifest, distance, draftKey, floorFrame, freshCalibration as fresh, point, projectToFloor, readDraft, setFloorHeightAt, vector } from "./calibration";
import "./style.css";

const stages = [
  ["preprocessing", "Prepare frames"], ["poses", "Estimate cameras"], ["geometry", "Reconstruct surfaces"],
  ["training", "Train Gaussian Splats"], ["export", "Export scene"], ["optimization", "Compress scene"],
  ["validation", "Package scene"], ["publication", "Save results"],
] as const;
const stateLabels: Record<string, string> = { QUEUED: "Queued", RUNNING: "Reconstructing", NEEDS_CALIBRATION: "Set scale & floor", NEEDS_REVIEW: "Needs review", READY: "Ready to explore", FAILED: "Failed", CANCELLED: "Cancelled" };
const stateLabel = (state: string) => stateLabels[state] ?? state.replaceAll("_", " ").toLowerCase();
const stepLabel = (stage: string) => stages.find(([key]) => key === stage)?.[1] ?? stage;
function JobProgress({ job }: { job: Job }) {
  const current = stages.findIndex(([key]) => key === job.stage);
  const finished = ["NEEDS_CALIBRATION", "READY"].includes(job.state);
  const observation = job.diagnostics?.liveProgress as LiveProgress | undefined;
  const live = observation?.stage === job.stage ? observation : undefined;
  const percent = live ? live.percent : job.progress > 0 ? job.progress : null;
  const duration = (seconds: number) => `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const counter = (value: number) => live?.unit?.startsWith("bytes") ? `${(value / (1024 * 1024)).toFixed(1)} MiB` : value.toLocaleString();
  return <div className="room-job-progress" aria-live="polite">
    {job.state === "QUEUED" && <p>Capture saved. Waiting for a GPU worker to claim this job.</p>}
    {job.state === "RUNNING" && <><p><strong>{stages[current]?.[1] || job.stage}</strong> · Step {Math.max(1, current + 1)} of {stages.length}</p>
      <progress max={100} value={percent ?? undefined} aria-label={`${live?.label || stages[current]?.[1] || job.stage} progress`} />
      {live ? <><p><strong>{live.label}{percent !== null ? ` · ${percent}%` : ""}</strong>{live.total ? ` · ${counter(live.completed ?? 0)} / ${counter(live.total)} ${live.unit?.replace(/^bytes /, "") ?? ""}` : ""}</p>
        <p>{live.activity} · Elapsed: {duration(live.elapsedSeconds)}</p>
        {percent === null && <p className="room-help">This operation does not expose a measurable completion percentage.</p>}
        {live.label === "Camera coverage" && <p className="room-help">Coverage of the current camera solution; it can change as different candidates are tried. It does not measure time remaining.</p>}
        {percent !== null && live.label !== "Camera coverage" && <p className="room-help">Percentage measures the current operation. It starts again when the next operation begins.</p>}
        {live.quietSeconds >= 30 && <p className="room-help">No new tool output for {duration(live.quietSeconds)}. The worker may be computing between updates.</p>}</>
        : <p>{job.progress > 0 ? `${job.progress}% of this step` : "Processing. Waiting for the tool's first progress report…"}</p>}
    </>}
    <details className="room-stage-details"><summary>All reconstruction steps</summary><ol className="room-stage-list">{stages.map(([key, label], index) => <li key={key} className={finished || (current >= 0 && index < current) ? "done" : job.state === "RUNNING" && index === current ? "active" : ""}>
      {finished || (current >= 0 && index < current) ? "✓ " : ""}{label}
    </li>)}</ol></details>
    {finished && <p>Reconstruction complete. Open the room to set its scale and walking area.</p>}
  </div>;
}
export function RoomStudio() {
  const host = useRef<HTMLDivElement>(null), viewer = useRef<RoomRenderer | undefined>(undefined), uploadController = useRef<AbortController | undefined>(undefined);
  const [allJobs, setJobs] = useState<Job[]>([]), [selected, setSelected] = useState<string | null>(null), [scene, setScene] = useState<RoomManifest | null>(null);
  const [files, setFiles] = useState<File[]>([]), [name, setName] = useState("My room"), [profile, setProfile] = useState("local");
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [uploadPercent, setUploadPercent] = useState(0), [error, setError] = useState("");
  const [status, setStatus] = useState("Upload a room capture to begin."), [overlay, setOverlay] = useState(false);
  const [calibration, setCalibrationState] = useState<Calibration>(fresh), [selection, setSelection] = useState<CalibrationTool>("floor"), [pendingBox, setPendingBox] = useState<Point | null>(null);
  const [pointTarget, setPointTarget] = useState<number | null>(null), [canUndo, setCanUndo] = useState(false), [draftSaved, setDraftSaved] = useState(false);
  const [floorGrid, setFloorGrid] = useState(true);
  const [service, setService] = useState("Connecting to the room service…"), [uploadPhase, setUploadPhase] = useState(""), [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [panel, setPanel] = useState<"library" | "capture">("library"), [query, setQuery] = useState(""), [filter, setFilter] = useState("all");
  const selectionRef = useRef(selection), loadGeneration = useRef(0), pendingBoxRef = useRef<Point | null>(null), targetRef = useRef(pointTarget), sceneRef = useRef(scene);
  const calibrationRef = useRef(calibration), history = useRef<Calibration[]>([]), baseline = useRef("");
  const setCalibration = (change: Calibration | ((current: Calibration) => Calibration), remember = true) => {
    const previous = calibrationRef.current;
    let next: Calibration;
    try { next = typeof change === "function" ? change(previous) : change; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
    if (next === previous) return;
    setError("");
    if (remember) { history.current = [...history.current.slice(-49), previous]; setCanUndo(true); }
    calibrationRef.current = next; setCalibrationState(next);
    return true;
  };
  selectionRef.current = selection;
  targetRef.current = pointTarget; sceneRef.current = scene;
  const dirty = !!scene && JSON.stringify(calibration) !== baseline.current;
  const selectedJob = allJobs.find(job => job.id === selected);
  const visibleJobs = allJobs.filter(job => job.name.toLowerCase().includes(query.trim().toLowerCase()) && (
    filter === "all" || filter === "active" && ["QUEUED", "RUNNING"].includes(job.state) ||
    filter === "calibrate" && ["NEEDS_CALIBRATION", "NEEDS_REVIEW"].includes(job.state) ||
    filter === "ready" && job.state === "READY" || filter === "issues" && ["FAILED", "CANCELLED"].includes(job.state)));
  const activeCount = allJobs.filter(job => ["QUEUED", "RUNNING"].includes(job.state)).length;
  const initialList = useRef(true);
  const reconstructionKeys = useRef(new Map<string, string>());
  useEffect(() => {
    const v = new RoomRenderer(host.current!); viewer.current = v; v.onStatus = setStatus;
    v.onPick = picked => {
      const mode = selectionRef.current;
      if (mode === "review") return;
      if (mode === "floor-height") {
        const manifest = sceneRef.current;
        if (manifest && setCalibration(c => setFloorHeightAt(c, manifest, picked))) {
          setSelection("floor"); setPointTarget(null);
          setStatus("Floor level moved onto the selected surface. The walking area and start marker follow it.");
        }
        return;
      }
      if (mode === "obstacle" || mode === "dimension") {
        const previous = pendingBoxRef.current;
        if (previous && distance(previous, picked) < 1e-6) { setStatus("Choose a different second endpoint."); return; }
        pendingBoxRef.current = previous ? null : picked;
        setPendingBox(pendingBoxRef.current);
        if (previous) setCalibration(c => mode === "dimension" ? { ...c, dimensions: [...c.dimensions ?? [], { id: crypto.randomUUID(), name: `Dimension ${(c.dimensions?.length ?? 0) + 1}`, a: previous, b: picked }] } : { ...c, reviewed: false, obstacles: [...c.obstacles, { a: previous, b: picked }] });
      } else setCalibration(c => {
        if (mode === "spawn") return { ...c, reviewed: false, spawn: picked };
        const limit = mode === "measurement" ? 2 : mode === "floor" ? 3 : 128;
        const current = c[mode];
        if (targetRef.current === null && current.length >= limit) { setStatus("Choose a numbered endpoint to adjust it, or clear this tool to start again."); return c; }
        const index = Math.min(targetRef.current ?? current.length, current.length);
        const values = [...current]; values[index] = picked;
        if (mode === "floor" || mode === "measurement") setPointTarget(values.length < limit ? values.length : null);
        else setPointTarget(null);
        const next = { ...c, reviewed: false, [mode]: values };
        if (mode === "floor" && values.length === 3 && sceneRef.current && floorFrame(next, sceneRef.current)) {
          next.boundary = next.boundary.map(p => projectToFloor(p, next, sceneRef.current!));
          if (next.spawn) next.spawn = projectToFloor(next.spawn, next, sceneRef.current);
        }
        return next;
      });
    };
    return () => { ++loadGeneration.current; uploadController.current?.abort(); v.dispose(); viewer.current = undefined; };
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const result = await api.jobs(controller.signal); if (!active) return;
        setJobs(result); setService(""); setLastRefresh(new Date());
        if (initialList.current) {
          initialList.current = false;
          if (!result.length) setPanel("capture");
          else {
            const requested = new URLSearchParams(location.hash.split("?")[1] || "").get("job");
            const linked = result.find(job => job.id === requested);
            setSelected(current => linked?.id ?? current ?? result.find(job => job.id === api.recoveredJobId())?.id ?? result.find(job => ["RUNNING", "QUEUED"].includes(job.state))?.id ?? result[0].id);
            if (linked?.manifestUrl) void open(linked);
          }
        }
      } catch (e) { if (active) setService(e instanceof Error ? e.message : "Room service unavailable"); }
      finally { if (active) timer = setTimeout(() => void refresh(), 3000); }
    };
    void refresh();
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, []);
  useEffect(() => {
    if (!scene) return;
    viewer.current?.setTool(loading ? "review" : selection); viewer.current?.preview(calibration); viewer.current?.mark(calibration, selection, pendingBox, floorGrid);
  }, [calibration, pendingBox, selection, scene, loading, floorGrid]);
  useEffect(() => {
    if (!scene || loading) return;
    try { localStorage.setItem(draftKey(scene), JSON.stringify(calibration)); setDraftSaved(true); }
    catch { setDraftSaved(false); }
  }, [calibration, scene, loading]);
  const capture = async () => {
    if (!files.length || !name.trim()) return;
    setBusy(true); setError(""); setUploadPercent(0);
    const controller = new AbortController(); uploadController.current = controller;
    try {
      const result = await api.upload(files, name.trim(), profile, controller.signal, setUploadPercent, setUploadPhase);
      setJobs(current => [result, ...current.filter(j => j.id !== result.id)]); setSelected(result.id);
      setPanel("library"); setFilter("all"); setQuery(""); setScene(null); viewer.current?.inspect();
      setStatus("Capture uploaded. Reconstruction will begin when a GPU worker is available.");
    } catch (e) { if (!(e instanceof DOMException && e.name === "AbortError")) setError(e instanceof Error ? e.message : String(e)); else setStatus("Upload paused. Choose the same files to resume."); }
    finally { setBusy(false); uploadController.current = undefined; }
  };
  const reconstructAgain = async (job: Job) => {
    setLoading(true); setError("");
    const key = reconstructionKeys.current.get(job.id) ?? crypto.randomUUID();
    reconstructionKeys.current.set(job.id, key);
    try {
      const result = await api.reconstructAgain(job.id, key);
      ++loadGeneration.current;
      setJobs(current => [result, ...current.filter(j => j.id !== result.id)]);
      setSelected(result.id); setScene(null); viewer.current?.inspect();
      setPanel("library"); setFilter("all"); setQuery("");
      setStatus("A new reconstruction is queued using the saved upload.");
      location.hash = `rooms?job=${result.id}`;
      reconstructionKeys.current.delete(job.id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  const open = async (job: Job) => {
    if (!job.manifestUrl || !viewer.current) return;
    const generation = ++loadGeneration.current;
    setSelected(job.id); setScene(null); setLoading(true); setError(""); setStatus("Downloading reconstructed room…");
    history.current = []; setCanUndo(false); setDraftSaved(false); setCalibration(fresh(), false); setPendingBox(null); pendingBoxRef.current = null; setPointTarget(null);
    try {
      const manifest = await api.manifest(job.manifestUrl);
      if (generation !== loadGeneration.current) return;
      await viewer.current.load(manifest);
      if (generation !== loadGeneration.current) return;
      const saved = calibrationFromManifest(manifest), draft = readDraft(manifest);
      baseline.current = JSON.stringify(saved); setCalibration(draft ?? saved, false);
      setSelection(manifest.ready ? "review" : "floor");
      setScene(manifest); setOverlay(false);
    } catch (e) { if (generation === loadGeneration.current && !(e instanceof DOMException && e.name === "AbortError")) { setScene(null); setError(e instanceof Error ? e.message : String(e)); } }
    finally { if (generation === loadGeneration.current) setLoading(false); }
  };
  const publish = async () => {
    if (!selected || !scene) return;
    setLoading(true); setError("");
    try {
      const result = await api.calibrate(selected, calibration);
      try { localStorage.removeItem(draftKey(scene)); } catch { /* Server save remains valid. */ }
      setJobs(current => [result, ...current.filter(j => j.id !== result.id)]);
      location.hash = `room-viewer?job=${result.id}`;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
  };
  const inspect = () => { viewer.current?.inspect(); };
  const useFloorProposal = () => {
    const proposal = scene?.floorProposal;
    if (!scene || proposal?.floorPoints?.length !== 3) return;
    inspect();
    setCalibration(c => {
      const next = { ...c, floor: structuredClone(proposal.floorPoints!), flipUp: false, reviewed: false };
      const boundary = c.boundary.length ? c.boundary : proposal.boundary ?? [];
      const spawn = c.spawn ?? proposal.spawn;
      return { ...next, boundary: boundary.map(p => projectToFloor(p, next, scene)), spawn: spawn ? projectToFloor(spawn, next, scene) : null };
    });
    setSelection("floor"); setPointTarget(null);
    setStatus("Aligned to the detected floor, keeping your dimensions and walking-area corners. Review the surface and fine-tune its height or tilt if needed.");
  };
  const setMode = (mode: CalibrationTool, target?: number) => {
    inspect(); setSelection(mode); setPointTarget(target ?? null); setPendingBox(null); pendingBoxRef.current = null;
    if (target !== undefined || mode === "dimension" || mode === "obstacle" || mode === "floor-height") host.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const undo = () => {
    if (pendingBoxRef.current) { pendingBoxRef.current = null; setPendingBox(null); return; }
    const previous = history.current.pop(); if (!previous) return;
    setCalibration(previous, false); setCanUndo(history.current.length > 0); setPointTarget(null);
  };
  const clearTool = () => {
    setPendingBox(null); pendingBoxRef.current = null; setPointTarget(null);
    if (selection === "floor-height") { setSelection("floor"); return; }
    setCalibration(c => selection === "floor" ? { ...c, floor: [], boundary: [], spawn: null, reviewed: false } : selection === "spawn" ? { ...c, spawn: null, reviewed: false } : selection === "dimension" ? { ...c, dimensions: c.dimensions?.slice(0, -1) } : selection === "obstacle" ? { ...c, obstacles: c.obstacles.slice(0, -1), reviewed: false } : selection === "review" ? c : { ...c, [selection]: [], reviewed: false });
  };
  const useViewForward = () => {
    const direction = viewer.current?.forwardFromView(), frame = scene && floorFrame(calibration, scene);
    if (!direction || !frame) { setStatus("Orbit to a level view facing the direction you want, then try again."); return; }
    const length = distance(calibration.floor[0], calibration.floor[1]);
    setCalibration(c => ({ ...c, reviewed: false, floor: [c.floor[0], point(frame.origin.clone().addScaledVector(vector(direction), length)), point(frame.origin.clone().addScaledVector(frame.up.clone().cross(vector(direction)), length))] }));
  };
  const pickHint = selection === "floor-height" ? "Click a real floor surface to set its height · tilt and dimensions stay unchanged" : selection === "measurement" ? calibration.measurement.length === 2 && pointTarget === null ? "Reference selected · adjust A/B below, then enter its real distance" : `Click endpoint ${(pointTarget ?? calibration.measurement.length) === 0 ? "A" : "B"} of your measured distance` : selection === "floor" ? pointTarget !== null || calibration.floor.length < 3 ? `Click floor point ${(pointTarget ?? calibration.floor.length) + 1}` : "Check the floor grid · adjust its height and tilt below" : selection === "boundary" ? pointTarget !== null ? `Click to move floor corner ${pointTarget + 1}` : "Click around the walking area · corners snap to floor" : selection === "spawn" ? "Click an open floor location to place the start marker" : selection === "dimension" ? pendingBox ? "Pick the second end of this ruler" : "Pick the first end of a new ruler" : selection === "obstacle" ? pendingBox ? "Pick the opposite upper corner" : "Pick a lower obstacle corner" : "Inspect the floor and collisions before saving";
  return <main className="room-studio">
    <header className="room-heading"><div><p className="eyebrow">DIGITAL ROOM</p><h1>Walk through your real room</h1><p>Turn overlapping photos or a video into a photorealistic 3D space.</p></div></header>
    {service && <p className="room-notice" role="status">{service} Status reconnects automatically.</p>}
    {error && <p className="room-error" role="alert">{error}</p>}
    <div className="room-layout">
      <aside className="room-panel">
        <nav className="room-library-tabs" aria-label="Room workspace"><button aria-pressed={panel === "library"} onClick={() => setPanel("library")}>Room library</button><button aria-pressed={panel === "capture"} onClick={() => setPanel("capture")}>{busy ? "Uploading…" : "+ New capture"}</button></nav>
        {!allJobs.length && lastRefresh && !service && <p className="room-help">Rooms are saved for this browser session and address. Changing browser, clearing browser data, or using a different address can hide rooms you already created. {location.hostname === "localhost" && <>Try your usual address: <a href="http://127.0.0.1:5173/#rooms">Open saved rooms at 127.0.0.1</a>. </>}If your rooms are still missing, restore the original browser session with a room recovery link.</p>}
        <div hidden={panel !== "capture"}>
        <h2>Capture a room</h2>
        <p>Walk slowly around one static room. Keep overlapping views, revisit earlier viewpoints, and record the floor and obstacles. Moving the camera is essential.</p>
        <p className="room-help">Change your position, not just the viewing angle. A longer video from one fixed spot cannot provide reliable depth for walking or collisions. Keep the same lens, avoid zooming, and move slowly between viewpoints. Longer videos receive a larger frame budget, up to the profile limit.</p>
        <label>Room name<input value={name} maxLength={100} disabled={busy} onChange={e => setName(e.target.value)} /></label>
        <label>Photos or video<input type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,.mov" disabled={busy} onChange={e => setFiles(Array.from(e.target.files || []))} /></label>
        <p>{files.length ? `${files.length} file${files.length > 1 ? "s" : ""} · ${(files.reduce((n, f) => n + f.size, 0) / 1024 ** 2).toFixed(1)} MiB` : "12–500 photos, or one video up to 5 minutes."}</p>
        <label>Detail<select value={profile} disabled={busy} onChange={e => setProfile(e.target.value)}><option value="local">Standard · smaller GPU</option><option value="quality">High · more GPU memory</option></select></label>
        <button disabled={busy || !!service || !files.length || !name.trim()} onClick={() => void capture()}>Upload and reconstruct</button>
        {busy && <><progress max={100} value={uploadPhase === "Uploading capture…" ? uploadPercent : undefined} aria-label="Upload progress" /><p role="status">{uploadPhase}{uploadPhase === "Uploading capture…" ? ` ${uploadPercent.toFixed(0)}%` : ""}</p><button onClick={() => uploadController.current?.abort()}>Pause upload</button></>}
        <p className="room-help">A normal video does not supply real-world scale. Keep a tape-measured distance for calibration. Mirrors, glass and blank walls can cause gaps.</p>
        </div>
        <div hidden={panel !== "library"}>
        <div className="room-library-heading"><h2>Your rooms</h2><span>{allJobs.length}</span></div>
        <p className="room-help">{activeCount ? `${activeCount} reconstruction${activeCount === 1 ? "" : "s"} in progress` : "Select a room to view its progress or open the scene."}</p>
        <label>Search rooms<input type="search" placeholder="Room name…" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <label>Status<select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All rooms</option><option value="active">In progress</option><option value="calibrate">Needs calibration / review</option><option value="ready">Ready to explore</option><option value="issues">Failed / cancelled</option></select></label>
        {lastRefresh && <p className="room-help">{service ? "Status unavailable · last connected " : "Live status · updated "}{lastRefresh.toLocaleTimeString()}</p>}
        {!visibleJobs.length && <p>{allJobs.length ? "No rooms match this search and status." : "No captures yet. Start with a new capture."}</p>}
        <div className="room-jobs">{visibleJobs.map(j => {
          const observation = j.diagnostics?.liveProgress as LiveProgress | undefined;
          const percent = observation?.stage === j.stage ? observation.percent : null;
          return <article className={j.id === selected ? "selected" : ""} key={j.id}>
            <button className="room-job-row" aria-pressed={j.id === selected} onClick={() => {
              if (j.state === "READY" && j.manifestUrl) location.hash = `room-viewer?job=${j.id}`;
              else if (j.manifestUrl) void open(j);
              else { ++loadGeneration.current; setSelected(j.id); setScene(null); setLoading(false); inspect(); setStatus(`${j.name} · ${stepLabel(j.stage)}`); }
            }} disabled={loading}>
              <strong>{j.name}</strong><span className="room-state" data-state={j.state}>{stateLabel(j.state)}</span>
              {j.state === "RUNNING" && <small>{stepLabel(j.stage)}{percent !== null ? ` · ${percent}%` : ""}</small>}
              {j.version && <small>Scene version {j.version}</small>}
            </button>
            {j.state === "READY" && <div className="room-job-actions"><a href={`#room-viewer?job=${j.id}`}>Explore</a><button disabled={loading} onClick={() => {
              if (new URLSearchParams(location.hash.split("?")[1] || "").get("job") === j.id) void open(j);
              else location.hash = `rooms?job=${j.id}`;
            }}>Edit setup</button></div>}
          </article>;
        })}</div>
        </div>
      </aside>
      <section className="room-workspace">
        {selectedJob && <section className="room-selected-job">
          <div className="room-selected-heading"><div><p className="eyebrow">SELECTED ROOM</p><h2>{selectedJob.name}</h2></div><span className="room-state" data-state={selectedJob.state}>{stateLabel(selectedJob.state)}</span></div>
          {!scene && <JobProgress job={selectedJob} />}
          {selectedJob.error && <p className="room-error" role="alert">{selectedJob.error}</p>}
          {["QUEUED", "RUNNING"].includes(selectedJob.state) && <button disabled={selectedJob.cancel_requested} onClick={() => { void api.cancel(selectedJob.id).catch(e => setError(String(e))); }}>{selectedJob.cancel_requested ? "Cancellation requested" : "Cancel reconstruction"}</button>}
          {!["QUEUED", "RUNNING"].includes(selectedJob.state) && <><button disabled={loading || busy || !!service} onClick={() => void reconstructAgain(selectedJob)}>Reconstruct again</button><p className="room-help">Uses the saved photos or video with the current pipeline and creates a separate result. The new scene needs its own scale and floor setup.</p></>}
          {selectedJob.manifestUrl && !scene && <button disabled={loading} onClick={() => void open(selectedJob)}>{loading ? "Opening room…" : "Open reconstructed room"}</button>}
        </section>}
        <div className={`room-view${scene ? "" : " room-view-empty"}`} style={{ visibility: scene ? "visible" : "hidden" }} ref={host} />
        {scene && <div className="room-pick-hint" role="status"><strong>{pickHint}</strong><span>Drag to orbit · Right-drag to pan · Scroll to zoom</span></div>}
        <div className="room-toolbar" hidden={!scene}><p role="status">{status}</p>
          <button disabled={!scene?.ready || loading || dirty} onClick={() => { if (selected) location.hash = `room-viewer?job=${selected}`; }}>Open walking viewer</button>
          <button disabled={!scene || loading} onClick={inspect}>Inspect / calibrate</button>
          <button disabled={!scene || loading} onClick={() => { inspect(); viewer.current?.resetView(); }}>Reset view</button>
          <button disabled={!scene || loading} onClick={() => { inspect(); viewer.current?.levelView(); }}>Level view</button>
          <button disabled={!scene || loading} onClick={() => { inspect(); viewer.current?.topView(); }}>Top view</button>
          <label title="Visible in Floor and Walking area; squares are 1 metre after setting scale"><input type="checkbox" checked={floorGrid} disabled={!scene || loading} onChange={e => setFloorGrid(e.target.checked)} /> Floor grid</label>
          <label><input type="checkbox" checked={overlay} disabled={!scene || loading} onChange={e => { setOverlay(e.target.checked); viewer.current?.showCollision(e.target.checked); }} /> Show collision surfaces</label>
          {dirty && scene?.ready && <p className="room-help">Save the edited dimensions and orientation before walking.</p>}
        </div>
        {!scene && !selectedJob && <div className="room-empty"><h2>Your capture becomes the scene</h2><p>Choose a saved room or upload a new capture. Its progress and scene will appear here.</p><button onClick={() => setPanel("capture")}>+ New capture</button></div>}
        {scene && <CalibrationPanel scene={scene} calibration={calibration} tool={selection} target={pointTarget} pending={pendingBox} canUndo={canUndo} draftSaved={draftSaved} loading={loading} dirty={dirty}
          onChange={setCalibration} onTool={setMode} onUndo={undo} onClear={clearTool} onSuggestedFloor={useFloorProposal}
          onTop={() => { inspect(); viewer.current?.topView(); }} onForward={useViewForward} onPublish={() => void publish()} />}
      </section>
    </div>
  </main>;
}
