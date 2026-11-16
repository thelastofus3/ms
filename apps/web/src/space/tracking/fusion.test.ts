import { describe, expect, it } from "vitest";
import { PeopleFusion, SharedPeople, type CameraObservation } from "./fusion";
import type { TrackedPerson } from "./types";

const person = (id: string, x: number, z: number, uncertaintyMeters?: number): TrackedPerson => ({ id, position: { x, y: 0, z }, confidence: 0.6, positionMethod: uncertaintyMeters ? "estimated" : "floor", uncertaintyMeters });
const camera = (cameraId: string, center: { x: number; z: number }, people: TrackedPerson[]): CameraObservation => ({ cameraId, name: cameraId, people, expiresAt: 2500, center });
const south = { x: 0, z: -4 }, west = { x: -4, z: 0 };

describe("PeopleFusion", () => {
  it("places a person seen by two cameras where their views cross", () => {
    // Each head-only estimate is good across its view and poor in depth: 0.8 m too far from the south, 0.7 m too near from the west.
    const [fused, ...rest] = new PeopleFusion().update([camera("south", south, [person("1", 0.05, 0.8, 0.9)]), camera("west", west, [person("1", -0.7, 0.04, 0.9)])], 1000);
    expect(rest).toHaveLength(0);
    expect(fused.cameras).toBe(2);
    expect(Math.hypot(fused.position.x, fused.position.z)).toBeLessThan(0.2);
    expect(fused.uncertaintyMeters!).toBeLessThan(0.4);
  });

  it("keeps two people apart, and never merges two people from the same camera", () => {
    const fusion = new PeopleFusion();
    expect(fusion.update([camera("south", south, [person("1", -1.5, 0)]), camera("west", west, [person("1", 1.5, 1)])], 1000)).toHaveLength(2);
    expect(fusion.update([camera("south", south, [person("1", 0, 0, 0.8), person("2", 0.2, 0.3, 0.8)])], 1100)).toHaveLength(2);
  });

  it("trusts visible feet over a body estimate of the same person", () => {
    const [fused] = new PeopleFusion().update([camera("south", south, [person("1", 0, 0)]), camera("west", west, [person("7", 0.6, 0.1, 0.8)])], 1000);
    expect(fused.positionMethod).toBe("floor");
    expect(Math.hypot(fused.position.x, fused.position.z)).toBeLessThan(0.15);
  });

  it("keeps a person's number when a second camera joins and when the first one drops out", () => {
    const fusion = new PeopleFusion();
    const alone = fusion.update([camera("south", south, [person("1", 0, 0)])], 1000)[0].id;
    expect(fusion.update([camera("south", south, [person("1", 0.02, 0)]), camera("west", west, [person("4", 0.1, 0.05, 0.6)])], 1125)[0].id).toBe(alone);
    expect(fusion.update([camera("west", west, [person("4", 0.1, 0.05, 0.6)])], 1250)[0].id).toBe(alone);
  });

  it("finds three people in what two cameras reported as five (recorded in a real room, 2026-11-15)", () => {
    // One person walks (feet seen by the first camera), one lies on a bed, one sits at a desk only the second camera sees.
    // Each camera placed the lying person at about half their real distance, 1.9 m apart from the other's guess.
    const first = { x: -2.562, z: -0.053 }, second = { x: 1.215, z: 0.258 }, fusion = new PeopleFusion();
    const seenByFirst = [person("18", -0.21, -0.33), person("22", -1.59, -0.45, 0.25)];
    const people = fusion.update([camera("first", first, seenByFirst), camera("second", second, [person("13", -0.56, -0.37, 0.66), person("14", -0.21, 0.4, 0.27), person("16", 0.38, -0.22, 0.25)])], 1000);
    expect(people).toHaveLength(3);
    const near = (x: number, z: number) => people.find(found => Math.hypot(found.position.x - x, found.position.z - z) < 0.25);
    // The walker stays on their feet, the lying person is where the two lines of sight cross, the seated one is untouched.
    expect(near(-0.21, -0.33)).toMatchObject({ positionMethod: "floor", cameras: 2 });
    expect(near(-0.67, -0.82)).toMatchObject({ cameras: 2 });
    expect(near(-0.21, 0.4)).toMatchObject({ cameras: 1 });
    // The second camera loses the lying person for a moment: they stay put instead of jumping back to the first camera's guess.
    const after = fusion.update([camera("first", first, seenByFirst), camera("second", second, [person("13", -0.56, -0.37, 0.66), person("14", -0.21, 0.4, 0.27)])], 1300);
    expect(after).toHaveLength(3);
    expect(after.find(found => found.id === near(-0.67, -0.82)!.id)!.position.x).toBeGreaterThan(-0.9);
  });

  it("drops a camera whose observation has expired", () => {
    expect(new PeopleFusion().update([{ ...camera("south", south, [person("1", 0, 0)]), expiresAt: 900 }], 1000)).toHaveLength(0);
  });
});

describe("SharedPeople", () => {
  it("combines the cameras of one browser and notifies room views", () => {
    const shared = new SharedPeople();
    let notified = 0;
    const unsubscribe = shared.subscribe(() => notified++);
    shared.report("slot-1", camera("south", south, [person("1", 0, 0.5, 0.9)]));
    shared.report("slot-2", camera("west", west, [person("1", -0.5, 0, 0.9)]));
    expect(shared.people(1000)).toHaveLength(1);
    shared.report("slot-2", null);
    expect(shared.people(1000)[0].cameras).toBe(1);
    expect(notified).toBe(3);
    unsubscribe();
  });
});

describe("recognised people", () => {
  it("names a person for every camera once one camera saw their face, and keeps the name while they are followed", () => {
    const fusion = new PeopleFusion(), seen = { ...person("1", 0, 0), avatarId: "anna" };
    const [fused] = fusion.update([camera("south", south, [seen]), camera("west", west, [person("3", 0.1, 0, 0.6)])], 1000);
    expect(fused.avatarId).toBe("anna");
    expect(fused.label).toContain("Recognized");
    // The camera that saw the face loses the person; the other one still shows them as Anna.
    expect(fusion.update([camera("west", west, [person("3", 0.15, 0, 0.6)])], 1125)[0].avatarId).toBe("anna");
  });
  it("leaves other people anonymous", () => {
    const people = new PeopleFusion().update([camera("south", south, [{ ...person("1", -1.5, 0), avatarId: "anna" }, person("2", 1.5, 1)])], 1000);
    expect(people.map(value => value.avatarId).sort()).toEqual(["anna", undefined]);
  });
});
