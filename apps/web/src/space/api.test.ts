import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request, upload } from "./api";
import { setCurrentAccount } from "../session";

const storageKey = "room-upload-draft-v2:test-account:capture";
const capture = () => new File(["capture"], "room.mp4", { type: "video/mp4", lastModified: 123 });
const queued = { id: "job-id", name: "My room", state: "QUEUED" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("resumable room uploads", () => {
  let values: Map<string, string>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let sent: Blob[];

  beforeEach(() => {
    setCurrentAccount({ id: "test-account", username: "tester", role: "RECONSTRUCTOR", disabled: false });
    values = new Map();
    fetchMock = vi.fn();
    sent = [];
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { hash: "#rooms", pathname: "/", search: "" });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    });
    vi.stubGlobal("XMLHttpRequest", class {
      upload = {};
      status = 200;
      onload?: () => void;
      open() {}
      getResponseHeader() { return "part-etag"; }
      send(blob: Blob) { sent.push(blob); this.onload?.(); }
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function saveDraft(file: File, parts = [{ number: 0, etag: "complete" }]) {
    const draft = {
      fingerprint: JSON.stringify([[file.name, file.size, file.lastModified]]),
      uploadId: "saved-upload", completed: [{ key: "input-key", parts }], jobKey: "saved-job-key",
    };
    values.set(storageKey, JSON.stringify(draft));
    return values.get(storageKey);
  }

  const run = (file: File) => upload([file], "My room", "local", new AbortController().signal, vi.fn());

  it("retains the quota dimension and code on a capacity rejection", async () => {
    fetchMock.mockResolvedValueOnce(json({ message: "Active job limit reached", code: "QUOTA_EXCEEDED", dimension: "activeJobs" }, 409));
    await expect(request("/v1/rooms/jobs", {})).rejects.toMatchObject({
      message: "Active job limit reached", status: 409, code: "QUOTA_EXCEEDED", dimension: "activeJobs",
    });
  });

  it("keeps the exact saved job request after a full quota and retries when capacity returns", async () => {
    const file = capture(); saveDraft(file);
    fetchMock.mockResolvedValueOnce(json({ id: "saved-upload", sealed: true, files: [] }))
      .mockResolvedValueOnce(json({ sealed: true }))
      .mockResolvedValueOnce(json({ message: "Active job limit reached", code: "QUOTA_EXCEEDED", dimension: "activeJobs" }, 409))
      .mockResolvedValueOnce(json({ id: "saved-upload", sealed: true, files: [] }))
      .mockResolvedValueOnce(json({ sealed: true })).mockResolvedValueOnce(json(queued));
    await expect(run(file)).rejects.toThrow("Active job limit reached");
    const preserved = JSON.parse(values.get(storageKey)!);
    expect(preserved.jobKey).toBe("saved-job-key");
    expect(preserved.jobRequest).toEqual({ name: "My room", profile: "local" });
    await upload([file], "Edited", "quality", new AbortController().signal, vi.fn());
    expect(fetchMock.mock.calls.filter(([path]) => path === "/v1/rooms/jobs").map(([, options]) => JSON.parse(options.body))).toEqual([
      { uploadId: "saved-upload", name: "My room", profile: "local", idempotencyKey: "saved-job-key" },
      { uploadId: "saved-upload", name: "My room", profile: "local", idempotencyKey: "saved-job-key" },
    ]);
    expect(sent).toHaveLength(0);
  });

  it("shows the gateway's session expiry and permits a fresh declaration on retry", async () => {
    const file = capture();
    vi.stubGlobal("XMLHttpRequest", class {
      upload = {}; status = 410;
      responseText = JSON.stringify({ message: "This upload has expired. Start a new upload." });
      onload?: () => void;
      open() {}
      send() { this.onload?.(); }
    });
    fetchMock.mockResolvedValueOnce(json({ id: "expired", files: [{ key: "old-key", url: "/gateway" }] }));
    await expect(run(file)).rejects.toThrow("This upload has expired. Start a new upload.");
    expect(JSON.parse(values.get(storageKey)!).uploadId).toBe("expired");
    fetchMock.mockResolvedValueOnce(json({ message: "Expired" }, 410))
      .mockResolvedValueOnce(json({ id: "fresh", sealed: true, files: [] }))
      .mockResolvedValueOnce(json({ sealed: true })).mockResolvedValueOnce(json(queued));
    await expect(run(file)).resolves.toEqual(queued);
    expect(fetchMock.mock.calls[2][0]).toBe("/v1/rooms/uploads");
  });

  it("recovers a sealed upload without write operations or retransmitting files", async () => {
    const file = capture(); saveDraft(file, []);
    const progress = vi.fn();
    fetchMock
      .mockResolvedValueOnce(json({ id: "saved-upload", kind: "capture", sealed: true, files: [] }))
      .mockResolvedValueOnce(json({ id: "saved-upload", sealed: true }))
      .mockResolvedValueOnce(json(queued));

    await expect(upload([file], "My room", "local", new AbortController().signal, progress)).resolves.toEqual(queued);
    expect(sent).toHaveLength(0);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      "/v1/rooms/uploads/saved-upload", "/v1/rooms/uploads/saved-upload/complete", "/v1/rooms/jobs",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).idempotencyKey).toBe("saved-job-key");
    expect(progress).toHaveBeenLastCalledWith(100);
    expect(values.has(storageKey)).toBe(false);
  });

  it("keeps a sealed draft and its exact job request when completion is temporarily unavailable", async () => {
    const file = capture(); saveDraft(file);
    const saved = JSON.parse(values.get(storageKey)!);
    saved.jobRequest = { name: "Original room", profile: "quality" };
    values.set(storageKey, JSON.stringify(saved));
    fetchMock
      .mockResolvedValueOnce(json({ id: "saved-upload", sealed: true, files: [] }))
      .mockResolvedValueOnce(json({ message: "Storage reconnecting" }, 503))
      .mockResolvedValueOnce(json({ id: "saved-upload", sealed: true, files: [] }))
      .mockResolvedValueOnce(json({ sealed: true }))
      .mockResolvedValueOnce(json(queued));

    await expect(run(file)).rejects.toThrow("Storage reconnecting");
    expect(JSON.parse(values.get(storageKey)!)).toEqual(saved);
    await expect(run(file)).resolves.toEqual(queued);
    expect(JSON.parse(fetchMock.mock.calls[4][1].body)).toEqual({
      uploadId: "saved-upload", name: "Original room", profile: "quality", idempotencyKey: "saved-job-key",
    });
    expect(sent).toHaveLength(0);
  });

  it("keeps uploaded parts and does not create another session after a temporary server failure", async () => {
    const file = capture(), draft = saveDraft(file);
    fetchMock.mockResolvedValueOnce(json({ message: "Storage reconnecting" }, 503));

    await expect(run(file)).rejects.toThrow("Storage reconnecting");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/v1/rooms/uploads/saved-upload");
    expect(values.get(storageKey)).toBe(draft);
    expect(sent).toHaveLength(0);
  });

  it("keeps the resume session after a network outage", async () => {
    const file = capture(), draft = saveDraft(file);
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(run(file)).rejects.toThrow("Cannot connect to the room service");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(values.get(storageKey)).toBe(draft);
  });

  it("creates a fresh upload when the saved session no longer exists", async () => {
    const file = capture(); saveDraft(file);
    fetchMock
      .mockResolvedValueOnce(json({ message: "Room resource not found" }, 404))
      .mockResolvedValueOnce(json({ id: "new-upload", files: [{ key: "new-key", url: "http://storage/upload" }] }))
      .mockResolvedValueOnce(json({ sealed: true }))
      .mockResolvedValueOnce(json(queued));

    await expect(run(file)).resolves.toEqual(queued);
    expect(sent).toEqual([file]);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      "/v1/rooms/uploads/saved-upload", "/v1/rooms/uploads", "/v1/rooms/uploads/new-upload/complete", "/v1/rooms/jobs",
    ]);
    expect(values.has(storageKey)).toBe(false);
  });

  it("returns the queued job even when browser storage cannot be cleared", async () => {
    const file = capture(); saveDraft(file);
    vi.mocked(localStorage.removeItem).mockImplementation(() => { throw new DOMException("Storage unavailable", "SecurityError"); });
    fetchMock
      .mockResolvedValueOnce(json({ id: "saved-upload", files: [{ key: "input-key", url: "http://storage/upload" }] }))
      .mockResolvedValueOnce(json({ sealed: true }))
      .mockResolvedValueOnce(json(queued));

    await expect(run(file)).resolves.toEqual(queued);
    expect(sent).toHaveLength(0);
  });

  it("retries queueing with the same key without reuploading completed parts", async () => {
    const file = capture(), draft = saveDraft(file);
    const plan = { id: "saved-upload", files: [{ key: "input-key", url: "http://storage/upload" }] };
    fetchMock
      .mockResolvedValueOnce(json(plan))
      .mockResolvedValueOnce(json({ sealed: true }))
      .mockRejectedValueOnce(new TypeError("Response lost"))
      .mockResolvedValueOnce(json(plan))
      .mockResolvedValueOnce(json({ sealed: true }))
      .mockResolvedValueOnce(json(queued));

    await expect(run(file)).rejects.toThrow("Cannot connect");
    expect(JSON.parse(values.get(storageKey)!)).toEqual({ ...JSON.parse(draft!), jobRequest: { name: "My room", profile: "local" } });
    await expect(run(file)).resolves.toEqual(queued);
    const attempts = fetchMock.mock.calls.filter(call => call[0] === "/v1/rooms/jobs");
    expect(attempts.map(call => JSON.parse(call[1].body).idempotencyKey)).toEqual(["saved-job-key", "saved-job-key"]);
    expect(sent).toHaveLength(0);
  });

  it("preserves queue request inputs when the response is lost and the form is edited", async () => {
    const file = capture(); saveDraft(file);
    const plan = { id: "saved-upload", files: [{ key: "input-key", url: "http://storage/upload" }] };
    fetchMock
      .mockResolvedValueOnce(json(plan))
      .mockResolvedValueOnce(json({ sealed: true }))
      .mockRejectedValueOnce(new TypeError("Response lost"))
      .mockResolvedValueOnce(json(plan))
      .mockResolvedValueOnce(json({ sealed: true }))
      .mockResolvedValueOnce(json(queued));

    await expect(run(file)).rejects.toThrow("Cannot connect");
    await expect(upload([file], "Renamed room", "quality", new AbortController().signal, vi.fn())).resolves.toEqual(queued);
    const attempts = fetchMock.mock.calls.filter(call => call[0] === "/v1/rooms/jobs");
    expect(attempts.map(call => JSON.parse(call[1].body))).toEqual([
      { uploadId: "saved-upload", name: "My room", profile: "local", idempotencyKey: "saved-job-key" },
      { uploadId: "saved-upload", name: "My room", profile: "local", idempotencyKey: "saved-job-key" },
    ]);
    expect(sent).toHaveLength(0);
  });

  it("uploads only missing multipart chunks and keeps their completion receipts", async () => {
    const file = capture(); saveDraft(file, [{ number: 1, etag: "saved-etag" }]);
    const progress = vi.fn();
    fetchMock
      .mockResolvedValueOnce(json({ id: "saved-upload", files: [{ key: "input-key", partSize: 4, parts: [{ number: 1, url: "http://storage/part1" }, { number: 2, url: "http://storage/part2" }] }] }))
      .mockResolvedValueOnce(json({ sealed: true }))
      .mockResolvedValueOnce(json(queued));

    await expect(upload([file], "My room", "local", new AbortController().signal, progress)).resolves.toEqual(queued);
    expect(sent).toHaveLength(1);
    expect(await sent[0].text()).toBe("ure");
    const complete = fetchMock.mock.calls.find(call => String(call[0]).endsWith("/complete"))!;
    expect(JSON.parse(complete[1].body)).toEqual({ files: [{ key: "input-key", parts: [{ number: 1, etag: "saved-etag" }, { number: 2, etag: "part-etag" }] }] });
    expect(progress).toHaveBeenLastCalledWith(100);
  });
  it("cannot resume another account's draft for the same files", async () => {
    const file = capture(); saveDraft(file);
    setCurrentAccount({ id: "other-account", username: "other", role: "RECONSTRUCTOR", disabled: false });
    fetchMock.mockResolvedValueOnce(json({ id: "fresh", files: [{ key: "new-key", url: "http://storage/upload" }] }))
      .mockResolvedValueOnce(json({ sealed: true })).mockResolvedValueOnce(json(queued));
    await expect(run(file)).resolves.toEqual(queued);
    expect(fetchMock.mock.calls[0][0]).toBe("/v1/rooms/uploads");
    expect(values.has(storageKey)).toBe(true);
    expect(sent).toEqual([file]);
  });
  it("imports PLY using a distinct kind and ignores a capture draft", async () => {
    const file = new File(["ply"], "scene.ply", { lastModified: 123 }); saveDraft(file);
    fetchMock.mockResolvedValueOnce(json({ id: "fresh", kind: "splat", files: [{ key: "new-key", url: "http://storage/upload" }] }))
      .mockResolvedValueOnce(json({ sealed: true })).mockResolvedValueOnce(json({ ...queued, kind: "splat" }));
    await upload([file], "My scene", "local", new AbortController().signal, vi.fn(), vi.fn(), "splat");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).kind).toBe("splat");
    expect(values.has(storageKey)).toBe(true);
  });
});
