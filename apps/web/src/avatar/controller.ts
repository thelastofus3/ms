import { AnimationMixer, Bone, Object3D, Quaternion, Vector3 } from "three";
export type Quat = [number, number, number, number];
export type PoseFrame = {
  sequence: number;
  timestamp_ms: number;
  position: [number, number, number];
  rotation: Quat;
  joints: Record<string, Quat>;
  confidence: number;
  tracking_state: "TRACKED" | "UNCERTAIN" | "LOST";
};
export type Binding = { bone: Bone; rest: Quaternion; basis: Quaternion };

export class RigAdapter {
  constructor(readonly bindings: Record<string, Binding>) {}
  reset() {
    for (const b of Object.values(this.bindings))
      b.bone.quaternion.copy(b.rest);
  }
  apply(joints: Record<string, Quat>, alpha: number) {
    for (const [name, value] of Object.entries(joints)) {
      const b = this.bindings[name];
      if (!b) continue;
      const delta = new Quaternion().fromArray(value).normalize();
      // Limit a semantic delta to 150 degrees; tracker-specific anatomical constraints belong upstream.
      const angle = 2 * Math.acos(Math.min(1, Math.abs(delta.w)));
      if (angle > (Math.PI * 5) / 6)
        delta.slerp(new Quaternion(), 1 - (Math.PI * 5) / 6 / angle);
      const target = b.rest
        .clone()
        .multiply(b.basis)
        .multiply(delta)
        .multiply(b.basis.clone().invert());
      b.bone.quaternion.slerp(target, alpha);
    }
  }
}

export class AvatarController {
  source: "keyboard" | "camera" = "keyboard";
  state: PoseFrame["tracking_state"] = "LOST";
  clip: "idle" | "walk" | null = "idle";
  private sequence = -1;
  private receivedAt = -Infinity;
  private pose: PoseFrame | null = null;
  private first = true;
  constructor(
    readonly root: Object3D,
    readonly rig: RigAdapter,
    readonly mixer?: AnimationMixer,
  ) {}
  setSource(source: "keyboard" | "camera") {
    if (source === "keyboard" && this.source === "keyboard") return;
    this.source = source;
    this.sequence = -1;
    this.pose = null;
    this.first = true;
    this.state = "LOST";
    this.clip = source === "camera" ? null : "idle";
    this.mixer?.stopAllAction();
    this.rig.reset();
  }
  receive(frame: PoseFrame, now: number) {
    if (
      this.source !== "camera" ||
      frame.sequence <= this.sequence ||
      !Number.isSafeInteger(frame.sequence) ||
      frame.sequence < 0
    )
      return false;
    const rotations = [frame.rotation, ...Object.values(frame.joints)];
    if (
      !Number.isFinite(frame.timestamp_ms) ||
      frame.timestamp_ms < 0 ||
      !Number.isFinite(frame.confidence) ||
      frame.confidence < 0 ||
      frame.confidence > 1 ||
      !["TRACKED", "UNCERTAIN", "LOST"].includes(frame.tracking_state) ||
      frame.position.length !== 3 ||
      !frame.position.every(Number.isFinite) ||
      rotations.some(
        (q) =>
          q.length !== 4 ||
          !q.every(Number.isFinite) ||
          Math.abs(q.reduce((s, x) => s + x * x, 0) - 1) > 0.02,
      )
    )
      return false;
    this.sequence = frame.sequence;
    this.receivedAt = now;
    this.pose = structuredClone(frame);
    return true;
  }
  update(dt: number, now: number, input = { forward: 0, turn: 0 }) {
    if (this.source === "keyboard") {
      this.root.rotateY(input.turn * dt * 2);
      this.root.translateZ(input.forward * dt * 1.5);
      this.clip = input.forward ? "walk" : "idle";
      return;
    }
    this.clip = null;
    if (!this.pose || now - this.receivedAt > 500) {
      this.state = "LOST";
      return;
    }
    this.state = this.pose.tracking_state;
    if (this.state === "LOST") return;
    if (this.pose.confidence < 0.35) {
      this.state = "UNCERTAIN";
      return;
    }
    const alpha = this.first
      ? 1
      : 1 - Math.exp(-Math.max(0, dt) * 18 * this.pose.confidence);
    this.root.position.lerp(new Vector3().fromArray(this.pose.position), alpha);
    this.root.quaternion.slerp(
      new Quaternion().fromArray(this.pose.rotation),
      alpha,
    );
    this.rig.apply(this.pose.joints, alpha);
    this.first = false;
  }
}
