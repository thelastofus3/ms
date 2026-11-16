import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { CameraTracking } from "./CameraTracking";
import { sharedPeople } from "./fusion";
import type { CameraCaptureControl, LiveCameraState } from "./types";

const MAX_CAMERAS = 4;
/** Several cameras running at once in this browser; each keeps capturing while another one is on screen. */
export function CameraDeck({ jobId, active = true, onState, controlRef }: { jobId: string; active?: boolean; onState?: (state: LiveCameraState | null) => void; controlRef?: MutableRefObject<CameraCaptureControl | null> }) {
  const [slots, setSlots] = useState([1]), [current, setCurrent] = useState(1), [states, setStates] = useState<Record<number, LiveCameraState | null>>({});
  const nextSlot = useRef(2), shared = useRef(sharedPeople(jobId)), controls = useRef(new Map<number, MutableRefObject<CameraCaptureControl | null>>()), onStateRef = useRef(onState);
  onStateRef.current = onState;
  const control = (slot: number) => { let ref = controls.current.get(slot); if (!ref) { ref = { current: null }; controls.current.set(slot, ref); } return ref; };
  useEffect(() => {
    if (!controlRef) return;
    const all = { stopCamera: () => controls.current.forEach(ref => ref.current?.stopCamera()) }; controlRef.current = all;
    return () => { if (controlRef.current === all) controlRef.current = null; };
  }, [controlRef]);
  useEffect(() => {
    // The rest of the app follows one summary: the camera that is tracking, else any running one.
    const known = slots.flatMap(slot => states[slot] ? [states[slot]!] : []), running = known.filter(state => state.cameraRunning);
    const primary = running.find(state => state.tracking) ?? running[0] ?? states[current] ?? known[0];
    onStateRef.current?.(primary ? { ...primary, name: running.length > 1 ? `${running.length} cameras` : primary.name, cameraRunning: running.length > 0, tracking: running.some(state => state.tracking),
      detectedCount: Math.max(0, ...known.map(state => state.detectedCount)), positionedCount: known.reduce((sum, state) => sum + state.positionedCount, 0), estimatedCount: known.reduce((sum, state) => sum + (state.estimatedCount ?? 0), 0) } : null);
  }, [states, slots, current]);
  useEffect(() => () => onStateRef.current?.(null), []);
  const add = () => { const slot = nextSlot.current++; setSlots(value => [...value, slot]); setCurrent(slot); };
  const remove = (slot: number) => {
    controls.current.get(slot)?.current?.stopCamera(); controls.current.delete(slot);
    const rest = slots.filter(value => value !== slot);
    setSlots(rest); setStates(({ [slot]: _removed, ...kept }) => kept); if (current === slot) setCurrent(rest[0]);
  };
  const deck = jobId ? <nav className="camera-deck" aria-label="Cameras in this browser">
    {slots.map((slot, index) => {
      const state = states[slot];
      return <button key={slot} aria-pressed={slot === current} data-state={state?.tracking ? "tracking" : state?.cameraRunning ? "running" : "idle"} onClick={() => setCurrent(slot)}>
        <span aria-hidden="true" />Camera {index + 1}<small>{state?.tracking ? `${state.name} · live` : state?.cameraRunning ? `${state.name} · on` : "Off"}</small>
      </button>;
    })}
    <button className="camera-deck-add" disabled={slots.length >= MAX_CAMERAS} onClick={add}>+ Add camera</button>
    {slots.length > 1 && <button className="camera-deck-remove" onClick={() => remove(current)}>Remove this camera</button>}
    {slots.length > 1 && <p>Give each camera its own video source and saved configuration. A person seen by several cameras becomes one marker, placed where their views cross.</p>}
  </nav> : undefined;
  return <>{slots.map(slot => <CameraTracking key={slot} jobId={jobId} active={active && slot === current} deck={deck} shared={shared.current} source={`slot-${slot}`}
    onState={state => setStates(value => value[slot] === state ? value : { ...value, [slot]: state })} controlRef={control(slot)} />)}</>;
}
