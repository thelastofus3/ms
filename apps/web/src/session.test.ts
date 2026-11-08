import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { currentAccount, expireSession, sessionRevision, setCurrentAccount } from "./session";
import { request } from "./space/api";
const account = { id: "account", username: "tester", role: "RECONSTRUCTOR", disabled: false } as const;
beforeEach(() => {
  setCurrentAccount(account);
  vi.stubGlobal("location", { hash: "#rooms", pathname: "/", search: "" });
});
afterEach(() => vi.unstubAllGlobals());
it("expires the current session after a protected request returns 401", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Sign in again" }), { status: 401 })));
  await expect(request("/v1/rooms/jobs")).rejects.toThrow("Sign in again");
  expect(currentAccount()).toBeNull();
});
it("a late 401 from a previous login cannot expire a newly established session for the same account", async () => {
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const pending = request("/v1/rooms/jobs");
  await vi.waitFor(() => expect(finish).toBeDefined());
  setCurrentAccount(null); setCurrentAccount(account);
  finish(new Response(JSON.stringify({ message: "Old session expired" }), { status: 401 }));
  await expect(pending).rejects.toThrow("Old session expired");
  expect(currentAccount()).toEqual(account);
});
it("ignores stale session expiration and still expires the current session", () => {
  const oldRevision = sessionRevision();
  setCurrentAccount(null); setCurrentAccount(account);
  expireSession(oldRevision);
  expect(currentAccount()).toEqual(account);
  expireSession(sessionRevision());
  expect(currentAccount()).toBeNull();
});
