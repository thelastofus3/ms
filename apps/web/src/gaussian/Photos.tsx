import { useEffect, useState } from "react";
import { type Capture, frameCount, isActive, JobProgress, MAX_VIDEO_BYTES, MIN_AVATAR_PHOTOS, photoApi, photoRequest, uploadVideo } from "./avatarJobs";

export function Photos({ captureAllowed }: { captureAllowed: boolean }) {
  const [captures, setCaptures] = useState<Capture[]>([]), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  const [video, setVideo] = useState<File | null>(null), [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false), [preview, setPreview] = useState("");
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
    if (!video) { setPreview(""); return; }
    const url = URL.createObjectURL(video);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [video]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const replace = (id: string, update: Partial<Capture>) => setCaptures(items => items.map(item => item.id === id ? { ...item, ...update } : item));
  // New avatars come from one walk-around video; photo sets saved earlier stay usable below.
  const choose = (selected: File[]) => {
    setError("");
    if (!selected.length) return;
    const videos = selected.filter(file => ["video/mp4", "video/quicktime", "video/webm"].includes(file.type) || /\.(mp4|mov|webm)$/i.test(file.name));
    if (selected.some(file => file.type.startsWith("image/"))) { setError("Avatars are built from a video, not from photos. Record one slow walk around the person and upload that file."); return; }
    if (videos.length !== selected.length) { setError("Only MP4, MOV and WebM videos are supported."); return; }
    if (videos.length > 1) { setError("Choose one video per avatar."); return; }
    if (videos[0].size > MAX_VIDEO_BYTES) { setError("The video exceeds 1 GB"); return; }
    setVideo(videos[0]);
  };
  const save = (andBuild: boolean) => act(async () => {
    if (!video) return;
    let item: Capture;
    setUploadProgress(0);
    try { item = await uploadVideo(video, setUploadProgress); } finally { setUploadProgress(null); }
    setVideo(null);
    if (andBuild) item = { ...item, job: await photoRequest(`/${item.id}/generate`, { method: "POST" }) };
    setCaptures(items => [item, ...items]);
  });
  const build = (id: string) => act(async () => replace(id, { job: await photoRequest(`/${id}/generate`, { method: "POST" }) }));
  const cancel = (id: string) => act(async () => replace(id, { job: await photoRequest(`/${id}/job/cancel`, { method: "POST" }) }));
  const remove = (id: string) => act(async () => {
    await photoRequest(`/${id}`, { method: "DELETE" });
    setCaptures(items => items.filter(item => item.id !== id));
  });
  return <section className="photo-workspace" aria-label="Avatar sources">
    {captureAllowed ? <div className="photo-upload">
      <h2>New avatar from a video</h2>
      <p>Film <b>one slow walk around the person</b> with a phone and upload the clip. Sharp frames from all sides are picked automatically.</p>
      <ol className="video-guide">
        <li><b>Stand still.</b> Arms slightly away from the body, feet apart, looking straight ahead.</li>
        <li><b>Circle once in 20–60 s.</b> Start and finish in front of the face; move smoothly, no fast turns.</li>
        <li><b>Whole body in every frame.</b> Hold the phone upright at chest height, 2–3 m away.</li>
        <li><b>Even light, static background.</b> Nobody else walking through the shot.</li>
      </ol>
      <label className="photo-dropzone" data-dragging={dragging} data-selected={!!video}
        onDragOver={e => { e.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); if (!busy) choose(Array.from(e.dataTransfer.files)); }}>
        <input type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" disabled={busy} aria-label="Avatar video"
          onChange={e => { const selected = Array.from(e.target.files || []); e.target.value = ""; choose(selected); }} />
        <strong>{dragging ? "Drop to add" : "Drop a video here"}</strong>
        <span>or click to choose a file</span>
        <small>MP4, MOV or WebM · up to 1 GB · 5 s–10 min</small>
      </label>
      {video && <div className="photo-selected-video">
        {preview && <video src={preview} muted playsInline controls preload="metadata" aria-label="Selected video preview" />}
        <p>▶ {video.name} · {(video.size / 1024 ** 2).toFixed(0)} MB</p>
      </div>}
      {uploadProgress !== null && <div className="avatar-job-bar" role="progressbar" aria-label="Upload" aria-valuenow={Math.round(uploadProgress * 100)}><span style={{ width: `${uploadProgress * 100}%` }} /></div>}
      {video && <div className="photo-upload-actions">
        <button className="primary" disabled={!loaded || busy} onClick={() => void save(true)}>
          {uploadProgress !== null ? `Uploading ${Math.round(uploadProgress * 100)}%…` : busy ? "Saving…" : "Upload and build avatar"}</button>
        <button disabled={!loaded || busy} onClick={() => void save(false)}>Upload only</button>
        <button disabled={busy} onClick={() => setVideo(null)}>Clear</button>
      </div>}
    </div> : <p className="photo-notice">Your saved avatars are available. Uploading videos and building avatars requires a reconstructor or administrator role.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {!loaded && error && <button onClick={() => { setError(""); setRetry(value => value + 1); }}>Check connection</button>}
    <h2>Your avatar sources</h2>
    {loaded && !captures.length && <p>No videos saved yet.</p>}
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
                {captureAllowed && !isActive(job) && <button className={job ? "" : "primary"} disabled={busy || !enough} onClick={() => void build(item.id)}>
                  {job ? job.state === "done" ? "Rebuild" : "Try again" : "Build 3D avatar"}</button>}
                <button disabled={busy || isActive(job)} title={isActive(job) ? "Cancel the build first" : undefined} onClick={() => void remove(item.id)}>Delete set</button>
              </div>
            </div>
            {!job && <p className="gaussian-note">{enough ? "No avatar yet. Building takes roughly 20–40 minutes on this GPU; progress appears here." : `This set has fewer than ${MIN_AVATAR_PHOTOS} photos, too few for an avatar. Upload a walk-around video instead.`}</p>}
            {job?.state === "queued" && <p className="gaussian-note">Waiting for the graphics card. A room reconstruction or another avatar build runs first; this one starts by itself when the card is free.</p>}
            {job && <JobProgress captureId={item.id} job={job} onCancel={captureAllowed ? () => void cancel(item.id) : undefined} />}
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
