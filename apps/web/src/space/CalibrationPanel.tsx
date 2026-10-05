import { useEffect, useState } from "react";
import { calibrationIssues, distance, floorFrame, metersPerUnit, projectToFloor } from "./calibration";
import { FineFloorControls } from "./FineFloorControls";
import type { Calibration, CalibrationTool, Point, RoomManifest } from "./types";

export type ChangeCalibration = (change: (current: Calibration) => Calibration) => void;
type Props = {
  scene: RoomManifest; calibration: Calibration; tool: CalibrationTool; target: number | null; pending: Point | null;
  canUndo: boolean; draftSaved: boolean; loading: boolean; dirty: boolean;
  onChange: ChangeCalibration; onTool: (tool: CalibrationTool, target?: number) => void;
  onUndo: () => void; onClear: () => void; onSuggestedFloor: () => void; onTop: () => void;
  onForward: () => void; onPublish: () => void;
};
const steps = [
  { id: "floor", title: "Floor & orientation", short: "Floor" },
  { id: "measurement", title: "Set a known distance", short: "Scale" },
  { id: "boundary", title: "Draw the walking area", short: "Walking area" },
  { id: "spawn", title: "Choose where to start", short: "Start" },
  { id: "review", title: "Review & save", short: "Save" },
] as const;
const units = { m: { title: "metres", factor: 1 }, cm: { title: "centimetres", factor: 0.01 }, ft: { title: "feet", factor: 0.3048 } };
type Unit = keyof typeof units;
export function CalibrationPanel(p: Props) {
  const { scene, calibration: c, tool } = p;
  const [unit, setUnit] = useState<Unit>("m");
  const issues = calibrationIssues(c, scene), scale = metersPerUnit(c), frame = floorFrame(c, scene);
  const floorStep = tool === "floor" || tool === "floor-height";
  const selectedStep = steps.findIndex(s => s.id === (floorStep ? "floor" : tool));
  const ready = !Object.keys(issues).length;
  useEffect(() => {
    const undo = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement)) { event.preventDefault(); p.onUndo(); }
    };
    window.addEventListener("keydown", undo);
    return () => window.removeEventListener("keydown", undo);
  }, [p.onUndo]);
  const next = () => {
    const nextStep = steps[Math.min(steps.length - 1, selectedStep + 1)];
    p.onTool(nextStep.id);
    if (nextStep.id === "boundary" || nextStep.id === "spawn") p.onTop();
  };
  const format = (meters: number) => `${(meters / units[unit].factor).toFixed(unit === "cm" ? 1 : 2)} ${unit}`;
  return <section className="room-calibration" aria-label="Room setup tools">
    <fieldset className="room-calibration-fields" disabled={p.loading} aria-label="Room setup controls">
    <div className="room-setup-heading"><div><p className="eyebrow">ROOM SETUP</p><h2>{scene.ready ? "Edit dimensions & walking area" : "Make the room yours"}</h2></div><span className="room-draft-status">{p.dirty ? p.draftSaved ? "Draft saved in this browser" : "Unsaved changes" : scene.ready ? "Saved room settings" : "Suggested floor · review needed"}</span></div>
    <nav className="room-wizard" aria-label="Room setup steps">{steps.map((step, i) => <button key={step.id} aria-current={tool === step.id || floorStep && step.id === "floor" ? "step" : undefined} onClick={() => p.onTool(step.id)}><span>{!issues[step.id] ? "✓" : i + 1}</span>{step.short}</button>)}</nav>
    <div className="room-tool-heading"><h3>{steps.find(s => s.id === (floorStep ? "floor" : tool))?.title ?? (tool === "dimension" ? "Measure another dimension" : "Add a blocking obstacle")}</h3><div className="room-tool-actions"><button disabled={!p.canUndo && !p.pending} onClick={p.onUndo}>↶ Undo</button><button disabled={tool === "review" || tool === "floor-height"} onClick={p.onClear}>Clear this tool</button></div></div>
    {floorStep && <>
      <p>The detected floor levels the view automatically. If it looks wrong, flip it or choose three points on the real floor.</p>
      <div className="room-tool-actions">
        <button aria-pressed={c.flipUp} onClick={() => p.onChange(current => ({ ...current, flipUp: !current.flipUp, reviewed: false }))}>↕ Flip upside-down view</button>
        {scene.floorProposal?.floorPoints?.length === 3 && <button onClick={p.onSuggestedFloor}>Align to detected floor</button>}
        <button onClick={() => { p.onChange(current => ({ ...current, floor: [], boundary: [], spawn: null, reviewed: false })); p.onTool("floor", 0); }}>Pick floor manually</button>
      </div>
      <div className="room-pick-slots">{["Floor origin", "Forward direction", "Third floor point"].map((name, i) => <button key={name} disabled={i > c.floor.length} className={p.target === i ? "active" : ""} onClick={() => p.onTool("floor", i)}><span>{i + 1}</span><strong>{name}</strong><small>{c.floor[i] ? "Selected · click to replace" : "Click, then pick in the room"}</small></button>)}</div>
      <p className="room-help">Use three widely spaced floor points. The second point sets the direction you face when walking.</p>
      <button disabled={!frame} onClick={p.onForward}>Use current view as forward</button>
      <FineFloorControls scene={scene} calibration={c} tool={tool} onChange={p.onChange} onTool={p.onTool} />
    </>}
    {tool === "measurement" && <>
      <p>Measure a real distance with a tape measure, then select those same endpoints in the room. A longer reference usually gives a better scale.</p>
      <div className="room-pick-slots">{["First end", "Second end"].map((name, i) => <button key={name} disabled={i > c.measurement.length} className={p.target === i ? "active" : ""} onClick={() => p.onTool("measurement", i)}><span>{i ? "B" : "A"}</span><strong>{name}</strong><small>{c.measurement[i] ? "Selected · click to replace" : "Click, then pick in the room"}</small></button>)}</div>
      <div className="room-dimension-input"><label>Real distance from A to B<input aria-label="Known real distance" type="number" min={0.05 / units[unit].factor} max={100 / units[unit].factor} step="any" placeholder={unit === "cm" ? "e.g. 210" : "e.g. 2.10"} value={c.meters > 0 ? Number((c.meters / units[unit].factor).toFixed(6)) : ""} onChange={e => p.onChange(current => ({ ...current, meters: Number(e.target.value) * units[unit].factor, reviewed: false }))} /></label><label>Unit<select value={unit} onChange={e => setUnit(e.target.value as Unit)}>{Object.entries(units).map(([key, value]) => <option key={key} value={key}>{value.title}</option>)}</select></label></div>
      {scale && <p className="room-success">Scale preview applied. A → B = {format(c.meters)}. All other rulers now use this scale.</p>}
    </>}
    {tool === "boundary" && <>
      <p>Click corners around the open floor in order. The highlighted area is where you can walk; keep furniture and capture gaps outside it.</p>
      <div className="room-tool-actions"><button disabled={!frame} onClick={p.onTop}>Top view for drawing</button>{scene.floorProposal?.boundary && <button disabled={!frame} onClick={() => p.onChange(current => ({ ...current, boundary: scene.floorProposal!.boundary!.map(value => projectToFloor(value, current, scene)), reviewed: false }))}>Use suggested area</button>}<span className="room-counter">{c.boundary.length} corners · clicks snap to floor</span></div>
      {c.boundary.length > 0 && <div className="room-corner-list">{c.boundary.map((_, i) => <button key={i} className={p.target === i ? "active" : ""} onClick={() => p.onTool("boundary", i)}>Adjust {i + 1}</button>)}<button onClick={() => p.onTool("boundary")}>+ Add corner</button></div>}
    </>}
    {tool === "spawn" && <>
      <p>Click an open place inside the highlighted floor area. Leave room around the start marker for the person-sized walking capsule.</p>
      <div className="room-tool-actions"><button onClick={p.onTop}>Top view</button><span className="room-counter">{c.spawn ? "Start marker placed · click to move it" : "Waiting for a start location"}</span></div>
    </>}
    {tool === "review" && <>
      <div className="room-review-list">{steps.filter(s => s.id !== "review").map(s => <button key={s.id} onClick={() => p.onTool(s.id)}><span>{issues[s.id] ? "○" : "✓"}</span><strong>{s.short}</strong><small>{issues[s.id] ?? (s.id === "measurement" ? format(c.meters) : s.id === "boundary" ? `${c.boundary.length} floor corners` : "Ready")}</small></button>)}</div>
      <p>The collision mesh blocks reconstructed walls and furniture. Review its surfaces and keep the walking area inside the reliable capture.</p>
      <label className="room-review"><input type="checkbox" checked={c.reviewed} onChange={e => p.onChange(current => ({ ...current, reviewed: e.target.checked }))} /> I checked the floor, walking area and collision surfaces.</label>
      <p className="room-help">Walking uses a 1.65 m eye height and a speed of 1.5 m/s.</p>
      {issues.review && <p className="room-help">{issues.review}</p>}
    </>}
    {tool === "dimension" && <>
      <p>Pick two endpoints to add a ruler. Name it in the list below; its length follows your reference scale.</p>
      <p className="room-counter">{p.pending ? "First end selected. Pick the second end." : "Pick the first end of this dimension."}</p>
    </>}
    {tool === "obstacle" && <><p>Pick opposite lower and upper corners of furniture to add an extra blocking box. Choose corners that differ in width, depth and height.</p><p className="room-counter">{p.pending ? "First corner selected. Pick the opposite corner." : "Pick the first corner."} · {c.obstacles.length} added obstacles</p></>}
    {selectedStep >= 0 && selectedStep < steps.length - 1 && <div className="room-wizard-footer"><p className={issues[steps[selectedStep].id] ? "room-help" : "room-success"}>{issues[steps[selectedStep].id] ?? "This step is ready. You can still adjust its markers."}</p><button disabled={!!issues[steps[selectedStep].id]} onClick={next}>Next: {steps[selectedStep + 1].short} →</button></div>}
    <details className="room-dimensions" open={tool === "dimension"}><summary>Room dimensions <span>{c.dimensions?.length ?? 0}</span></summary>
      <p className="room-help">Keep named rulers for room width, length, door openings or ceiling height. Set your reference scale first.</p>
      {c.dimensions?.map(d => <div className="room-dimension-row" key={d.id}><input aria-label="Dimension name" maxLength={80} value={d.name} onChange={e => p.onChange(current => ({ ...current, dimensions: current.dimensions?.map(value => value.id === d.id ? { ...value, name: e.target.value } : value) }))} /><strong>{scale ? format(distance(d.a, d.b) * scale) : "Set scale"}</strong><button aria-label={`Remove ${d.name || "dimension"}`} onClick={() => p.onChange(current => ({ ...current, dimensions: current.dimensions?.filter(value => value.id !== d.id) }))}>Remove</button></div>)}
      <button disabled={!scale || (c.dimensions?.length ?? 0) >= 100} onClick={() => p.onTool("dimension")}>+ Pick a dimension</button>
      <label>Display dimensions in<select value={unit} onChange={e => setUnit(e.target.value as Unit)}>{Object.entries(units).map(([key, value]) => <option key={key} value={key}>{value.title}</option>)}</select></label>
    </details>
    <details className="room-dimensions"><summary>Extra collision obstacles <span>{c.obstacles.length}</span></summary><button disabled={!frame || c.obstacles.length >= 100} onClick={() => p.onTool("obstacle")}>+ Add an obstacle</button>{c.obstacles.map((_, i) => <div className="room-dimension-row" key={i}><span>Obstacle {i + 1}</span><button onClick={() => p.onChange(current => ({ ...current, reviewed: false, obstacles: current.obstacles.filter((_, index) => index !== i) }))}>Remove</button></div>)}</details>
    <div className="room-save-row"><p>{ready ? "Save your settings to open the walking viewer." : "Finish the setup steps and review collisions to enable walking."}</p><button className="room-primary" disabled={!ready || p.loading} onClick={p.onPublish}>{p.loading ? "Saving…" : "Save & open viewer"}</button></div>
    </fieldset>
  </section>;
}
