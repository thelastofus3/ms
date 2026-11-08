import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CameraCaptureControl, LiveCameraState } from "./space/tracking/types";
import { AdminUsers, Login, logout, me } from "./auth";
import { Icon } from "./Icon";
import { canUploadCapture, expireSession, sessionExpiredEvent, sessionRevision, setCurrentAccount, type Account } from "./session";
import "./style.css";
import "./workspace.css";
const RoomStudio = lazy(() => import("./space/Studio").then(module => ({ default: module.RoomStudio })));
const RoomViewer = lazy(() => import("./space/RoomViewer").then(module => ({ default: module.RoomViewer })));
const CameraTracking = lazy(() => import("./space/tracking/CameraTracking").then(module => ({ default: module.CameraTracking })));
const GaussianStudio = lazy(() => import("./gaussian/Studio").then(module => ({ default: module.GaussianStudio })));
const Photos = lazy(() => import("./gaussian/Photos").then(module => ({ default: module.Photos })));
const workspaces = [
  { id: "pipelines", title: "Pipeline overview", icon: "layers", group: "Workspace" },
  { id: "rooms", title: "Room reconstruction", icon: "cube", group: "Rooms" },
  { id: "room-viewer", title: "Room viewer", icon: "eye", group: "Rooms" },
  { id: "room-tracking", title: "Live cameras", icon: "camera", group: "Rooms" },
  { id: "avatar", title: "Avatar viewer", icon: "person", group: "Avatars" },
  { id: "photos", title: "Photo library", icon: "images", group: "Avatars" },
  { id: "admin", title: "Accounts", icon: "users", group: "Administration" },
] as const;
type Workspace = typeof workspaces[number]["id"];
const currentWorkspace = (): Workspace => workspaces.find(item => item.id === location.hash.slice(1).split("?")[0])?.id ?? "pipelines";
const currentRoute = () => ({ workspace: currentWorkspace(), jobId: new URLSearchParams(location.hash.split("?")[1] || "").get("job") || "" });
function PipelineOverview({ captureAllowed }: { captureAllowed: boolean }) {
  return <main className="pipeline-overview">
    <header><p className="eyebrow">WORKSPACE</p><h1>Choose a pipeline</h1><p>Open a workflow to manage its inputs, processing and results.</p></header>
    <div className="pipeline-grid">
      <article className="pipeline-card">
        <div className="pipeline-card-top"><span className="pipeline-symbol"><Icon name="layers" /></span><span className="pipeline-badge">Gaussian PLY</span></div>
        <h2>Import a scene</h2><p>Upload an existing Gaussian PLY file and explore it directly with orbit controls.</p>
        <ol className="pipeline-flow"><li>Gaussian PLY</li><li>Validate and import</li><li>Orbit viewer</li></ol>
        <a className="workspace-action" href="#rooms?kind=splat">Import Gaussian PLY <span aria-hidden="true">→</span></a>
      </article>
      {captureAllowed && <article className="pipeline-card">
        <div className="pipeline-card-top"><span className="pipeline-symbol"><Icon name="cube" /></span><span className="pipeline-badge">Reconstruction</span></div>
        <h2>Rooms</h2><p>Turn a room capture into a photorealistic space you can walk through.</p>
        <ol className="pipeline-flow"><li>Photos or video</li><li>Reconstruct</li><li>Calibrate</li><li>Explore</li></ol>
        <a className="workspace-action" href="#rooms">Open room workspace <span aria-hidden="true">→</span></a>
      </article>}
      <article className="pipeline-card">
        <div className="pipeline-card-top"><span className="pipeline-symbol"><Icon name="person" /></span><span className="pipeline-badge">Viewer & demo</span></div>
        <h2>Avatar viewer</h2><p>Inspect Gaussian models and explore animation with the rigged example.</p>
        <ol className="pipeline-flow"><li>Model or demo</li><li>Inspect</li><li>Animate a rigged model</li></ol>
        <a className="workspace-action" href="#avatar">Open avatar viewer <span aria-hidden="true">→</span></a>
      </article>
      <article className="pipeline-card">
        <div className="pipeline-card-top"><span className="pipeline-symbol"><Icon name="images" /></span><span className="pipeline-badge muted">Capture storage</span></div>
        <h2>Avatars</h2><p>{captureAllowed ? "Turn a set of photos of a person into a photographic 3D avatar." : "View the photo sets and avatars saved to your account."}</p>
        {captureAllowed && <ol className="pipeline-flow"><li>Photos from all sides</li><li>Build avatar</li><li>View in 3D</li></ol>}
        <p className="pipeline-note">{captureAllowed ? "Reconstruction runs on the GPU worker; progress is shown per stage. Avatars are static until rigging is added." : "Creating new photo sets requires a reconstructor or administrator role."}</p>
        <a className="workspace-action" href="#photos">Open photo library <span aria-hidden="true">→</span></a>
      </article>
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
    <aside className="workspace-sidebar">
      <a href="#pipelines" className="workspace-brand"><span className="workspace-brand-mark"><Icon name="cube" /></span><div>Digital Studio<small>3D workspaces</small></div></a>
      <nav aria-label="Pipeline navigation">{["Workspace", "Rooms", "Avatars", "Administration"].filter(group => visibleWorkspaces.some(item => item.group === group)).map(group => <div className="workspace-nav-group" key={group}>
        <p>{group}</p>{visibleWorkspaces.filter(item => item.group === group).map(item => <a key={item.id} href={roomLink(item.id)} aria-current={workspace === item.id ? "page" : undefined}><Icon name={item.icon} />{item.title}</a>)}
      </div>)}</nav>
      <p className="workspace-sidebar-note">Reconstruction jobs continue on the server while you explore other workspaces.</p>
      <div className="workspace-account"><span className="workspace-account-avatar" aria-hidden="true">{account.username.slice(0, 1).toUpperCase()}</span><div className="workspace-account-identity"><strong>{account.username}</strong><small>{account.role === "SPLAT_UPLOADER" ? "PLY uploader" : account.role === "ADMIN" ? "Administrator" : "Reconstructor"}</small></div><button onClick={onLogout}><Icon name="logout" />Sign out</button></div>
    </aside>
    <div className="workspace-content">
      <div className="workspace-topbar"><div className="workspace-breadcrumb"><a href="#pipelines">Pipelines</a><span aria-hidden="true">/</span><strong>{selected.title}</strong></div><span className="workspace-topbar-label"><Icon name="cube" /> Your 3D workspace</span></div>
      {cameraState?.cameraRunning && workspace !== "room-tracking" && <div className="workspace-camera-status" role="status"><span><strong>{cameraState.name}</strong> · {cameraState.tracking ? "Live tracking on" : "Camera on"}</span><a href={`#room-tracking?job=${encodeURIComponent(cameraState.jobId)}`}>Camera controls</a><button onClick={() => cameraControl.current?.stopCamera()}>Stop camera</button></div>}
      <Suspense fallback={<main role="status">Loading {selected.title.toLowerCase()}…</main>}>
        {cameraJobId !== null && <CameraTracking key={`camera:${cameraJobId}`} jobId={cameraJobId} active={workspace === "room-tracking"} onState={setCameraState} controlRef={cameraControl} />}
        {!permitted ? <main><h1>Permission required</h1><p>Only administrators can manage accounts. Contact an administrator if you need access.</p></main> : workspace === "admin" ? <AdminUsers /> : workspace === "room-tracking" ? null : workspace === "pipelines" ? <PipelineOverview captureAllowed={captureAllowed} /> : workspace === "rooms" ? <RoomStudio key={`setup:${jobId}`} captureAllowed={captureAllowed} /> : workspace === "room-viewer" ? <RoomViewer key={`viewer:${jobId}`} jobId={jobId} localCamera={cameraState?.jobId === jobId ? cameraState : null} stopCamera={() => cameraControl.current?.stopCamera()} /> : workspace === "avatar" ? <GaussianStudio /> : <main className="gaussian-studio"><header><p className="eyebrow">AVATAR CAPTURES</p><h1>Photo library</h1><p>Save photo sets of a person and build 3D avatars from them.</p></header><Photos captureAllowed={captureAllowed} /></main>}
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
