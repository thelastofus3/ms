import { describe, it, expect } from "vitest";
import {
  Bone,
  Group,
  Quaternion,
  AnimationMixer,
  AnimationClip,
  NumberKeyframeTrack,
} from "three";
import { AvatarController, RigAdapter } from "./controller";

function setup() {
  const root = new Group(),
    head = new Bone();
  root.add(head);
  const rig = new RigAdapter({
    head: { bone: head, rest: new Quaternion(), basis: new Quaternion() },
  });
  return { root, head, controller: new AvatarController(root, rig) };
}
describe("AvatarController", () => {
  it("keeps an existing idle action running when keyboard mode is selected again", () => {
    const root = new Group(),
      mixer = new AnimationMixer(root);
    const action = mixer
      .clipAction(
        new AnimationClip("idle", 1, [
          new NumberKeyframeTrack(".position[x]", [0, 1], [0, 0.01]),
        ]),
      )
      .play();
    const controller = new AvatarController(root, new RigAdapter({}), mixer);
    controller.setSource("keyboard");
    expect(action.isRunning()).toBe(true);
  });
  it("preserves explicit LOST state and rejects invalid rotations", () => {
    const { controller } = setup();
    controller.setSource("camera");
    const frame = {
      sequence: 1,
      timestamp_ms: 1,
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0, 1] as [number, number, number, number],
      joints: {},
      confidence: 1,
      tracking_state: "LOST" as const,
    };
    expect(controller.receive({ ...frame, rotation: [0, 0, 0, 0] }, 1)).toBe(
      false,
    );
    expect(controller.receive(frame, 1)).toBe(true);
    controller.update(0.1, 2);
    expect(controller.state).toBe("LOST");
  });
  it("keeps camera pose exclusive, rejects old frames, and marks stale tracking lost", () => {
    const { root, head, controller } = setup();
    controller.setSource("camera");
    expect(
      controller.receive(
        {
          sequence: 2,
          timestamp_ms: 100,
          position: [2, 0, 3],
          rotation: [0, 0, 0, 1],
          joints: { head: [0, 0.70710678, 0, 0.70710678] },
          confidence: 1,
          tracking_state: "TRACKED",
        },
        1000,
      ),
    ).toBe(true);
    controller.update(0.1, 1100, { forward: 1, turn: 1 });
    expect(root.position.x).toBe(2);
    expect(root.position.z).toBe(3);
    expect(head.quaternion.y).toBeCloseTo(Math.SQRT1_2);
    expect(
      controller.receive(
        {
          sequence: 1,
          timestamp_ms: 90,
          position: [9, 0, 9],
          rotation: [0, 0, 0, 1],
          joints: {},
          confidence: 1,
          tracking_state: "TRACKED",
        },
        1150,
      ),
    ).toBe(false);
    controller.update(0.1, 1601);
    expect(controller.state).toBe("LOST");
    expect(root.position.x).toBe(2);
  });
  it("moves remote avatars independently and refuses camera frames", () => {
    const a = setup(),
      b = setup();
    a.controller.update(0.5, 1, { forward: 1, turn: 0 });
    expect(a.root.position.z).toBeCloseTo(0.75);
    expect(b.root.position.z).toBe(0);
    expect(a.controller.clip).toBe("walk");
    expect(
      a.controller.receive(
        {
          sequence: 1,
          timestamp_ms: 1,
          position: [9, 0, 9],
          rotation: [0, 0, 0, 1],
          joints: {},
          confidence: 1,
          tracking_state: "TRACKED",
        },
        2,
      ),
    ).toBe(false);
    a.controller.update(0.1, 3);
    expect(a.controller.clip).toBe("idle");
  });
  it("applies semantic delta in the binding basis after rest rotation", () => {
    const head = new Bone();
    const rest = new Quaternion().setFromAxisAngle(
      { x: 1, y: 0, z: 0 },
      Math.PI / 2,
    );
    const rig = new RigAdapter({
      head: { bone: head, rest, basis: new Quaternion() },
    });
    rig.apply({ head: [0, Math.SQRT1_2, 0, Math.SQRT1_2] }, 1);
    expect(head.quaternion.x).toBeCloseTo(0.5);
    expect(head.quaternion.y).toBeCloseTo(0.5);
    expect(head.quaternion.z).toBeCloseTo(0.5);
    expect(head.quaternion.w).toBeCloseTo(0.5);
  });
});
