import { useEffect, useState, type RefObject } from "react";
import { type Capture, photoApi } from "../gaussian/avatarJobs";
import type { RoomRenderer } from "./renderer";

const STORAGE_KEY = "room-viewer-people-avatar";

/** "Show people as" — markers or one of the account's rigged avatars; the choice is shared by Room viewer and Live cameras. */
export function PeopleAvatarPicker({ renderer, ready }: { renderer: RefObject<RoomRenderer | undefined>; ready: boolean }) {
  const [avatars, setAvatars] = useState<Capture[]>([]), [error, setError] = useState("");
  const [chosen, setChosen] = useState(() => localStorage.getItem(STORAGE_KEY) || "");
  useEffect(() => {
    let active = true;
    // Optional list: a failure (or 401 from the photo service) must not sign the user out.
    fetch(photoApi).then(response => response.ok ? response.json() : [])
      .then((items: Capture[]) => { if (active) setAvatars(items.filter(item => item.job?.state === "done" && item.job.result?.rig)); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const selected = avatars.some(item => item.id === chosen) ? chosen : "";
  useEffect(() => {
    if (!ready) return;
    setError("");
    renderer.current?.setPeopleAvatar(selected ? `${photoApi}/${selected}/avatar/rig` : null)
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [ready, selected, renderer]);
  return <>
    <label className="room-people-avatar">Show people as <select aria-label="Show people as" value={selected} onChange={e => { setChosen(e.target.value); localStorage.setItem(STORAGE_KEY, e.target.value); }}>
      <option value="">Markers</option>
      {avatars.map(item => <option key={item.id} value={item.id}>Avatar · {item.kind === "video" ? "video" : `${item.photo_count} photos`} · {new Date(item.created_at).toLocaleDateString("en-US")}</option>)}
    </select>{!avatars.length && <a href="#photos">Build an avatar</a>}</label>
    {error && <p className="room-help" role="status">The avatar could not be shown: {error} Markers are used instead.</p>}
  </>;
}
