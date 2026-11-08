import { useEffect, useState } from "react";
import * as api from "./api";

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 2 })} GiB`;
const date = (value: string) => new Date(value).toLocaleString("en-US");

export function AccountQuota({ revision, uploading }: { revision: number; uploading: boolean }) {
  const [usage, setUsage] = useState<api.RoomQuota | null>(null), [error, setError] = useState("");
  const [discardError, setDiscardError] = useState("");
  const [discarding, setDiscarding] = useState<string | null>(null), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = async () => {
      try {
        const result = await api.quota(controller.signal);
        if (!Array.isArray(result.uploads) || !Number.isFinite(result.storageChargedBytes)) throw Error("Room account allowance is unavailable.");
        if (!controller.signal.aborted) { setUsage(result); setError(""); }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void update(), 3000); }
    };
    void update();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [revision, refresh]);
  const discard = async (id: string) => {
    setDiscarding(id); setDiscardError("");
    try { await api.discardUpload(id); setRefresh(value => value + 1); }
    catch (e) { setDiscardError(e instanceof Error ? e.message : String(e)); }
    finally { setDiscarding(null); }
  };
  return <section className="room-quota" aria-label="Room account allowance">
    <h2>Account allowance</h2>
    {usage ? <>
      <div className="room-quota-summary">
        <div className="room-quota-storage"><p><strong id="room-storage-label">Storage used or reserved</strong><span>{gib(usage.storageChargedBytes)} / {gib(usage.storageLimitBytes)}</span></p><meter min={0} max={usage.storageLimitBytes} value={Math.min(usage.storageChargedBytes, usage.storageLimitBytes)} aria-labelledby="room-storage-label" aria-valuetext={`${gib(usage.storageChargedBytes)} / ${gib(usage.storageLimitBytes)}`} /></div>
        <p className="room-quota-stat"><span>Pending uploads:</span>{" "}<strong>{usage.pendingUploads} / {usage.pendingUploadLimit}</strong></p>
        <p className="room-quota-stat"><span>Active jobs:</span>{" "}<strong>{usage.activeJobs} / {usage.activeJobLimit}</strong></p>
      </div>
      <p className="room-help room-quota-note">{gib(usage.storageConfirmedBytes)} confirmed. Includes room inputs, private copies and retained results. Reservations remain charged until cleanup completes.</p>
      {usage.uploads.length > 0 && <details open><summary>Unattached uploads ({usage.uploads.length})</summary><ul className="room-quota-uploads">{usage.uploads.map(upload => <li key={upload.id}>
        <strong>{upload.kind === "splat" ? "Gaussian PLY" : "Room capture"}</strong>
        <small>{upload.sealed ? "Upload complete" : "Upload unfinished"}{upload.createdAt ? ` · Created ${date(upload.createdAt)}` : ""}</small>
        {upload.discardedAt ? <p>Closed. Storage cleanup may still be pending.</p> : upload.expiresAt ? <p>Expires {date(upload.expiresAt)}</p> : <p>Preserved legacy upload</p>}
        {upload.discardable && !upload.discardedAt && <button className="button-danger" disabled={uploading || discarding !== null} onClick={() => void discard(upload.id)}>{discarding === upload.id ? "Discarding…" : "Discard upload"}</button>}
      </li>)}</ul><p className="room-help">Discard removes an unattached upload and its resume session. Select the same files to start again. Attached inputs are retained.</p></details>}
    </> : !error && <p role="status">Loading allowance…</p>}
    {error && <p className="room-error" role="alert">{error}</p>}
    {discardError && <p className="room-error" role="alert">{discardError}</p>}
  </section>;
}

export function AccountQuotaEditor({ id, username }: { id: string; username: string }) {
  const [storage, setStorage] = useState(""), [pending, setPending] = useState(""), [active, setActive] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [status, setStatus] = useState("");
  const assign = (limits: api.QuotaLimits) => { setStorage(String(limits.storageLimitBytes / 1024 ** 3)); setPending(String(limits.pendingUploadLimit)); setActive(String(limits.activeJobLimit)); };
  useEffect(() => {
    const controller = new AbortController();
    void api.accountQuota(id, controller.signal).then(result => { if (!controller.signal.aborted) assign(result); })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id]);
  return <form className="account-editor account-quota-editor" aria-label={`Quota limits for ${username}`} aria-busy={loading || busy} onSubmit={async event => {
    event.preventDefault(); setError(""); setStatus("");
    const limits = { storageLimitBytes: Number(storage) * 1024 ** 3, pendingUploadLimit: Number(pending), activeJobLimit: Number(active) };
    if (!Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0) || limits.pendingUploadLimit > 2147483647 || limits.activeJobLimit > 2147483647) {
      setError("Use a positive storage limit and positive whole-number upload and job limits."); return;
    }
    setBusy(true);
    try { assign(await api.saveAccountQuota(id, limits)); setStatus("Limits saved"); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }}>
    <h2>Room limits</h2><p className="auth-help">Lowering limits retains existing data. New allocations wait until usage is below the limit. These limits also apply to administrators.</p>
    {loading && <p role="status">Loading limits…</p>}
    <label>Storage limit (GiB)<input type="number" min="0.000000001" step="any" required value={storage} disabled={loading || busy} onChange={e => { setStorage(e.target.value); setStatus(""); }} /></label>
    <label>Pending upload limit<input type="number" min="1" max="2147483647" step="1" required value={pending} disabled={loading || busy} onChange={e => { setPending(e.target.value); setStatus(""); }} /></label>
    <label>Active job limit<input type="number" min="1" max="2147483647" step="1" required value={active} disabled={loading || busy} onChange={e => { setActive(e.target.value); setStatus(""); }} /></label>
    <button disabled={loading || busy}>{busy ? "Saving…" : "Save limits"}</button>
    {error && <p role="alert" className="error">{error}</p>}{status && <p role="status">{status}</p>}
  </form>;
}
