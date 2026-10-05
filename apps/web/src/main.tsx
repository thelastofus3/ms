import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CameraCaptureControl, LiveCameraState } from "./space/tracking/types";
import "./style.css";
import "./workspace.css";
const RoomStudio = lazy(() => import("./space/Studio").then(module => ({ default: module.RoomStudio })));
const RoomViewer = lazy(() => import("./space/RoomViewer").then(module => ({ default: module.RoomViewer })));
const CameraTracking = lazy(() => import("./space/tracking/CameraTracking").then(module => ({ default: module.CameraTracking })));
const GaussianStudio = lazy(() => import("./gaussian/Studio").then(module => ({ default: module.GaussianStudio })));
const Photos = lazy(() => import("./gaussian/Photos").then(module => ({ default: module.Photos })));
const workspaces = [
  { id: "pipelines", title: "Pipeline overview", icon: "◈", group: "Workspace" },
  { id: "rooms", title: "Room reconstruction", icon: "▧", group: "Rooms" },
  { id: "room-viewer", title: "Room viewer", icon: "◉", group: "Rooms" },
  { id: "room-tracking", title: "Live cameras", icon: "◎", group: "Rooms" },
  { id: "avatar", title: "Avatar viewer", icon: "◇", group: "Avatars" },
  { id: "photos", title: "Photo library", icon: "▦", group: "Avatars" },
] as const;
type Workspace = typeof workspaces[number]["id"];
const currentWorkspace = (): Workspace => workspaces.find(item => item.id === location.hash.slice(1).split("?")[0])?.id ?? "pipelines";
const currentRoute = () => ({ workspace: currentWorkspace(), jobId: new URLSearchParams(location.hash.split("?")[1] || "").get("job") || "" });
function PipelineOverview() {
  return <main className="pipeline-overview">
    <header><p className="eyebrow">WORKSPACE</p><h1>Choose a pipeline</h1><p>Open a workflow to manage its inputs, processing and results.</p></header>
    <div className="pipeline-grid">
      <article className="pipeline-card">
        <div className="pipeline-card-top"><span className="pipeline-symbol">▧</span><span className="pipeline-badge">Reconstruction</span></div>
        <h2>Rooms</h2><p>Turn a room capture into a photorealistic space you can walk through.</p>
        <ol className="pipeline-flow"><li>Photos or video</li><li>Reconstruct</li><li>Calibrate</li><li>Explore</li></ol>
        <a className="workspace-action" href="#rooms">Open room workspace <span aria-hidden="true">→</span></a>
      </article>
      <article className="pipeline-card">
        <div className="pipeline-card-top"><span className="pipeline-symbol">◇</span><span className="pipeline-badge">Viewer & demo</span></div>
        <h2>Avatar viewer</h2><p>Inspect Gaussian models and explore animation with the rigged example.</p>
        <ol className="pipeline-flow"><li>Model or demo</li><li>Inspect</li><li>Animate a rigged model</li></ol>
        <a className="workspace-action" href="#avatar">Open avatar viewer <span aria-hidden="true">→</span></a>
      </article>
      <article className="pipeline-card">
        <div className="pipeline-card-top"><span className="pipeline-symbol">▦</span><span className="pipeline-badge muted">Capture storage</span></div>
        <h2>Avatar photos</h2><p>Organize photo sets of a person for future avatar reconstruction.</p>
        <ol className="pipeline-flow"><li>Select photos</li><li>Save a set</li><li>Manage captures</li></ol>
        <p className="pipeline-note">Photo sets can be saved. Automatic avatar reconstruction is not connected yet.</p>
        <a className="workspace-action" href="#photos">Open photo library <span aria-hidden="true">→</span></a>
      </article>
    </div>
  </main>;
}
function App() {
  const [route, setRoute] = useState(currentRoute);
  const { workspace, jobId } = route;
  const [cameraJobId, setCameraJobId] = useState<string | null>(() => workspace === "room-tracking" ? jobId : null);
  const [cameraState, setCameraState] = useState<LiveCameraState | null>(null);
  const cameraControl = useRef<CameraCaptureControl | null>(null);
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
      <a href="#pipelines" className="workspace-brand"><span aria-hidden="true">◈</span><div>Digital Studio<small>3D workspaces</small></div></a>
      <nav aria-label="Pipeline navigation">{["Workspace", "Rooms", "Avatars"].map(group => <div className="workspace-nav-group" key={group}>
        <p>{group}</p>{workspaces.filter(item => item.group === group).map(item => <a key={item.id} href={roomLink(item.id)} aria-current={workspace === item.id ? "page" : undefined}><span aria-hidden="true">{item.icon}</span>{item.title}</a>)}
      </div>)}</nav>
      <p className="workspace-sidebar-note">Reconstruction jobs continue on the server while you explore other workspaces.</p>
    </aside>
    <div className="workspace-content">
      <div className="workspace-topbar"><a href="#pipelines">Pipelines</a><span aria-hidden="true">/</span><strong>{selected.title}</strong></div>
      {cameraState?.cameraRunning && workspace !== "room-tracking" && <div className="workspace-camera-status" role="status"><span><strong>{cameraState.name}</strong> · {cameraState.tracking ? "Live tracking on" : "Camera on"}</span><a href={`#room-tracking?job=${encodeURIComponent(cameraState.jobId)}`}>Camera controls</a><button onClick={() => cameraControl.current?.stopCamera()}>Stop camera</button></div>}
      <Suspense fallback={<main role="status">Loading {selected.title.toLowerCase()}…</main>}>
        {cameraJobId !== null && <CameraTracking key={`camera:${cameraJobId}`} jobId={cameraJobId} active={workspace === "room-tracking"} onState={setCameraState} controlRef={cameraControl} />}
        {workspace === "room-tracking" ? null : workspace === "pipelines" ? <PipelineOverview /> : workspace === "rooms" ? <RoomStudio key={`setup:${jobId}`} /> : workspace === "room-viewer" ? <RoomViewer key={`viewer:${jobId}`} jobId={jobId} localCamera={cameraState?.jobId === jobId ? cameraState : null} stopCamera={() => cameraControl.current?.stopCamera()} /> : workspace === "avatar" ? <GaussianStudio /> : <main className="gaussian-studio"><header><p className="eyebrow">AVATAR CAPTURES</p><h1>Photo library</h1><p>Manage your saved photo sets in one place.</p></header><Photos /></main>}
      </Suspense>
    </div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<App />);
