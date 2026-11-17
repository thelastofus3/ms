import { useEffect, useState } from "react";
import { type Capture, frameCount, isActive, JobProgress, MAX_AVATAR_PHOTOS, MAX_PHOTO_BYTES, MAX_PHOTO_SET_BYTES, MAX_VIDEO_BYTES, MIN_AVATAR_PHOTOS, photoApi, photoRequest, RECOMMENDED_AVATAR_PHOTOS, uploadPhotos, uploadVideo } from "./avatarJobs";

type Source = "video" | "photos";
const isVideoFile = (file: File) => ["video/mp4", "video/quicktime", "video/webm"].includes(file.type) || /\.(mp4|mov|webm)$/i.test(file.name);
const isImageFile = (file: File) => ["image/jpeg", "image/png", "image/webp"].includes(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);

/** Every account builds its own avatars, from one walk-around video or from a ring of photos around the person. */
export function Photos() {
  const [captures, setCaptures] = useState<Capture[]>([]), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0), [buildsAvailable, setBuildsAvailable] = useState(true);
  const [source, setSource] = useState<Source>("video");
  const [video, setVideo] = useState<File | null>(null), [photos, setPhotos] = useState<File[]>([]), [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false), [previews, setPreviews] = useState<string[]>([]);
  const anyActive = captures.some(item => isActive(item.job));
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const refresh = () => photoRequest("", { signal: controller.signal })
      .then(items => { if (active) { setCaptures(items); setLoaded(true); } })
      .catch(e => { if (active && !controller.signal.aborted) setError(e.message); });
    void refresh();
    // Poll only while an avatar is being built; finished sets do not change.
    const timer = anyActive ? setInterval(() => void refresh(), 2000) : undefined;
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [retry, anyActive]);
  useEffect(() => {
    let active = true;
    // A plain request: an informational check must never end the session (photoRequest signs out on 401).
    fetch(`${photoApi}/capabilities`).then(response => response.ok ? response.json() : null)
      .then(value => { if (active && value) setBuildsAvailable(value.generation_available !== false); }).catch(() => { /* Assume builds run; a refused build explains itself. */ });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const files = video ? [video] : photos.slice(0, 12);
    const urls = files.map(file => URL.createObjectURL(file));
    setPreviews(urls);
    return () => urls.forEach(url => URL.revokeObjectURL(url));
  }, [video, photos]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const replace = (id: string, update: Partial<Capture>) => setCaptures(items => items.map(item => item.id === id ? { ...item, ...update } : item));
  const clear = () => { setVideo(null); setPhotos([]); };
  const switchTo = (next: Source) => { if (busy) return; setSource(next); clear(); setError(""); };
  const choose = (selected: File[]) => {
    setError("");
    if (!selected.length) return;
    if (source === "video") {
      if (selected.some(isImageFile)) { setError("These are photos. Switch to \"From photos\" to build an avatar from them."); return; }
      if (!selected.every(isVideoFile)) { setError("Only MP4, MOV and WebM videos are supported."); return; }
      if (selected.length > 1) { setError("Choose one video per avatar."); return; }
      if (selected[0].size > MAX_VIDEO_BYTES) { setError("The video exceeds 1 GB"); return; }
      setVideo(selected[0]); return;
    }
    if (selected.some(isVideoFile)) { setError("This is a video. Switch to \"From a video\" to build an avatar from it."); return; }
    if (!selected.every(isImageFile)) { setError("Only JPEG, PNG and WebP photos are supported."); return; }
    // Added photos join the ones already chosen, so a set can be picked from several folders.
    const next = [...photos, ...selected.filter(file => !photos.some(other => other.name === file.name && other.size === file.size))].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (next.length > MAX_AVATAR_PHOTOS) { setError(`Choose at most ${MAX_AVATAR_PHOTOS} photos.`); return; }
    if (next.some(file => file.size > MAX_PHOTO_BYTES)) { setError("Each photo must be 10 MB or smaller."); return; }
    if (next.reduce((sum, file) => sum + file.size, 0) > MAX_PHOTO_SET_BYTES) { setError("The photos may be 100 MB together. Use smaller JPEGs."); return; }
    setPhotos(next);
  };
  const ready = source === "video" ? !!video : photos.length >= MIN_AVATAR_PHOTOS;
  const save = (andBuild: boolean) => act(async () => {
    if (!ready) return;
    let item: Capture;
    setUploadProgress(0);
    try { item = source === "video" ? await uploadVideo(video!, setUploadProgress) : await uploadPhotos(photos, setUploadProgress); } finally { setUploadProgress(null); }
    clear();
    setCaptures(items => [item, ...items]);
    if (andBuild) { const job = await photoRequest(`/${item.id}/generate`, { method: "POST" }); replace(item.id, { job }); }
  });
  const build = (id: string) => act(async () => replace(id, { job: await photoRequest(`/${id}/generate`, { method: "POST" }) }));
  const cancel = (id: string) => act(async () => replace(id, { job: await photoRequest(`/${id}/job/cancel`, { method: "POST" }) }));
  const remove = (id: string) => act(async () => {
    await photoRequest(`/${id}`, { method: "DELETE" });
    setCaptures(items => items.filter(item => item.id !== id));
  });
  const selectedBytes = (video ? [video] : photos).reduce((sum, file) => sum + file.size, 0);
  return <section className="photo-workspace" aria-label="Avatar sources">
    <div className="photo-upload">
      <h2>New avatar</h2>
      <nav className="room-library-tabs" aria-label="Avatar source">
        <button aria-pressed={source === "video"} disabled={busy} onClick={() => switchTo("video")}>From a video</button>
        <button aria-pressed={source === "photos"} disabled={busy} onClick={() => switchTo("photos")}>From photos</button>
      </nav>
      {source === "video" ? <>
        <p>Film <b>one slow walk around the person</b> with a phone and upload the clip. Sharp frames from all sides are picked automatically.</p>
        <ol className="video-guide">
          <li><b>Stand still.</b> Arms slightly away from the body, feet apart, looking straight ahead.</li>
          <li><b>Circle once in 20–60 s.</b> Start and finish in front of the face; move smoothly, no fast turns.</li>
          <li><b>Whole body in every frame.</b> Hold the phone upright at chest height, 2–3 m away.</li>
          <li><b>Even light, static background.</b> Nobody else walking through the shot.</li>
        </ol>
      </> : <>
        <p>Upload <b>about {RECOMMENDED_AVATAR_PHOTOS} photos taken all around the person</b> — every 15° or so, from {MIN_AVATAR_PHOTOS} up to {MAX_AVATAR_PHOTOS}. Several cameras firing at once work best; one camera works if the person keeps perfectly still.</p>
        <ol className="video-guide">
          <li><b>Same pose in every photo.</b> Arms slightly away from the body, feet apart, looking straight ahead.</li>
          <li><b>A full circle.</b> Front, both sides and back, at the same distance (2–3 m) and chest height; neighbouring photos overlap.</li>
          <li><b>Whole body in every photo,</b> sharp, with the same camera settings and zoom.</li>
          <li><b>Even light, static background.</b> Nobody else in the shot.</li>
        </ol>
      </>}
      <label className="photo-dropzone" data-dragging={dragging} data-selected={!!video || photos.length > 0}
        onDragOver={e => { e.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); if (!busy) choose(Array.from(e.dataTransfer.files)); }}>
        {source === "video"
          ? <input type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" disabled={busy} aria-label="Avatar video" onChange={e => { const selected = Array.from(e.target.files || []); e.target.value = ""; choose(selected); }} />
          : <input type="file" multiple accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" disabled={busy} aria-label="Avatar photos" onChange={e => { const selected = Array.from(e.target.files || []); e.target.value = ""; choose(selected); }} />}
        <strong>{dragging ? "Drop to add" : source === "video" ? "Drop a video here" : photos.length ? "Drop more photos here" : "Drop the photos here"}</strong>
        <span>or click to choose {source === "video" ? "a file" : "files"}</span>
        <small>{source === "video" ? "MP4, MOV or WebM · up to 1 GB · 5 s–10 min" : `JPEG, PNG or WebP · ${MIN_AVATAR_PHOTOS}–${MAX_AVATAR_PHOTOS} photos · up to 10 MB each, 100 MB together`}</small>
      </label>
      {video && <div className="photo-selected-video">
        {previews[0] && <video src={previews[0]} muted playsInline controls preload="metadata" aria-label="Selected video preview" />}
        <p>▶ {video.name} · {(video.size / 1024 ** 2).toFixed(0)} MB</p>
      </div>}
      {photos.length > 0 && <div className="photo-selected-video">
        <div className="photo-set-strip">{previews.map((url, i) => <img key={url} src={url} alt={`Selected photo ${i + 1}`} />)}</div>
        <p>{photos.length} photo{photos.length === 1 ? "" : "s"} · {(selectedBytes / 1024 ** 2).toFixed(0)} MB{photos.length > previews.length ? ` · first ${previews.length} shown` : ""}
          {photos.length < MIN_AVATAR_PHOTOS ? ` · add at least ${MIN_AVATAR_PHOTOS - photos.length} more` : photos.length < RECOMMENDED_AVATAR_PHOTOS ? ` · enough to build; about ${RECOMMENDED_AVATAR_PHOTOS} give a better avatar` : ""}</p>
      </div>}
      {uploadProgress !== null && <div className="avatar-job-bar" role="progressbar" aria-label="Upload" aria-valuenow={Math.round(uploadProgress * 100)}><span style={{ width: `${uploadProgress * 100}%` }} /></div>}
      {(video || photos.length > 0) && <div className="photo-upload-actions">
        {buildsAvailable && <button className="primary" disabled={!loaded || busy || !ready} onClick={() => void save(true)}>
          {uploadProgress !== null ? `Uploading ${Math.round(uploadProgress * 100)}%…` : busy ? "Saving…" : "Upload and build avatar"}</button>}
        <button className={buildsAvailable ? "" : "primary"} disabled={!loaded || busy || !ready} onClick={() => void save(false)}>{!buildsAvailable && uploadProgress !== null ? `Uploading ${Math.round(uploadProgress * 100)}%…` : buildsAvailable ? "Upload only" : "Upload"}</button>
        <button disabled={busy} onClick={clear}>Clear</button>
      </div>}
      {!buildsAvailable && <p className="photo-notice">This server has no GPU worker, so avatars are not built here. Videos and photos you upload are saved to your account.</p>}
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    {!loaded && error && <button onClick={() => { setError(""); setRetry(value => value + 1); }}>Check connection</button>}
    <h2>Your avatar sources</h2>
    {loaded && !captures.length && <p>No videos or photos saved yet.</p>}
    <div className="photo-captures">
      {captures.map(item => {
        const job = item.job, isVideo = item.kind === "video", enough = isVideo || item.photo_count >= MIN_AVATAR_PHOTOS;
        const shown = Math.min(frameCount(item), 8);
        return <article key={item.id} className="photo-set">
          <div className="photo-set-strip">
            {Array.from({ length: shown }, (_, i) => <img key={i} loading="lazy" src={`${photoApi}/${item.id}/photos/${Math.floor(i * frameCount(item) / shown)}`} alt={`${isVideo ? "Frame" : "Photo"} ${i + 1} of the set`} />)}
            {isVideo && !shown && <div className="photo-set-video">▶ Video · frames appear after extraction</div>}
          </div>
          <div className="photo-set-body">
            <div className="photo-set-head">
              <div><strong>{isVideo ? `Video · ${((item.video?.bytes ?? 0) / 1024 ** 2).toFixed(0)} MB${frameCount(item) ? ` · ${frameCount(item)} frames` : ""}` : `${item.photo_count} photos`}</strong>
                <p className="gaussian-note">{isVideo && item.video?.name ? `${decodeURIComponent(item.video.name)} · ` : ""}Saved {new Date(item.created_at).toLocaleString("en-US")}</p></div>
              <div className="photo-set-actions">
                {job?.state === "done" && <a className="workspace-action" href={`#avatar?capture=${item.id}`}>Open avatar →</a>}
                {buildsAvailable && !isActive(job) && <button className={job ? "" : "primary"} disabled={busy || !enough} onClick={() => void build(item.id)}>
                  {job ? job.state === "done" ? "Rebuild" : "Try again" : "Build 3D avatar"}</button>}
                <button disabled={busy || isActive(job)} title={isActive(job) ? "Cancel the build first" : undefined} onClick={() => void remove(item.id)}>Delete set</button>
              </div>
            </div>
            {!job && <p className="gaussian-note">{!enough ? `This set has fewer than ${MIN_AVATAR_PHOTOS} photos, too few for an avatar. Add photos from all sides or upload a walk-around video.` : buildsAvailable ? "No avatar yet. Building takes roughly 20–40 minutes on this GPU; progress appears here." : "Saved. Avatars are built where a GPU worker runs."}</p>}
            {job?.state === "queued" && <p className="gaussian-note">Waiting for the graphics card. A room reconstruction or another avatar build runs first; this one starts by itself when the card is free.</p>}
            {job && <JobProgress captureId={item.id} job={job} onCancel={() => void cancel(item.id)} />}
            {job?.state === "done" && job.result && <p className="gaussian-note">
              {job.result.gaussians.toLocaleString("en-US")} Gaussians · {(job.result.bytes / 1024 ** 2).toFixed(0)} MB
              {job.result.heldOut.psnr !== undefined && ` · quality on unseen frames: PSNR ${job.result.heldOut.psnr.toFixed(1)} dB, SSIM ${job.result.heldOut.ssim?.toFixed(3)}`}
            </p>}
            {job?.state === "done" && !!job.result?.previews.length && <div className="avatar-previews">
              {job.result.previews.map(name => <figure key={name}><img loading="lazy" src={`${photoApi}/${item.id}/avatar/previews/${name}`} alt="Held-out frame and avatar render" /><figcaption>Source frame · avatar render (not used in training)</figcaption></figure>)}
            </div>}
          </div>
        </article>;
      })}
    </div>
  </section>;
}
