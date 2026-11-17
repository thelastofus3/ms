import { useEffect, useState, type RefObject } from "react";
import { type Capture, photoApi } from "../gaussian/avatarJobs";
import type { RoomRenderer } from "./renderer";
import { avatarLabel, rigUrl, setRecognitionEnabled, useRecognitionEnabled } from "./tracking/recognition";

const STORAGE_KEY = "room-viewer-people-avatar";
/**
 * The avatar built from the 24-photo capture, served to every account as static files next to the app (not from anyone's
 * library, and not in git: it is a photographic likeness). It is the look of people until a user picks another one.
 */
export const DEFAULT_AVATAR = "default", DEFAULT_AVATAR_URL = "/default-avatar";

/**
 * How people appear in the room: someone recognised by face wears their own avatar, everyone else the look chosen here
 * (a green marker or one of the account's avatars). The choices are shared by Room viewer and Live cameras.
 */
export function PeopleAvatarPicker({ renderer, ready }: { renderer: RefObject<RoomRenderer | undefined>; ready: boolean }) {
  const [avatars, setAvatars] = useState<Capture[]>([]), [error, setError] = useState("");
  // Nothing stored yet means nobody chose: the default avatar. An explicit "Green markers" is stored as "".
  const [chosen, setChosen] = useState(() => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_AVATAR);
  const [defaultAvailable, setDefaultAvailable] = useState(false);
  const recognize = useRecognitionEnabled();
  useEffect(() => {
    let active = true;
    // Optional list: a failure (or 401 from the photo service) must not sign the user out.
    fetch(photoApi).then(response => response.ok ? response.json() : [])
      .then((items: Capture[]) => { if (active) setAvatars(items.filter(item => item.job?.state === "done" && item.job.result?.rig)); }).catch(() => {});
    // A single-page fallback answers unknown paths with index.html and 200, so the answer must also be JSON.
    fetch(`${DEFAULT_AVATAR_URL}/manifest.json`, { method: "HEAD" })
      .then(response => { if (active) setDefaultAvailable(response.ok && !!response.headers.get("content-type")?.includes("json")); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const selected = chosen === DEFAULT_AVATAR ? defaultAvailable ? DEFAULT_AVATAR : "" : avatars.some(item => item.id === chosen) ? chosen : "";
  useEffect(() => {
    if (!ready) return;
    setError("");
    renderer.current?.setPeopleAvatar(selected === DEFAULT_AVATAR ? DEFAULT_AVATAR_URL : selected ? rigUrl(selected) : null)
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [ready, selected, renderer]);
  useEffect(() => { if (ready) renderer.current?.setPersonalAvatars(recognize ? rigUrl : null); }, [ready, recognize, renderer]);
  return <>
    <label className="room-people-recognition"><input type="checkbox" checked={recognize} onChange={e => setRecognitionEnabled(e.target.checked)} /> Recognize people by face</label>
    <label className="room-people-avatar">{recognize ? "Unrecognized people as" : "Show people as"} <select aria-label="Show people as" value={selected} onChange={e => { setChosen(e.target.value); localStorage.setItem(STORAGE_KEY, e.target.value); }}>
      <option value="">Green markers</option>
      {defaultAvailable && <option value={DEFAULT_AVATAR}>Default avatar · 24 photos</option>}
      {avatars.map(item => <option key={item.id} value={item.id}>{avatarLabel(item)}</option>)}
    </select>{!avatars.length && !defaultAvailable && <a href="#photos">Build an avatar</a>}</label>
    {error && <p className="room-help" role="status">The avatar could not be shown: {error} Markers are used instead.</p>}
  </>;
}
