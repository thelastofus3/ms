import { useEffect, useRef, useState } from "react";
import { type Capture, frameCount, isActive, overallProgress, photoApi, photoRequest } from "./avatarJobs";
import { GaussianRenderer } from "./renderer";
import type { Motion } from "./rig";

const selectedFromHash = () => new URLSearchParams(location.hash.split("?")[1] || "").get("capture") || "";

export function GaussianStudio() {
  const host = useRef<HTMLDivElement>(null), viewer = useRef<GaussianRenderer | undefined>(undefined);
  const [status, setStatus] = useState("No avatar selected"), [error, setError] = useState("");
  const [rigged, setRigged] = useState(false), [playing, setPlaying] = useState(true);
  const [motion, setMotion] = useState<Motion>("idle");
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [selected, setSelected] = useState(selectedFromHash);
  const anyActive = captures.some(item => isActive(item.job));
  useEffect(() => {
    let active = true;
    const refresh = () => photoRequest().then(items => { if (active) setCaptures(items); }).catch(() => {});
    void refresh();
    const timer = anyActive ? setInterval(() => void refresh(), 3000) : undefined;
    return () => { active = false; clearInterval(timer); };
  }, [anyActive]);
  useEffect(() => {
    const follow = () => setSelected(selectedFromHash());
    addEventListener("hashchange", follow);
    return () => removeEventListener("hashchange", follow);
  }, []);
  const load = async (source: string | File) => {
    const v = viewer.current;
    if (!v) return;
    setError(""); setRigged(false); setStatus("Loading Gaussians…");
    try {
      let count: number | undefined;
      if (source instanceof File) count = await v.loadFile(source);
      else if (captures.find(item => item.id === source)?.job?.result?.rig) {
        // Animatable package: skeleton + skinning, upright with feet on the floor.
        count = await v.loadRigPackage(`${photoApi}/${source}/avatar/rig`);
        if (viewer.current !== v || count === undefined) return;
        setRigged(true);
        setStatus(`${count.toLocaleString("en-US")} Gaussians · 24-joint skeleton`);
        return;
      } else {
        const response = await fetch(`${photoApi}/${source}/avatar/model.ply`);
        if (!response.ok) throw Error(response.status === 404 ? "This avatar is not ready yet." : "The avatar could not be downloaded.");
        count = await v.loadFile(new File([await response.blob()], "avatar.ply"));
      }
      if (viewer.current !== v || count === undefined) return;
      setStatus(`${count.toLocaleString("en-US")} Gaussians · static, not yet rigged`);
    } catch (e) {
      if (viewer.current !== v || e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e)); setStatus("The model could not be loaded");
    }
  };
  useEffect(() => {
    try { viewer.current = new GaussianRenderer(host.current!); } catch (e) { setError(String(e)); }
    return () => { viewer.current?.dispose(); viewer.current = undefined; };
  }, []);
  const selectedCapture = captures.find(item => item.id === selected);
  const ready = selectedCapture?.job?.state === "done";
  useEffect(() => { if (ready) void load(selected); }, [selected, ready]);
  // Without an explicit choice, open the newest finished avatar.
  useEffect(() => {
    const newest = captures.find(item => item.job?.state === "done");
    if (!selected && newest) setSelected(newest.id);
  }, [captures, selected]);
  const choose = (id: string) => {
    history.replaceState(null, "", `#avatar?capture=${id}`);
    // Re-selecting the current item reloads it (e.g. after opening a local file).
    if (id === selected) void load(id); else setSelected(id);
  };
  const built = captures.filter(item => item.job);
  return <main className="gaussian-studio">
    <header>
      <p className="eyebrow">GAUSSIAN AVATAR</p>
      <h1>Avatar viewer</h1>
      <p>Photographic 3D people reconstructed from your photo sets. Build new ones in the <a href="#photos">Photo library</a>.</p>
    </header>
    <div className="gaussian-layout avatar-layout">
      <nav className="avatar-list" aria-label="Avatars">
        <h2>Your avatars</h2>
        {!built.length && <p className="gaussian-note">None yet. Save a photo set in the Photo library and press “Build 3D avatar”.</p>}
        {built.map(item => {
          const job = item.job!, percent = Math.round(overallProgress(job) * 100);
          return <button key={item.id} className="avatar-list-item" aria-pressed={selected === item.id} onClick={() => choose(item.id)}>
            {frameCount(item) ? <img src={`${photoApi}/${item.id}/photos/0`} alt="" /> : <i className="avatar-list-video" aria-hidden="true">▶</i>}
            <span><b>{item.kind === "video" ? "Video" : `${item.photo_count} photos`} · {new Date(item.created_at).toLocaleDateString("en-US")}</b>
              <small data-state={job.state}>{job.state === "done" ? "Ready" : isActive(job) ? `Building · ${percent}%` : job.state === "failed" ? "Failed" : "Cancelled"}</small>
              {isActive(job) && <i className="avatar-job-bar"><span style={{ width: `${percent}%` }} /></i>}</span>
          </button>;
        })}
      </nav>
      <div className="gaussian-view-column">
        <div className="gaussian-view" ref={host} />
        {!selectedCapture && <div className="avatar-view-overlay">
          <p>{built.length ? "Choose an avatar on the left." : "No avatars yet. Upload photos or a walk-around video of a person and build an avatar."}</p>
          <a className="workspace-action" href="#photos">Open Photo library →</a>
        </div>}
        {!ready && selectedCapture && <div className="avatar-view-overlay">
          <p>{isActive(selectedCapture.job) ? `This avatar is still being built (${Math.round(overallProgress(selectedCapture.job!) * 100)}%). Follow the stages in the Photo library.` : "This avatar has no finished model. Check its build in the Photo library."}</p>
          <a className="workspace-action" href="#photos">Open Photo library →</a>
        </div>}
      </div>
      <aside className="gaussian-panel">
        <h2>View and motion</h2>
        <p data-testid="gaussian-status">{status}</p>
        {rigged && <>
        <label>Motion
          <select aria-label="Motion" value={motion} disabled={!rigged} onChange={e => {
            const value = e.target.value as Motion; setMotion(value); if (viewer.current) viewer.current.motion = value;
          }}>
            <option value="idle">Idle</option><option value="wave">Wave</option><option value="walk">Walk in place</option><option value="canonical">Rest pose</option>
          </select>
        </label>
        <button disabled={!rigged} onClick={() => { setPlaying(!playing); if (viewer.current) viewer.current.playing = !playing; }}>{playing ? "Pause" : "Play"}</button>
        <label>Spread arms
          <input type="range" min="0" max="1" step="0.01" defaultValue="0" disabled={!rigged} onChange={e => { if (viewer.current) viewer.current.arms = +e.target.value; }} />
        </label>
        </>}
        <button onClick={() => viewer.current?.resetView()}>Reset camera</button>
        <hr />
        <label>Open a local PLY / SPLAT
          <input type="file" accept=".ply,.splat" onChange={e => { const file = e.target.files?.[0]; if (file) void load(file); e.target.value = ""; }} />
        </label>
        <p className="gaussian-note">{rigged
          ? "Skeleton from the photos; Gaussians follow the bones. Strong bends and loose clothing can stretch."
          : "This avatar was built before skeletons were added; rebuild it in the Photo library to animate it."}</p>
        <p className="gaussian-note">Drag to orbit · wheel to zoom · right-drag to pan</p>
      </aside>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
  </main>;
}
