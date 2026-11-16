import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CameraCaptureControl, LiveCameraState } from "./space/tracking/types";
import { AdminUsers, Login, logout, me } from "./auth";
import { Icon, type IconName } from "./Icon";
import type { SplatShape } from "./SplatField";
import { canUploadCapture, expireSession, sessionExpiredEvent, sessionRevision, setCurrentAccount, type Account } from "./session";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/hanken-grotesk";
import "./style.css";
import "./workspace.css";
const SplatField = lazy(() => import("./SplatField"));
const RoomStudio = lazy(() => import("./space/Studio").then(module => ({ default: module.RoomStudio })));
const RoomViewer = lazy(() => import("./space/RoomViewer").then(module => ({ default: module.RoomViewer })));
const CameraDeck = lazy(() => import("./space/tracking/CameraDeck").then(module => ({ default: module.CameraDeck })));
const GaussianStudio = lazy(() => import("./gaussian/Studio").then(module => ({ default: module.GaussianStudio })));
const Photos = lazy(() => import("./gaussian/Photos").then(module => ({ default: module.Photos })));
const workspaces = [
  { id: "pipelines", title: "Pipeline overview", icon: "layers", group: "Workspace" },
  { id: "rooms", title: "Room reconstruction", icon: "cube", group: "Rooms" },
  { id: "room-viewer", title: "Room viewer", icon: "eye", group: "Rooms" },
  { id: "room-tracking", title: "Live cameras", icon: "camera", group: "Rooms" },
  { id: "avatar", title: "Avatar viewer", icon: "person", group: "Avatars" },
  { id: "photos", title: "Avatar library", icon: "images", group: "Avatars" },
  { id: "admin", title: "Accounts", icon: "users", group: "Administration" },
] as const;
type Workspace = typeof workspaces[number]["id"];
const currentWorkspace = (): Workspace => workspaces.find(item => item.id === location.hash.slice(1).split("?")[0])?.id ?? "pipelines";
const currentRoute = () => ({ workspace: currentWorkspace(), jobId: new URLSearchParams(location.hash.split("?")[1] || "").get("job") || "" });
function PipelineCard({ shape, onShape, icon, badge, badgeMuted, title, text, flow, note, href, action }: { shape: SplatShape; onShape: (shape: SplatShape) => void; icon: IconName; badge: string; badgeMuted?: boolean; title: string; text: string; flow?: string[]; note?: string; href: string; action: string }) {
  // The card lights up under the pointer and the hero cloud morphs into what this pipeline produces.
  return <article className="pipeline-card" onPointerEnter={() => onShape(shape)} onFocus={() => onShape(shape)} onPointerMove={event => { const box = event.currentTarget.getBoundingClientRect(), style = event.currentTarget.style; style.setProperty("--mx", `${event.clientX - box.left}px`); style.setProperty("--my", `${event.clientY - box.top}px`); }}>
    <div className="pipeline-card-top"><span className="pipeline-symbol"><Icon name={icon} /></span><span className={`pipeline-badge${badgeMuted ? " muted" : ""}`}>{badge}</span></div>
    <h2>{title}</h2><p>{text}</p>
    {flow && <ol className="pipeline-flow">{flow.map(step => <li key={step}>{step}</li>)}</ol>}
    {note && <p className="pipeline-note">{note}</p>}
    <a className="workspace-action" href={href}>{action} <span aria-hidden="true">→</span></a>
  </article>;
}
function PipelineOverview({ captureAllowed }: { captureAllowed: boolean }) {
  const [shape, setShape] = useState<SplatShape>("room");
  return <main className="pipeline-overview">
    <section className="overview-hero">
      <Suspense fallback={null}><SplatField shape={shape} className="overview-field" /></Suspense>
      <header><h1>Choose a pipeline</h1><p>Open a workflow to manage its inputs, processing and results.</p></header>
      <p className="overview-legend" aria-hidden="true"><span data-shape={shape} />{shape === "room" ? "Room reconstruction with its capture cameras" : shape === "capture" ? "Walk-around capture of one person" : shape === "figure" ? "Rigged avatar" : "Raw Gaussians from a PLY file"}</p>
    </section>
    <div className="pipeline-grid">
      <PipelineCard shape="scene" onShape={setShape} icon="layers" badge="Gaussian PLY" title="Import a scene" text="Upload an existing Gaussian PLY file and explore it directly with orbit controls." flow={["Gaussian PLY", "Validate and import", "Orbit viewer"]} href="#rooms?kind=splat" action="Import Gaussian PLY" />
      {captureAllowed && <PipelineCard shape="room" onShape={setShape} icon="cube" badge="Reconstruction" title="Rooms" text="Turn a room capture into a photorealistic space you can walk through." flow={["Photos or video", "Reconstruct", "Calibrate", "Explore"]} href="#rooms" action="Open room workspace" />}
      <PipelineCard shape="figure" onShape={setShape} icon="person" badge="Viewer & demo" title="Avatar viewer" text="Inspect Gaussian models and explore animation with the rigged example." flow={["Model or demo", "Inspect", "Animate a rigged model"]} href="#avatar" action="Open avatar viewer" />
      <PipelineCard shape="capture" onShape={setShape} icon="images" badge="Capture storage" badgeMuted title="Avatars" text={captureAllowed ? "Turn one walk-around video of a person into a photographic 3D avatar." : "View the avatars saved to your account."} flow={captureAllowed ? ["Walk-around video", "Build avatar", "View in 3D"] : undefined}
        note={captureAllowed ? "Reconstruction runs on the GPU worker; progress is shown per stage." : "Building avatars requires a reconstructor or administrator role."} href="#photos" action="Open avatar library" />
    </div>
  </main>;
}
function WorkspaceApp({ account, onLogout }: { account: Account; onLogout: () => void }) {
  const [route, setRoute] = useState(currentRoute);
  const { workspace, jobId } = route;
  const [cameraJobId, setCameraJobId] = useState<string | null>(() => workspace === "room-tracking" ? jobId : null);
  const [cameraState, setCameraState] = useState<LiveCameraState | null>(null);
  const cameraControl = useRef<CameraCaptureControl | null>(null);
  const captureAllowed = canUploadCapture(account);
  const permitted = workspace !== "admin" || account.role === "ADMIN";
  const visibleWorkspaces = workspaces.filter(item => item.id !== "admin" || account.role === "ADMIN");
  useEffect(() => () => { cameraControl.current?.stopCamera(); }, []);
  useEffect(() => {
    const change = () => {
      const next = currentRoute(); setRoute(next);
      if (next.workspace === "room-tracking") setCameraJobId(next.jobId || cameraJobId || "");
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, [cameraJobId]);
  const selected = workspaces.find(item => item.id === workspace)!;
  const roomLink = (id: Workspace) => ["room-viewer", "room-tracking"].includes(id) && (jobId || cameraJobId)
    ? `#${id}?job=${encodeURIComponent(jobId || cameraJobId!)}` : `#${id}`;
  return <div className="workspace-shell">
    <header className="workspace-bar">
      <a href="#pipelines" className="workspace-brand"><span className="workspace-brand-mark"><Icon name="cube" /></span><span>Digital Studio</span></a>
      <nav aria-label="Pipeline navigation">{visibleWorkspaces.map((item, i) => <a key={item.id} href={roomLink(item.id)} title={item.title} data-group-start={i > 0 && visibleWorkspaces[i - 1].group !== item.group || undefined} aria-current={workspace === item.id ? "page" : undefined}><Icon name={item.icon} /><span>{item.title}</span></a>)}</nav>
      <div className="workspace-account"><span className="workspace-account-avatar" aria-hidden="true">{account.username.slice(0, 1).toUpperCase()}</span><div className="workspace-account-identity"><strong>{account.username}</strong><small>{account.role === "SPLAT_UPLOADER" ? "PLY uploader" : account.role === "ADMIN" ? "Administrator" : "Reconstructor"}</small></div><button onClick={onLogout} title="Sign out"><Icon name="logout" /><span>Sign out</span></button></div>
    </header>
    <div className="workspace-content">
      {cameraState?.cameraRunning && workspace !== "room-tracking" && <div className="workspace-camera-status" role="status"><span><strong>{cameraState.name}</strong> · {cameraState.tracking ? "Live tracking on" : "Camera on"}</span><a href={`#room-tracking?job=${encodeURIComponent(cameraState.jobId)}`}>Camera controls</a><button onClick={() => cameraControl.current?.stopCamera()}>Stop camera</button></div>}
      <Suspense fallback={<main role="status">Loading {selected.title.toLowerCase()}…</main>}>
        {cameraJobId !== null && <CameraDeck key={`camera:${cameraJobId}`} jobId={cameraJobId} active={workspace === "room-tracking"} onState={setCameraState} controlRef={cameraControl} />}
        {!permitted ? <main><h1>Permission required</h1><p>Only administrators can manage accounts. Contact an administrator if you need access.</p></main> : workspace === "admin" ? <AdminUsers /> : workspace === "room-tracking" ? null : workspace === "pipelines" ? <PipelineOverview captureAllowed={captureAllowed} /> : workspace === "rooms" ? <RoomStudio key={`setup:${jobId}`} captureAllowed={captureAllowed} /> : workspace === "room-viewer" ? <RoomViewer key={`viewer:${jobId}`} jobId={jobId} localCamera={cameraState?.jobId === jobId ? cameraState : null} stopCamera={() => cameraControl.current?.stopCamera()} /> : workspace === "avatar" ? <GaussianStudio /> : <main className="gaussian-studio"><header><h1>Avatar library</h1><p>Upload a walk-around video of a person and build their 3D avatar from it.</p></header><Photos captureAllowed={captureAllowed} /></main>}
      </Suspense>
    </div>
  </div>;
}
function App() {
  const [account, setAccount] = useState<Account | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const signedIn = (value: Account) => { setCurrentAccount(value); setAccount(value); setError(""); };
  useEffect(() => {
    let active = true;
    const expired = () => { setCurrentAccount(null); setAccount(null); };
    window.addEventListener(sessionExpiredEvent, expired);
    void me().then(value => { if (active) signedIn(value); }).catch(e => { if (active && e.status !== 401) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; window.removeEventListener(sessionExpiredEvent, expired); };
  }, []);
  const signOut = async () => {
    const requestedRevision = sessionRevision();
    try { await logout(); expireSession(requestedRevision); }
    catch (e) { if (requestedRevision === sessionRevision()) setError(e instanceof Error ? e.message : String(e)); }
  };
  if (loading) return <main className="auth-page" role="status">Checking your session…</main>;
  return <>{error && <p className="error" role="alert">{error}</p>}{account ? <WorkspaceApp key={account.id} account={account} onLogout={() => void signOut()} /> : <Login onLogin={signedIn} />}</>;
}
createRoot(document.getElementById("root")!).render(<App />);
