import { useState } from "react";
import { adjustFloor, floorFrame, metersPerUnit, vector } from "./calibration";
import type { ChangeCalibration } from "./CalibrationPanel";
import type { Calibration, CalibrationTool, RoomManifest } from "./types";

type Props = {
  scene: RoomManifest; calibration: Calibration; tool: CalibrationTool;
  onChange: ChangeCalibration; onTool: (tool: CalibrationTool, target?: number) => void;
};
export function FineFloorControls(p: Props) {
  const [height, setHeight] = useState("0"), [pitch, setPitch] = useState("0"), [roll, setRoll] = useState("0");
  const c = p.calibration, frame = floorFrame(c, p.scene), scale = metersPerUnit(c);
  const heightValue = Number(height), pitchValue = Number(pitch), rollValue = Number(roll);
  const validHeight = height.trim() !== "" && Number.isFinite(heightValue) && Math.abs(heightValue) <= 500;
  const validTilt = pitch.trim() !== "" && roll.trim() !== "" && Number.isFinite(pitchValue) && Number.isFinite(rollValue) && Math.hypot(pitchValue, rollValue) <= 15;
  const detected = p.scene.floorProposal?.floorPoints?.length === 3 ? floorFrame({ ...c, floor: p.scene.floorProposal.floorPoints, flipUp: false }, p.scene) : undefined;
  const angle = frame && detected ? Math.acos(Math.min(1, Math.max(0, Math.abs(frame.up.dot(detected.up))))) * 180 / Math.PI : undefined;
  const elevations = detected && scale ? c.boundary.map(value => vector(value).sub(detected.origin).dot(detected.up) * scale * 100) : [];
  const signed = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
  const change = (adjustment: { height?: number; pitchDegrees?: number; rollDegrees?: number }) => p.onChange(current => adjustFloor(current, p.scene, adjustment));
  return <section className="room-fine-floor" aria-label="Fine floor adjustment">
    <div className="room-fine-floor-heading"><h4>Set floor level & fine tilt</h4><span>Small corrections, no new floor markers</span></div>
    <p>The walking area follows this floor plane. Pick a visible point on the real floor to set its height, then fine-tune any remaining slope.</p>
    <div className="room-tool-actions">
      <button disabled={!frame} aria-pressed={p.tool === "floor-height"} onClick={() => p.onTool("floor-height")}>Click real floor to set level</button>
      {p.tool === "floor-height" && <button onClick={() => p.onTool("floor")}>Cancel floor-level picker</button>}
    </div>
    {p.tool === "floor-height" && <p className="room-success" role="status">Click the visible real floor in the room. This moves the floor level without changing its tilt.</p>}
    <div className="room-floor-adjustment">
      <div><h5>Height</h5><p className="room-help">Raise or lower the floor; area corners and the start marker stay on it.</p></div>
      <div className="room-floor-nudges"><button disabled={!frame || !scale} aria-label="Lower floor by 1 centimetre" onClick={() => change({ height: -0.01 })}>Down 1 cm</button><button disabled={!frame || !scale} aria-label="Raise floor by 1 centimetre" onClick={() => change({ height: 0.01 })}>Up 1 cm</button></div>
      <div className="room-floor-offset"><label>Height offset (cm)<input type="number" step="0.1" min="-500" max="500" disabled={!frame || !scale} value={height} onChange={event => setHeight(event.target.value)} /></label><button disabled={!frame || !scale || !validHeight || heightValue === 0} onClick={() => { change({ height: heightValue / 100 }); setHeight("0"); }}>Apply height</button></div>
      {!scale && <p className="room-help">Set a known distance to use centimetres. The floor-level picker works before scale is set. <button className="room-inline-action" onClick={() => p.onTool("measurement")}>Set known distance</button></p>}
    </div>
    <div className="room-floor-adjustment">
      <div><h5>Tilt</h5><p className="room-help">Pitch raises the forward edge. Positive roll lowers the right edge.</p></div>
      <div className="room-floor-nudge-row"><strong>Pitch</strong><div className="room-floor-nudges"><button disabled={!frame} aria-label="Lower forward edge by 0.1 degrees" onClick={() => change({ pitchDegrees: -0.1 })}>−0.1°</button><button disabled={!frame} aria-label="Raise forward edge by 0.1 degrees" onClick={() => change({ pitchDegrees: 0.1 })}>+0.1°</button></div></div>
      <div className="room-floor-nudge-row"><strong>Roll</strong><div className="room-floor-nudges"><button disabled={!frame} aria-label="Raise right edge by 0.1 degrees" onClick={() => change({ rollDegrees: -0.1 })}>−0.1°</button><button disabled={!frame} aria-label="Lower right edge by 0.1 degrees" onClick={() => change({ rollDegrees: 0.1 })}>+0.1°</button></div></div>
      <div className="room-floor-tilt-inputs"><label>Pitch offset (°)<input type="number" step="0.1" min="-15" max="15" disabled={!frame} value={pitch} onChange={event => setPitch(event.target.value)} /></label><label>Roll offset (°)<input type="number" step="0.1" min="-15" max="15" disabled={!frame} value={roll} onChange={event => setRoll(event.target.value)} /></label><button disabled={!frame || !validTilt || pitchValue === 0 && rollValue === 0} onClick={() => { change({ pitchDegrees: pitchValue, rollDegrees: rollValue }); setPitch("0"); setRoll("0"); }}>Apply tilt</button></div>
      <p className="room-help">Offsets apply to the current floor. Use small changes, then inspect walls and floor edges. Tilt is limited to 15° per adjustment.</p>
    </div>
    {angle !== undefined && <div className="room-floor-estimate"><p>Floor tilt differs by <strong>{angle.toFixed(2)}°</strong> from the detected plane.</p>{elevations.length > 0 && elevations.every(Number.isFinite) && <p>Walking-area height relative to detection: <strong>{signed(Math.min(...elevations))} to {signed(Math.max(...elevations))} cm</strong>.</p>}<p className="room-help">Detection is an estimate. Confirm the visible floor with your capture or a real measurement.</p></div>}
  </section>;
}
