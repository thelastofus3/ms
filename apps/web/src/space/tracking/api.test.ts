import { afterEach, describe, expect, it, vi } from "vitest";
import { frame } from "./api";

describe("tracking frame upload", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("sends only the person fields the room API accepts", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ accepted: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await frame("job", "camera", { sceneVersion: 2, calibrationRevision: "revision", streamId: "stream", sequence: 1, capturedAt: 1,
      people: [{ id: "1", position: { x: 1, y: 0, z: 2 }, confidence: 0.9, positionMethod: "floor", uncertaintyMeters: 0.25, poseIndex: 0 }] });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.people).toEqual([{ id: "1", position: { x: 1, y: 0, z: 2 }, confidence: 0.9, positionMethod: "floor", uncertaintyMeters: 0.25 }]);
    expect(body).toMatchObject({ sceneVersion: 2, calibrationRevision: "revision", streamId: "stream", sequence: 1, capturedAt: 1 });
  });
});
