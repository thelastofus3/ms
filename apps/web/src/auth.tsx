import { useEffect, useState } from "react";
import { request } from "./space/api";
import type { Account, Role } from "./session";
import { currentAccount, expireSession, sessionRevision } from "./session";
import { AccountQuotaEditor } from "./space/AccountQuota";
import { Icon } from "./Icon";

const base = "/v1/rooms/auth";
type LoginResponse = { account: Account; accessToken: string; tokenType: "Bearer"; expiresIn: number };
export const me = () => request<Account>(`${base}/me`);
export const logout = () => request(`${base}/logout`, {});
export function Login({ onLogin }: { onLogin: (account: Account) => void }) {
  const [username, setUsername] = useState(""), [password, setPassword] = useState("");
  const [registering, setRegistering] = useState(false), [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const changeMode = (register: boolean) => {
    setRegistering(register); setPassword(""); setConfirmation(""); setError("");
  };
  return <main className="auth-page">
    <aside className="auth-intro">
      <div className="auth-intro-brand"><Icon name="cube" /><div>Digital Studio<small>3D workspaces</small></div></div>
      <div className="auth-intro-copy"><p className="eyebrow">A NEW DIMENSION</p><h2>Real spaces.<br />New perspectives.</h2><p>Capture a room, import a Gaussian scene, and explore it in 3D.</p></div>
      <div className="auth-scene" aria-hidden="true">
        <svg viewBox="0 0 580 390" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs><linearGradient id="auth-scene-floor" x1="110" y1="225" x2="460" y2="350" gradientUnits="userSpaceOnUse"><stop stopColor="currentColor" stopOpacity="0.16" /><stop offset="1" stopColor="currentColor" stopOpacity="0.02" /></linearGradient></defs>
          <ellipse className="auth-orbit" cx="290" cy="282" rx="244" ry="79" transform="rotate(-12 290 282)" />
          <path className="auth-scene-surface" d="M120 246 286 165 461 249 291 335Z" fill="url(#auth-scene-floor)" />
          <path className="auth-scene-wall" d="M120 246V96L286 24V165M286 24 461 102V249M120 96 291 178 461 102M291 178V335" />
          <path className="auth-scene-outline" d="M120 246 286 165 461 249 291 335 120 246Z" />
          <path className="auth-scene-grid" d="m155 229 169 89m-132-107 169 89m-132-107 169 89m-74-99-168 83m205-65-168 83m205-65-168 83" />
          <path className="auth-scene-furniture" d="m173 202 57-28 62 30-58 29-61-31Zm0 0v37l61 31 58-29v-37m-58 29v37m91-77 45-22 38 18-45 23-38-19Zm0 0v48l38 19 45-23v-48m-45 23v48" />
          <path className="auth-scene-window" d="m321 62 80 36v77l-80-37V62Zm40 18v76m-40-56 80 37" />
          <g className="auth-scene-points"><circle cx="120" cy="96" r="4" /><circle cx="286" cy="24" r="4" /><circle cx="461" cy="102" r="4" /><circle cx="120" cy="246" r="4" /><circle cx="291" cy="335" r="4" /><circle cx="461" cy="249" r="4" /></g>
        </svg>
      </div>
      <div className="auth-intro-features"><span><Icon name="camera" />Capture</span><span><Icon name="layers" />Import</span><span><Icon name="eye" />Explore</span></div>
    </aside>
    <section className="auth-form-panel"><form className="auth-card" aria-busy={busy} onSubmit={async event => {
    event.preventDefault(); setError("");
    if (registering && password !== confirmation) { setError("Passwords do not match."); return; }
    setBusy(true);
    try { const result = await request<LoginResponse>(`${base}/${registering ? "register" : "login"}`, { username: username.trim(), password }); onLogin(result.account); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }}><p className="eyebrow">{registering ? "YOUR ACCOUNT" : "WELCOME BACK"}</p><h1>{registering ? "Register" : "Sign in"}</h1><p>{registering ? "New accounts can import Gaussian PLY files. An administrator can enable video and photo reconstruction." : "Use your username and password to access your scenes."}</p>
    <label>Username<input autoComplete="username" required minLength={registering ? 3 : undefined} maxLength={registering ? 64 : 100} value={username} disabled={busy} onChange={e => setUsername(e.target.value)} /></label>
    <label>Password<input type="password" autoComplete={registering ? "new-password" : "current-password"} required minLength={registering ? 12 : undefined} maxLength={registering ? 1024 : undefined} aria-describedby={registering ? "registration-password-help" : undefined} value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /></label>
    {registering && <><p id="registration-password-help" className="auth-help">Use a password with 12–1024 characters.</p><label>Confirm password<input type="password" autoComplete="new-password" required minLength={12} maxLength={1024} value={confirmation} disabled={busy} onChange={e => setConfirmation(e.target.value)} /></label></>}
    {error && <p role="alert" className="error">{error}</p>}<button className="auth-submit" disabled={busy || !username.trim() || !password || (registering && !confirmation)}>{busy ? (registering ? "Registering…" : "Signing in…") : (registering ? "Register" : "Sign in")}</button>
    <div className="auth-mode"><span>{registering ? "Already registered?" : "Need an account?"}</span><button type="button" className="auth-mode-button" disabled={busy} onClick={() => changeMode(!registering)}>{registering ? "Back to sign in" : "Register"}</button></div>
  </form></section></main>;
}
const roleOptions = <><option value="ADMIN">Administrator</option><option value="RECONSTRUCTOR">Reconstructor</option><option value="SPLAT_UPLOADER">PLY uploader</option></>;
function AccountEditor({ account, onSave }: { account: Account; onSave: (value: Account) => void }) {
  const [role, setRole] = useState(account.role), [disabled, setDisabled] = useState(account.disabled), [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <form className="account-editor" aria-label={`Edit ${account.username}`} onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError("");
    const requestedRevision = sessionRevision();
    try {
      const updated = await request<Account>(`${base}/users/${encodeURIComponent(account.id)}`, { role, disabled, ...(password ? { password } : {}) }, undefined, "PATCH");
      onSave(updated);
      if (currentAccount()?.id === account.id && (password || updated.role !== account.role || updated.disabled !== account.disabled)) expireSession(requestedRevision);
      setPassword("");
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }}><div className="account-editor-heading"><span className="account-avatar" aria-hidden="true"><Icon name="person" /></span><div><h2>{account.username}</h2><span className="account-role-badge">{account.role === "ADMIN" ? "Administrator" : account.role === "RECONSTRUCTOR" ? "Reconstructor" : "PLY uploader"}</span></div></div><label>Role<select value={role} disabled={busy} onChange={e => setRole(e.target.value as Role)}>{roleOptions}</select></label>
    <label className="account-checkbox"><input type="checkbox" checked={disabled} disabled={busy} onChange={e => setDisabled(e.target.checked)} /> Disabled account</label>
    <label>New password<input type="password" autoComplete="new-password" minLength={12} value={password} disabled={busy} onChange={e => setPassword(e.target.value)} placeholder="Leave blank to keep password" /></label>
    <button disabled={busy}>{busy ? "Saving…" : "Save account"}</button>{error && <p role="alert" className="error">{error}</p>}
  </form>;
}
export function AdminUsers() {
  const [accounts, setAccounts] = useState<Account[]>([]), [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void request<Account[]>(`${base}/users`, undefined, controller.signal).then(setAccounts).catch(e => { if (!controller.signal.aborted) setError(String(e)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  return <main className="admin-page"><header><p className="eyebrow">ADMINISTRATION</p><h1>Accounts</h1><p>Manage registered accounts and assign roles. New accounts start as PLY uploaders. Password, role and disabled changes revoke the account's active access tokens.</p></header>
    {error && <p role="alert" className="error">{error}</p>}{loading && <p role="status">Loading accounts…</p>}
    <div className="account-grid">{accounts.map(account => <section className="account-management" key={account.id} aria-label={`Account ${account.username}`}><AccountEditor account={account} onSave={updated => setAccounts(current => current.map(item => item.id === updated.id ? updated : item))} /><AccountQuotaEditor id={account.id} username={account.username} /></section>)}</div>
  </main>;
}
