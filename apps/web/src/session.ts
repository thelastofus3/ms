export type Role = "ADMIN" | "RECONSTRUCTOR" | "SPLAT_UPLOADER";
export type Account = { id: string; username: string; role: Role; disabled: boolean };
let account: Account | null = null;
let revision = 0;
export const currentAccount = () => account;
export const sessionRevision = () => revision;
export const setCurrentAccount = (value: Account | null) => { ++revision; account = value; };
export const canUploadCapture = (value: Account) => value.role === "ADMIN" || value.role === "RECONSTRUCTOR";
export const sessionExpiredEvent = "room-session-expired";
export function expireSession(expectedRevision = revision) {
  if (expectedRevision !== revision) return;
  setCurrentAccount(null);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(sessionExpiredEvent));
}
