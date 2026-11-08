import { useEffect, useState } from "react";
import { type Capture, frameCount, isActive, JobProgress, MAX_VIDEO_BYTES, MIN_AVATAR_PHOTOS, photoApi, photoRequest, uploadVideo } from "./avatarJobs";

export function Photos({ captureAllowed }: { captureAllowed: boolean }) {
  const [files, setFiles] = useState<File[]>([]), [previews, setPreviews] = useState<string[]>([]);
  const [captures, setCaptures] = useState<Capture[]>([]), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  const [video, setVideo] = useState<File | null>(null), [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
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
    const urls = files.map(file => URL.createObjectURL(file));
    setPreviews(urls);
    return () => urls.forEach(url => URL.revokeObjectURL(url));
  }, [files]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const replace = (id: string, update: Partial<Capture>) => setCaptures(items => items.map(item => item.id === id ? { ...item, ...update } : item));
  // One drop zone: several images become a photo set, a single video becomes a video set.
  const choose = (selected: File[]) => {
    setError("");
    if (!selected.length) return;
    const videos = selected.filter(file => file.type.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(file.name));
    const images = selected.filter(file => file.type.startsWith("image/"));
    if (videos.length && (images.length || videos.length > 1)) { setError("Choose either photos or one video, not both."); return; }
    if (images.length + videos.length !== selected.length) { setError("Only JPEG, PNG and WebP photos or MP4, MOV and WebM videos are supported."); return; }
    if (videos.length) {
      if (videos[0].size > MAX_VIDEO_BYTES) { setError("The video exceeds 1 GB"); return; }
      setFiles([]); setVideo(videos[0]); return;
    }
    if (images.length > 32 || images.some(file => file.size > 10 * 1024 * 1024) || images.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) {
      setError("Up to 32 photos, 10 MB per photo and 100 MB per set"); return;
    }
    setVideo(null); setFiles(images);
  };
  const save = (andBuild: boolean) => act(async () => {
    let item: Capture;
    if (video) {
      setUploadProgress(0);
      try { item = await uploadVideo(video, setUploadProgress); } finally { setUploadProgress(null); }
    } else {
      const body = new FormData();
      files.forEach(file => body.append("photos", file));
      item = await photoRequest("", { method: "POST", body });
    }
    setFiles([]); setVideo(null);
    if (andBuild) item = { ...item, job: await photoRequest(`/${item.id}/generate`, { method: "POST" }) };
    setCaptures(items => [item, ...items]);
  });
  const build = (id: string) => act(async () => replace(id, { job: await photoRequest(`/${id}/generate`, { method: "POST" }) }));
  const cancel = (id: string) => act(async () => replace(id, { job: await photoRequest(`/${id}/job/cancel`, { method: "POST" }) }));
  const remove = (id: string) => act(async () => {
    await photoRequest(`/${id}`, { method: "DELETE" });
    setCaptures(items => items.filter(item => item.id !== id));
  });
  return <section className="photo-workspace" aria-label="Photo sets">
    {captureAllowed ? <div className="photo-upload">
      <h2>New avatar source</h2>
      <p>Either <b>{MIN_AVATAR_PHOTOS}–32 photos</b> of one person from all around (ideally 20–30), or <b>one video</b> walking slowly around them
        (20–60 s, whole body in frame). The person stands still, arms slightly away from the body; a textured, static background helps.</p>
      <label className="photo-dropzone" data-dragging={dragging} data-selected={!!files.length || !!video}
        onDragOver={e => { e.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); if (!busy) choose(Array.from(e.dataTransfer.files)); }}>
        <input type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" disabled={busy} aria-label="Photos or a video"
          onChange={e => { const selected = Array.from(e.target.files || []); e.target.value = ""; choose(selected); }} />
        <strong>{dragging ? "Drop to add" : "Drop photos or a video here"}</strong>
        <span>or click to choose files</span>
        <small>Photos: JPEG, PNG or WebP · up to 32 · 10 MB each · 100 MB total — Video: MP4, MOV or WebM · up to 1 GB · 5 s–10 min</small>
      </label>
      {!!previews.length && <div className="photo-previews">{previews.map((url, i) => <img key={url} src={url} alt={`Selected photo ${i + 1}`} />)}</div>}
      {video && <p className="photo-selected-video">▶ {video.name} · {(video.size / 1024 ** 2).toFixed(0)} MB</p>}
      {!!files.length && files.length < MIN_AVATAR_PHOTOS && <p className="gaussian-note">{files.length} photo{files.length === 1 ? "" : "s"} selected — an avatar needs at least {MIN_AVATAR_PHOTOS}; you can still save them.</p>}
      {uploadProgress !== null && <div className="avatar-job-bar" role="progressbar" aria-label="Upload" aria-valuenow={Math.round(uploadProgress * 100)}><span style={{ width: `${uploadProgress * 100}%` }} /></div>}
      {(!!files.length || video) && <div className="photo-upload-actions">
        <button className="primary" disabled={!loaded || busy || (!video && files.length < MIN_AVATAR_PHOTOS)} onClick={() => void save(true)}>
          {uploadProgress !== null ? `Uploading ${Math.round(uploadProgress * 100)}%…` : busy ? "Saving…" : "Upload and build avatar"}</button>
        <button disabled={!loaded || busy} onClick={() => void save(false)}>Upload only</button>
        <button disabled={busy} onClick={() => { setFiles([]); setVideo(null); }}>Clear</button>
      </div>}
    </div> : <p className="photo-notice">Your saved sets are available. Uploading new photos and building avatars requires a reconstructor or administrator role.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {!loaded && error && <button onClick={() => { setError(""); setRetry(value => value + 1); }}>Check connection</button>}
    <h2>Saved sets</h2>
    {loaded && !captures.length && <p>No saved photo sets yet.</p>}
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
            {!job && <p className="gaussian-note">{enough ? "No avatar yet. Building takes roughly 20–40 minutes on this GPU; progress appears here." : `Add at least ${MIN_AVATAR_PHOTOS} photos to build an avatar.`}</p>}
            {job && <JobProgress captureId={item.id} job={job} onCancel={captureAllowed ? () => void cancel(item.id) : undefined} />}
            {job?.state === "done" && job.result && <p className="gaussian-note">
              {job.result.gaussians.toLocaleString("en-US")} Gaussians · {(job.result.bytes / 1024 ** 2).toFixed(0)} MB
              {job.result.heldOut.psnr !== undefined && ` · quality on unseen photos: PSNR ${job.result.heldOut.psnr.toFixed(1)} dB, SSIM ${job.result.heldOut.ssim?.toFixed(3)}`}
            </p>}
            {job?.state === "done" && !!job.result?.previews.length && <div className="avatar-previews">
              {job.result.previews.map(name => <figure key={name}><img loading="lazy" src={`${photoApi}/${item.id}/avatar/previews/${name}`} alt="Held-out photo and avatar render" /><figcaption>Photo · avatar render (not used in training)</figcaption></figure>)}
            </div>}
          </div>
        </article>;
      })}
    </div>
  </section>;
}
