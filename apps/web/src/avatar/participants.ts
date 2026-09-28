import { AvatarController, type PoseFrame } from "./controller";
export interface ParticipantPose {
  participant_id: string;
  avatar_id: string;
  avatar_version: number;
  pose: PoseFrame;
}
/** Bind only after the platform has authenticated and assigned a participant.
 * Camera track IDs are deliberately not accepted as participant identities.
 */
export class ParticipantAvatars {
  private bindings = new Map<
    string,
    { avatarId: string; version: number; controller: AvatarController }
  >();
  bind(
    participantId: string,
    avatarId: string,
    version: number,
    source: "keyboard" | "camera",
    controller: AvatarController,
  ) {
    if (
      !participantId ||
      !avatarId ||
      !Number.isSafeInteger(version) ||
      version < 1
    )
      throw Error("Invalid participant binding");
    controller.setSource(source);
    this.bindings.set(participantId, { avatarId, version, controller });
  }
  unbind(participantId: string) {
    const binding = this.bindings.get(participantId);
    binding?.controller.setSource("camera");
    this.bindings.delete(participantId);
  }
  receive(envelope: ParticipantPose, now: number) {
    const binding = this.bindings.get(envelope.participant_id);
    if (
      !binding ||
      binding.avatarId !== envelope.avatar_id ||
      binding.version !== envelope.avatar_version
    )
      return false;
    return binding.controller.receive(envelope.pose, now);
  }
}
