import { it, expect } from "vitest";
import { Bone, Group, Quaternion } from "three";
import { AvatarController, RigAdapter, type PoseFrame } from "./controller";
import { ParticipantAvatars } from "./participants";
it("routes trusted participant bindings independently and rejects mismatched avatar versions", () => {
  const registry = new ParticipantAvatars();
  const make = () =>
    new AvatarController(
      new Group(),
      new RigAdapter({
        head: {
          bone: new Bone(),
          rest: new Quaternion(),
          basis: new Quaternion(),
        },
      }),
    );
  const a = make(),
    b = make();
  registry.bind("person-a", "avatar-a", 1, "camera", a);
  registry.bind("person-b", "avatar-b", 2, "camera", b);
  const pose: PoseFrame = {
    sequence: 1,
    timestamp_ms: 100,
    position: [2, 0, 3],
    rotation: [0, 0, 0, 1],
    joints: {},
    confidence: 1,
    tracking_state: "TRACKED",
  };
  expect(
    registry.receive(
      {
        participant_id: "person-a",
        avatar_id: "avatar-b",
        avatar_version: 2,
        pose,
      },
      100,
    ),
  ).toBe(false);
  expect(
    registry.receive(
      {
        participant_id: "person-a",
        avatar_id: "avatar-a",
        avatar_version: 1,
        pose,
      },
      100,
    ),
  ).toBe(true);
  a.update(0.1, 110);
  b.update(0.1, 110);
  expect(a.root.position.x).toBe(2);
  expect(b.root.position.x).toBe(0);
  registry.unbind("person-a");
  expect(
    registry.receive(
      {
        participant_id: "person-a",
        avatar_id: "avatar-a",
        avatar_version: 1,
        pose,
      },
      120,
    ),
  ).toBe(false);
});
