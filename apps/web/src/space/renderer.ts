import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import RAPIER from "@dimforge/rapier3d-compat";
import type { Calibration, CalibrationTool, Point, RoomManifest } from "./types";
import { calibrationFromManifest, floorFrame, metersPerUnit, point, previewTransform, vector } from "./calibration";
import type { CameraCalibration, WorldPerson } from "./tracking/types";

let physics: Promise<void> | undefined;
const initializePhysics = () => physics ??= RAPIER.init();
export class RoomRenderer {
  readonly canvas: HTMLCanvasElement;
  onPick?: (point: Point) => void;
  onStatus?: (message: string) => void;
  private renderer = new THREE.WebGLRenderer({ antialias: false });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(65, 1, 0.03, 1000);
  private root = new THREE.Group();
  private annotations = new THREE.Group();
  private people = new THREE.Group();
  private floorReferences = new THREE.Group();
  private trackingCameras = new THREE.Group();
  private peopleMarkers = new Map<string, { group: THREE.Group; target: THREE.Vector3; expiresAt: number; label: string; estimated: boolean; labelSprite: THREE.Sprite; uncertaintyRing: THREE.Mesh }>();
  private spark: SparkRenderer;
  private controls: OrbitControls;
  private collision?: THREE.Group;
  private mesh?: SplatMesh;
  private manifest?: RoomManifest;
  private calibration?: Calibration;
  private tool: CalibrationTool = "review";
  private world?: RAPIER.World;
  private player?: RAPIER.RigidBody;
  private capsule?: RAPIER.Collider;
  private controller?: RAPIER.KinematicCharacterController;
  private abort = new AbortController();
  private observer: ResizeObserver;
  private disposed = false;
  private requestedPause = false;
  private paused = false;
  private sparkAutoUpdate = true;
  private sparkDriveLod = true;
  private generation = 0;
  private frame?: number;
  private last = 0;
  private accumulator = 0;
  private vertical = 0;
  private yaw = 0;
  private pitch = 0;
  private walking = false;
  private keys = new Set<string>();
  private down?: { x: number; y: number };
  private frameTime = 16;
  private adaptiveTime = 0;
  private levelled = false;
  private orbitPosition = new THREE.Vector3();
  private orbitRotation = new THREE.Quaternion();
  private orbitStart = () => { this.orbitPosition.copy(this.camera.position); this.orbitRotation.copy(this.camera.quaternion); };
  private orbitEnd = () => {
    if (this.orbitPosition.distanceToSquared(this.camera.position) > 1e-12 || 1 - Math.abs(this.orbitRotation.dot(this.camera.quaternion)) > 1e-12) this.levelled = false;
  };
  constructor(private host: HTMLElement) {
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute("aria-label", "Interactive room");
    this.canvas.tabIndex = 0;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    host.append(this.canvas);
    this.scene.background = new THREE.Color("#101820");
    this.spark = new SparkRenderer({ renderer: this.renderer, accumExtSplats: true, covSplats: true,
      lodSplatCount: matchMedia("(pointer: coarse)").matches ? 500000 : 1500000 });
    this.scene.add(this.spark, this.root, this.people, this.floorReferences, this.trackingCameras);
    this.root.add(this.annotations);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.addEventListener("start", this.orbitStart);
    this.controls.addEventListener("end", this.orbitEnd);
    this.camera.position.set(0, 2, 5);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.canvas.addEventListener("pointerdown", this.pointerDown);
    this.canvas.addEventListener("pointerup", this.pointerUp);
    this.canvas.addEventListener("click", this.lock);
    document.addEventListener("pointerlockchange", this.unlock);
    document.addEventListener("pointerlockerror", this.lockError);
    document.addEventListener("mousemove", this.mouse);
    window.addEventListener("keydown", this.keyDown);
    window.addEventListener("keyup", this.keyUp);
    window.addEventListener("blur", this.blur);
    document.addEventListener("visibilitychange", this.visibility);
    this.updatePause();
    if (!this.paused) this.frame = requestAnimationFrame(this.tick);
  }
  private resize() {
    if (this.disposed || this.paused) return;
    const width = Math.max(1, this.host.clientWidth), height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height); this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
  }
  setPaused(paused: boolean) {
    if (this.disposed) return;
    this.requestedPause = paused; this.updatePause();
  }
  private stopRendering() {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.spark.autoUpdate = false; this.spark.enableDriveLod = false; this.spark.sortDirty = false;
    clearTimeout(this.spark.updateTimeoutId); this.spark.updateTimeoutId = -1;
    clearTimeout(this.spark.sortTimeoutId); this.spark.sortTimeoutId = -1;
  }
  private updatePause() {
    const paused = this.requestedPause || document.hidden;
    if (this.disposed || paused === this.paused) return;
    this.paused = paused; this.last = 0; this.accumulator = 0; this.vertical = 0; this.down = undefined; this.keys.clear();
    if (paused) {
      this.sparkAutoUpdate = this.spark.autoUpdate; this.sparkDriveLod = this.spark.enableDriveLod;
      this.stopRendering(); this.controls.enabled = false;
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    } else {
      this.spark.autoUpdate = this.sparkAutoUpdate; this.spark.enableDriveLod = this.sparkDriveLod; this.spark.sortDirty = true;
      this.controls.enabled = !this.walking; this.frameTime = 16; this.adaptiveTime = performance.now(); this.resize();
      if (this.frame === undefined) this.frame = requestAnimationFrame(this.tick);
    }
  }
  private pointerDown = (e: PointerEvent) => { this.down = e.button === 0 ? { x: e.clientX, y: e.clientY } : undefined; };
  private pointerUp = (e: PointerEvent) => {
    const down = this.down; this.down = undefined;
    if (e.button !== 0 || this.tool === "review" || this.walking || !this.onPick || !this.collision || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    const rect = this.canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), this.camera);
    this.scene.updateMatrixWorld(true);
    const floor = this.manifest && this.calibration ? floorFrame(this.calibration, this.manifest) : undefined;
    if (floor && ["boundary", "spawn"].includes(this.tool)) {
      const position = floor.origin.clone().applyMatrix4(this.root.matrix);
      const normal = floor.up.clone().transformDirection(this.root.matrix);
      const hit = ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, position), new THREE.Vector3());
      if (hit) this.onPick(point(this.root.worldToLocal(hit)));
      else this.onStatus?.("Use Top view to place a marker on the floor.");
      return;
    }
    const hit = ray.intersectObject(this.collision, true)[0];
    if (hit) { const p = this.root.worldToLocal(hit.point.clone()); this.onPick({ x: p.x, y: p.y, z: p.z }); }
    else this.onStatus?.("No reconstructed surface here. Try showing collision surfaces or choose another view.");
  };
  private lock = () => { if (this.walking) void this.canvas.requestPointerLock(); };
  private unlock = () => { this.keys.clear(); if (document.pointerLockElement !== this.canvas && this.walking) this.onStatus?.("Click the room to continue walking. Escape releases the mouse."); };
  private lockError = () => this.onStatus?.("Mouse capture was blocked. Click inside the room to try again.");
  private mouse = (e: MouseEvent) => {
    if (this.walking && document.pointerLockElement === this.canvas) {
      this.yaw -= e.movementX * 0.002;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.002, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
    }
  };
  private keyDown = (e: KeyboardEvent) => { if (this.walking && document.pointerLockElement === this.canvas && ["KeyW", "KeyA", "KeyS", "KeyD"].includes(e.code)) { this.keys.add(e.code); e.preventDefault(); } };
  private keyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private blur = () => { this.keys.clear(); this.accumulator = 0; };
  private visibility = () => { if (document.hidden) this.blur(); this.updatePause(); };
  private tick = (now: number) => {
    this.frame = undefined;
    if (this.disposed || this.paused) return;
    const elapsed = Math.min((now - (this.last || now)) / 1000, 0.1); this.last = now;
    if (this.walking && this.world && this.player && this.controller && this.capsule && this.manifest?.navigation) {
      const n = this.manifest.navigation;
      this.accumulator += elapsed;
      while (this.accumulator >= 1 / 60) {
        const input = new THREE.Vector3(Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA")), 0, Number(this.keys.has("KeyS")) - Number(this.keys.has("KeyW")));
        if (document.pointerLockElement !== this.canvas) input.set(0, 0, 0);
        if (input.lengthSq()) input.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw).multiplyScalar(n.speed / 60);
        this.vertical = Math.max(-10, this.vertical - 9.81 / 60); input.y = this.vertical / 60;
        this.controller.computeColliderMovement(this.capsule, input);
        const movement = this.controller.computedMovement(), position = this.player.translation();
        this.player.setNextKinematicTranslation({ x: position.x + movement.x, y: position.y + movement.y, z: position.z + movement.z });
        this.world.step();
        if (this.controller.computedGrounded()) this.vertical = 0;
        this.accumulator -= 1 / 60;
      }
      const p = this.player.translation();
      this.camera.position.set(p.x, p.y - n.capsuleHeight / 2 + n.eyeHeight, p.z);
      this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
    } else this.controls.update();
    const wallTime = Date.now();
    for (const [id, marker] of this.peopleMarkers) {
      if (wallTime >= marker.expiresAt) { this.disposeMeshes(marker.group); this.people.remove(marker.group); this.peopleMarkers.delete(id); }
      else marker.group.position.lerp(marker.target, 1 - Math.exp(-elapsed * 12));
    }
    this.renderer.render(this.scene, this.camera);
    this.frameTime = this.frameTime * 0.97 + elapsed * 1000 * 0.03;
    if (now - this.adaptiveTime > 4000 && this.mesh) {
      const ratio = this.renderer.getPixelRatio();
      if (this.frameTime > 28 && ratio > 0.6) { this.renderer.setPixelRatio(Math.max(0.6, ratio * 0.85)); this.spark.lodSplatScale = Math.max(0.3, this.spark.lodSplatScale * 0.85); this.resize(); }
      this.adaptiveTime = now;
    }
    if (!this.disposed && !this.paused && this.frame === undefined) this.frame = requestAnimationFrame(this.tick);
  };
  async load(manifest: RoomManifest) {
    const generation = ++this.generation;
    this.abort.abort(); this.abort = new AbortController();
    this.inspect(); this.clear();
    this.manifest = manifest;
    this.calibration = calibrationFromManifest(manifest);
    this.root.matrix.copy(previewTransform(this.calibration, manifest)); this.root.matrixAutoUpdate = false;
    const signal = this.abort.signal;
    const bytes = async (asset: RoomManifest["assets"]["splats"]) => {
      const response = await fetch(asset.url, { signal }); if (!response.ok) throw Error("Room asset could not be downloaded. Reopen the room to refresh its links.");
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== asset.bytes) throw Error("Room asset size does not match its package");
      const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))].map(v => v.toString(16).padStart(2, "0")).join("");
      if (sha !== asset.sha256) throw Error("Room asset checksum does not match");
      return buffer;
    };
    const [splatBytes, collisionBytes] = await Promise.all([bytes(manifest.assets.splats), bytes(manifest.assets.collision)]);
    if (this.disposed || generation !== this.generation) return;
    const mesh = new SplatMesh({ fileBytes: splatBytes, fileName: manifest.assets.splats.path, lod: true, extSplats: true, covSplats: true });
    const gltf = await new GLTFLoader().parseAsync(collisionBytes, "");
    try { await mesh.initialized; } catch (error) { mesh.dispose(); throw error; }
    if (this.disposed || generation !== this.generation) { mesh.dispose(); this.disposeMeshes(gltf.scene); return; }
    this.mesh = mesh; this.collision = gltf.scene;
    this.collision.traverse(object => { if (object instanceof THREE.Mesh) { const old = object.material; (Array.isArray(old) ? old : [old]).forEach(m => m.dispose()); object.material = new THREE.MeshBasicMaterial({ color: 0x6edbd2, wireframe: true, transparent: true, opacity: 0.35, side: THREE.DoubleSide }); } });
    this.collision.visible = false;
    this.root.add(mesh, this.collision);
    this.scene.updateMatrixWorld(true);
    this.resetView();
    this.onStatus?.(manifest.ready ? "Room ready. Inspect surfaces or start walking." : "Reconstruction loaded. Calibrate scale and review the floor before walking.");
  }
  showCollision(show: boolean) { if (this.collision) this.collision.visible = show; }
  setTool(tool: CalibrationTool) { this.tool = tool; this.canvas.style.cursor = tool === "review" ? "grab" : "crosshair"; }
  preview(calibration: Calibration) {
    if (!this.manifest || this.walking) return;
    this.calibration = calibration;
    const next = previewTransform(calibration, this.manifest);
    if (!next.equals(this.root.matrix)) {
      // Move the camera and orbit target through the same frame change, preserving
      // the physical viewpoint while the floor becomes horizontal and metric.
      const delta = next.clone().multiply(this.root.matrix.clone().invert());
      this.camera.position.applyMatrix4(delta); this.controls.target.applyMatrix4(delta);
      this.root.matrix.copy(next); this.scene.updateMatrixWorld(true);
      this.camera.up.set(0, 1, 0); this.controls.update();
      if (this.levelled) this.levelView();
      this.updateClipping();
    }
  }
  private sceneBox() { return this.collision ? new THREE.Box3().setFromObject(this.collision) : new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(5, 5, 5)); }
  private updateClipping() {
    const extent = this.sceneBox().getSize(new THREE.Vector3()).length();
    this.camera.near = Math.max(0.0001, extent / 10000);
    this.camera.far = Math.max(100, extent * 10); this.camera.updateProjectionMatrix();
  }
  resetView() {
    if (!this.manifest) return;
    this.inspect();
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false; this.controls.update();
    const capture = new THREE.Matrix4().fromArray(this.manifest.previewCamera);
    this.camera.position.setFromMatrixPosition(capture).applyMatrix4(this.root.matrix);
    const forward = new THREE.Vector3().setFromMatrixColumn(capture, 2).negate().transformDirection(this.root.matrix);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    this.controls.target.copy(this.camera.position).addScaledVector(forward, Math.max(0.01, this.sceneBox().getSize(new THREE.Vector3()).length() * 0.2));
    this.camera.up.set(0, 1, 0); this.controls.update(); this.updateClipping();
    this.controls.enableDamping = damping; this.levelled = true;
  }
  levelView() {
    if (!this.manifest) return;
    this.inspect();
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false; this.controls.update();
    const direction = this.camera.getWorldDirection(new THREE.Vector3()); direction.y = 0;
    if (direction.lengthSq() < 1e-6) direction.set(0, 0, -1);
    const length = Math.max(0.01, this.camera.position.distanceTo(this.controls.target));
    this.controls.target.copy(this.camera.position).addScaledVector(direction.normalize(), length);
    this.camera.up.set(0, 1, 0); this.controls.update();
    this.controls.enableDamping = damping; this.levelled = true;
  }
  topView() {
    if (!this.manifest) return;
    this.inspect();
    this.levelled = false;
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false; this.controls.update();
    const box = this.sceneBox(), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const floor = this.calibration && floorFrame(this.calibration, this.manifest);
    if (floor) center.y = floor.origin.clone().applyMatrix4(this.root.matrix).y;
    const height = Math.max(size.x, size.z, size.y, 0.1) * 1.15;
    this.controls.target.copy(center); this.camera.position.copy(center).add(new THREE.Vector3(0, height, height * 0.001));
    this.controls.update(); this.updateClipping(); this.controls.enableDamping = damping;
  }
  forwardFromView(): Point | undefined {
    if (!this.manifest || !this.calibration) return;
    const floor = floorFrame(this.calibration, this.manifest); if (!floor) return;
    const direction = this.camera.getWorldDirection(new THREE.Vector3()).transformDirection(this.root.matrix.clone().invert());
    direction.addScaledVector(floor.up, -direction.dot(floor.up));
    if (direction.length() < 0.01) return;
    return point(direction.normalize());
  }
  setPeople(observations: WorldPerson[]) {
    if (!this.manifest?.ready) return;
    const current = new Set<string>();
    for (const person of observations) {
      if (![person.position.x, person.position.y, person.position.z, person.confidence, person.expiresAt].every(Number.isFinite) || person.expiresAt <= Date.now()) continue;
      current.add(person.id);
      let marker = this.peopleMarkers.get(person.id);
      const estimated = person.positionMethod === "estimated";
      const color = new THREE.Color(estimated ? 0xffc56a : 0x85e5b3);
      if (!marker) {
        const group = new THREE.Group();
        const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 1.29, 4, 10), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.42, depthWrite: false }));
        body.position.y = 0.825; group.add(body);
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.20, 0.25, 24), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2; ring.position.y = 0.015; ring.renderOrder = 1000; group.add(ring);
        const uncertainty = new THREE.Mesh(new THREE.RingGeometry(0.985, 1.015, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
        uncertainty.rotation.x = -Math.PI / 2; uncertainty.position.y = 0.01; uncertainty.renderOrder = 999; group.add(uncertainty);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false }));
        this.updateTrackingLabel(sprite, person.label, color);
        sprite.position.y = 1.95; sprite.renderOrder = 1001; group.add(sprite);
        group.position.copy(vector(person.position)); this.people.add(group);
        marker = { group, target: vector(person.position), expiresAt: person.expiresAt, label: person.label, estimated, labelSprite: sprite, uncertaintyRing: uncertainty };
        this.peopleMarkers.set(person.id, marker);
      }
      // Changing a confidence label must not discard the interpolated position.
      if (marker.label !== person.label || marker.estimated !== estimated) {
        this.updateTrackingLabel(marker.labelSprite, person.label, color);
        marker.group.traverse(object => { if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshBasicMaterial) object.material.color.copy(color); });
        marker.label = person.label; marker.estimated = estimated;
      }
      const uncertainty = person.uncertaintyMeters ?? 0;
      marker.uncertaintyRing.visible = estimated && Number.isFinite(uncertainty) && uncertainty > 0;
      if (marker.uncertaintyRing.visible) marker.uncertaintyRing.scale.setScalar(Math.min(1.5, uncertainty));
      marker.target.copy(vector(person.position)); marker.expiresAt = person.expiresAt;
    }
    for (const [id, marker] of this.peopleMarkers) if (!current.has(id)) {
      this.disposeMeshes(marker.group); this.people.remove(marker.group); this.peopleMarkers.delete(id);
    }
  }
  private updateTrackingLabel(sprite: THREE.Sprite, label: string, color: THREE.Color, height = 0.24) {
    const canvas = document.createElement("canvas"), context = canvas.getContext("2d")!;
    const text = label.slice(0, 110);
    context.font = "bold 24px Segoe UI, sans-serif";
    canvas.width = Math.ceil(context.measureText(text).width) + 28; canvas.height = 44;
    context.fillStyle = "#10212a"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = "bold 24px Segoe UI, sans-serif"; context.fillStyle = color.getStyle(); context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(text, canvas.width / 2, 22);
    sprite.material.map?.dispose(); sprite.material.map = new THREE.CanvasTexture(canvas); sprite.material.needsUpdate = true;
    sprite.scale.set(height * canvas.width / canvas.height, height, 1);
  }
  setTrackingCameras(cameras: CameraCalibration[], selectedId?: string) {
    this.disposeMeshes(this.trackingCameras); this.trackingCameras.clear();
    if (this.disposed || !this.manifest?.ready || !this.manifest.navigation) return;
    const floorY = this.manifest.navigation.floorY;
    for (const camera of cameras) {
      const geometry = camera.geometry;
      if (camera.sceneVersion !== this.manifest.version || !geometry || geometry.worldFromCamera.length !== 9) continue;
      const r = geometry.worldFromCamera, k = geometry.intrinsics, centre = vector(geometry.center);
      if (![centre.x, centre.y, centre.z, ...r, k.fx, k.fy, k.cx, k.cy, camera.imageWidth, camera.imageHeight].every(Number.isFinite) || k.fx <= 0 || k.fy <= 0) continue;
      const selected = !selectedId || selectedId === camera.id;
      const color = new THREE.Color(selected ? 0x75d6ff : 0x5288a0), rotation = new THREE.Matrix3().set(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]);
      const group = new THREE.Group(); group.name = `tracking-camera:${camera.id}`;
      // Geometry already uses the saved room's metre coordinates, like people.
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.10, 0.18), new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }));
      body.position.copy(centre); body.setRotationFromMatrix(new THREE.Matrix4().setFromMatrix3(rotation)); body.renderOrder = 1002; group.add(body);
      const floorPoint = new THREE.Vector3(centre.x, floorY + 0.03, centre.z);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.10, 0.14, 24), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
      ring.position.copy(floorPoint); ring.rotation.x = -Math.PI / 2; ring.renderOrder = 1001; group.add(ring);
      const line = (points: THREE.Vector3[]) => {
        const object = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color, transparent: true, opacity: selected ? 0.8 : 0.4, depthTest: false, depthWrite: false }));
        object.renderOrder = 1000; group.add(object);
      };
      line([floorPoint, centre]);
      const depth = 0.8;
      const corners = [[0, 0], [camera.imageWidth, 0], [camera.imageWidth, camera.imageHeight], [0, camera.imageHeight]].map(([x, y]) => new THREE.Vector3((x - k.cx) / k.fx * depth, (y - k.cy) / k.fy * depth, depth).applyMatrix3(rotation).add(centre));
      for (const corner of corners) line([centre, corner]);
      line([...corners, corners[0]]);
      const forward = new THREE.Vector3(r[2], 0, r[8]);
      if (forward.lengthSq() > 1e-6) {
        forward.normalize(); const end = floorPoint.clone().addScaledVector(forward, 0.65), side = new THREE.Vector3(-forward.z, 0, forward.x);
        line([floorPoint, end]); line([end.clone().addScaledVector(forward, -0.16).addScaledVector(side, 0.09), end, end.clone().addScaledVector(forward, -0.16).addScaledVector(side, -0.09)]);
      }
      if (selected) {
        const label = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false }));
        this.updateTrackingLabel(label, `${camera.name} · Camera`, color, 0.18);
        label.position.copy(centre).add(new THREE.Vector3(0, 0.22, 0)); label.renderOrder = 1003; group.add(label);
      }
      this.trackingCameras.add(group);
    }
  }
  focusPeople(): boolean {
    if (this.disposed || this.paused || !this.manifest?.ready) return false;
    const now = Date.now();
    const positions = [...this.peopleMarkers.values()].filter(marker => marker.expiresAt > now && [marker.target.x, marker.target.y, marker.target.z].every(Number.isFinite)).map(marker => marker.target);
    if (!positions.length) return false;
    this.inspect(); this.resize();
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false; this.controls.update();
    const bounds = new THREE.Box3();
    for (const position of positions) {
      bounds.expandByPoint(position.clone().add(new THREE.Vector3(-0.3, 0, -0.3)));
      bounds.expandByPoint(position.clone().add(new THREE.Vector3(0.3, 2.2, 0.3)));
    }
    const centre = bounds.getCenter(new THREE.Vector3()), radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
    const verticalHalfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * this.camera.aspect);
    const distance = Math.max(2.5, radius / Math.sin(Math.min(verticalHalfFov, horizontalHalfFov)) * 1.25);
    const bearing = this.camera.position.clone().sub(this.controls.target); bearing.y = 0;
    if (bearing.lengthSq() < 1e-6) bearing.set(0, 0, 1);
    bearing.normalize(); bearing.y = 0.6; bearing.normalize();
    this.controls.target.copy(centre); this.camera.position.copy(centre).addScaledVector(bearing, distance); this.camera.up.set(0, 1, 0);
    this.controls.update(); this.controls.enableDamping = damping; this.levelled = false; this.updateClipping();
    this.camera.far = Math.max(this.camera.far, distance + radius * 2); this.camera.updateProjectionMatrix();
    this.onStatus?.(`${positions.length} live human${positions.length === 1 ? "" : "s"} in view. Drag to orbit or start walking.`);
    return true;
  }
  markFloorReferences(points: { x: number; z: number }[]) {
    this.disposeMeshes(this.floorReferences); this.floorReferences.clear();
    if (!this.manifest?.navigation) return;
    const floorY = this.manifest.navigation.floorY;
    const sorted = points.filter(p => [p.x, p.z].every(Number.isFinite)).map(p => ({ ...p })).sort((a, b) => a.x - b.x || a.z - b.z);
    const distinct = sorted.filter((p, index) => !index || p.x !== sorted[index - 1].x || p.z !== sorted[index - 1].z);
    const turn = (a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number }) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    const half = (values: typeof distinct) => {
      const result: typeof distinct = [];
      for (const p of values) {
        while (result.length >= 2 && turn(result[result.length - 2], result[result.length - 1], p) <= 1e-10) result.pop();
        result.push(p);
      }
      return result.slice(0, -1);
    };
    const hull = distinct.length <= 1 ? distinct : [...half(distinct), ...half([...distinct].reverse())];
    // These already use the saved room's metre frame. The hull shows reference
    // matches, not the camera's optical field of view or physical position.
    if (hull.length >= 2) {
      const outlineGeometry = new THREE.BufferGeometry().setFromPoints(hull.map(p => new THREE.Vector3(p.x, floorY + 0.02, p.z)));
      const outlineMaterial = new THREE.LineBasicMaterial({ color: 0xffd37a, depthTest: false, depthWrite: false });
      const outline = hull.length >= 3 ? new THREE.LineLoop(outlineGeometry, outlineMaterial) : new THREE.Line(outlineGeometry, outlineMaterial);
      outline.renderOrder = 999; this.floorReferences.add(outline);
      if (hull.length >= 3) {
        const polygon = hull.map(p => new THREE.Vector2(p.x, p.z));
        const fillGeometry = new THREE.BufferGeometry().setFromPoints(hull.map(p => new THREE.Vector3(p.x, floorY + 0.012, p.z)));
        fillGeometry.setIndex(THREE.ShapeUtils.triangulateShape(polygon, []).flat());
        const fill = new THREE.Mesh(fillGeometry, new THREE.MeshBasicMaterial({ color: 0xffd37a, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
        fill.renderOrder = 998; this.floorReferences.add(fill);
      }
      const canvas = document.createElement("canvas"), context = canvas.getContext("2d")!;
      const text = "Camera floor matches";
      context.font = "bold 24px Segoe UI, sans-serif";
      canvas.width = Math.ceil(context.measureText(text).width) + 28; canvas.height = 44;
      context.fillStyle = "#10212a"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.font = "bold 24px Segoe UI, sans-serif"; context.fillStyle = "#ffd37a"; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(text, canvas.width / 2, 22);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, depthWrite: false }));
      label.position.set(hull.reduce((sum, p) => sum + p.x, 0) / hull.length, floorY + 0.22, hull.reduce((sum, p) => sum + p.z, 0) / hull.length);
      label.scale.set(0.22 * canvas.width / canvas.height, 0.22, 1); label.renderOrder = 1001; this.floorReferences.add(label);
    }
    points.forEach((p, index) => {
      if (![p.x, p.z].every(Number.isFinite)) return;
      const position = new THREE.Vector3(p.x, floorY + 0.015, p.z);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 6), new THREE.MeshBasicMaterial({ color: 0xffd37a, depthTest: false, depthWrite: false }));
      dot.position.copy(position); dot.renderOrder = 1000; this.floorReferences.add(dot);
      const canvas = document.createElement("canvas"), context = canvas.getContext("2d")!;
      canvas.width = 48; canvas.height = 48; context.fillStyle = "#10212a"; context.fillRect(0, 0, 48, 48);
      context.font = "bold 26px Segoe UI, sans-serif"; context.fillStyle = "#ffd37a"; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(`${index + 1}`, 24, 24);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, depthWrite: false }));
      label.position.copy(position).add(new THREE.Vector3(0, 0.16, 0)); label.scale.setScalar(0.18); label.renderOrder = 1001; this.floorReferences.add(label);
    });
  }
  mark(calibration: Calibration, tool: CalibrationTool, pending?: Point | null, showGrid = false) {
    this.disposeMeshes(this.annotations); this.annotations.clear();
    if (!this.mesh || !this.manifest) return;
    const size = this.mesh.getBoundingBox().getSize(new THREE.Vector3()).length() * 0.003;
    const label = (position: THREE.Vector3, text: string, color = "#b9f2d5") => {
      const canvas = document.createElement("canvas"), context = canvas.getContext("2d")!;
      context.font = "bold 26px Segoe UI, sans-serif";
      canvas.width = Math.ceil(context.measureText(text).width) + 30; canvas.height = 48;
      context.fillStyle = "#10212a"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.font = "bold 26px Segoe UI, sans-serif"; context.fillStyle = color; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(text, canvas.width / 2, 24);
      const texture = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false }));
      sprite.position.copy(position); sprite.scale.set(size * 4 * canvas.width / canvas.height, size * 4, 1); sprite.renderOrder = 1002; this.annotations.add(sprite);
    };
    const dot = (p: Point, text?: string, color = 0xaee9c6) => {
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(size, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }));
      sphere.position.copy(vector(p)); sphere.renderOrder = 1001; this.annotations.add(sphere);
      if (text) label(vector(p).addScaledVector(new THREE.Vector3(0, 1, 0).transformDirection(this.root.matrix.clone().invert()), size * 5), text);
    };
    const line = (points: Point[], color: number, closed = false) => {
      if (points.length < 2) return;
      const geometry = new THREE.BufferGeometry().setFromPoints(points.map(vector));
      const material = new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false });
      const object = closed ? new THREE.LineLoop(geometry, material) : new THREE.Line(geometry, material);
      object.renderOrder = 1000; this.annotations.add(object);
    };
    const ruler = (a: Point, b: Point, name: string, length?: number) => {
      line([a, b], 0xffd37a);
      label(vector(a).lerp(vector(b), 0.5), `${name}${length !== undefined ? ` · ${length.toFixed(2)} m` : " · set scale"}`, "#ffd37a");
    };
    calibration.measurement.forEach((p, i) => dot(p, i ? "B" : "A", 0xffd37a));
    if (calibration.measurement.length === 2) ruler(calibration.measurement[0], calibration.measurement[1], "Reference", metersPerUnit(calibration) ? calibration.meters : undefined);
    if (tool === "floor" || tool === "floor-height") calibration.floor.forEach((p, i) => dot(p, `Floor ${i + 1}`));
    line(calibration.boundary, 0x6edbd2, calibration.boundary.length >= 3);
    if (tool === "boundary") calibration.boundary.forEach((p, i) => dot(p, calibration.boundary.length <= 12 || i % 3 === 0 ? `${i + 1}` : undefined, 0x6edbd2));
    const frame = floorFrame(calibration, this.manifest);
    if (frame && showGrid && ["floor", "floor-height", "boundary"].includes(tool)) {
      const scale = metersPerUnit(calibration);
      const rootScale = new THREE.Vector3().setFromMatrixScale(this.root.matrix).x;
      const extent = this.sceneBox().getSize(new THREE.Vector3()).length() / rootScale;
      const divisions = scale ? Math.max(2, Math.min(60, Math.ceil(extent * scale))) : 20;
      const grid = new THREE.GridHelper(scale ? divisions / scale : extent, divisions, 0xffd37a, 0x6edbd2);
      const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
      materials.forEach(material => { material.transparent = true; material.opacity = 0.4; material.depthWrite = false; });
      grid.matrix.makeBasis(frame.right, frame.up, frame.back).setPosition(frame.origin.clone().addScaledVector(frame.up, extent * 1e-5));
      grid.matrixAutoUpdate = false; grid.renderOrder = 990; this.annotations.add(grid);
    }
    if (frame && calibration.boundary.length >= 3) {
      const polygon = calibration.boundary.map(p => { const q = vector(p).sub(frame.origin); return new THREE.Vector2(q.dot(frame.right), q.dot(frame.back)); });
      const triangles = THREE.ShapeUtils.triangulateShape(polygon, []).flat();
      const geometry = new THREE.BufferGeometry().setFromPoints(calibration.boundary.map(vector)); geometry.setIndex(triangles);
      const fill = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x6edbd2, transparent: true, opacity: 0.10, side: THREE.DoubleSide, depthWrite: false }));
      this.annotations.add(fill);
    }
    if (calibration.spawn) dot(calibration.spawn, "Start", 0xaee9c6);
    const scale = metersPerUnit(calibration);
    calibration.dimensions?.forEach(d => { dot(d.a); dot(d.b); ruler(d.a, d.b, d.name, scale ? vector(d.a).distanceTo(vector(d.b)) * scale : undefined); });
    calibration.obstacles.forEach(b => {
      const a = vector(b.a).applyMatrix4(this.root.matrix), end = vector(b.b).applyMatrix4(this.root.matrix);
      const box = new THREE.Box3().setFromPoints([a, end]);
      const geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
      const helper = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xff6f83, depthTest: false }));
      helper.matrix.copy(this.root.matrix).invert().multiply(new THREE.Matrix4().compose(box.getCenter(new THREE.Vector3()), new THREE.Quaternion(), box.getSize(new THREE.Vector3())));
      helper.matrixAutoUpdate = false; this.annotations.add(helper);
    });
    if (pending) dot(pending, tool === "dimension" ? "First end" : "First corner", 0xffd37a);
    this.annotations.visible = !this.walking;
  }
  async walk() {
    if (!this.manifest?.ready || !this.manifest.navigation || !this.collision) throw Error("Calibrate and review this room first");
    const generation = this.generation;
    await initializePhysics();
    if (this.disposed || generation !== this.generation) return;
    this.world?.free(); this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); this.world.timestep = 1 / 60;
    const n = this.manifest.navigation;
    this.scene.updateMatrixWorld(true);
    this.collision.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld), positions = geometry.getAttribute("position");
      const vertices = new Float32Array(positions.count * 3);
      for (let i = 0; i < positions.count; i++) { vertices[i * 3] = positions.getX(i); vertices[i * 3 + 1] = positions.getY(i); vertices[i * 3 + 2] = positions.getZ(i); }
      const indices = geometry.index ? new Uint32Array(geometry.index.array) : Uint32Array.from({ length: positions.count }, (_, i) => i);
      this.world!.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices)); geometry.dispose();
    });
    const polygon = n.boundary.map(([x, z]) => new THREE.Vector2(x, z));
    const triangles = THREE.ShapeUtils.triangulateShape(polygon, []).flat();
    this.world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(n.boundary.flatMap(([x, z]) => [x, n.floorY, z])), new Uint32Array(triangles)));
    for (let i = 0; i < n.boundary.length; i++) {
      const a = n.boundary[i], b = n.boundary[(i + 1) % n.boundary.length], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(b[1] - a[1], b[0] - a[0]));
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(length / 2, 2.5, 0.025).setTranslation((a[0] + b[0]) / 2, n.floorY + 2.5, (a[1] + b[1]) / 2).setRotation(q));
    }
    for (const box of n.obstacles) this.world.createCollider(RAPIER.ColliderDesc.cuboid(box.size[0] / 2, box.size[1] / 2, box.size[2] / 2).setTranslation(...box.center));
    const spawn = { x: n.spawn[0], y: n.spawn[1] + n.capsuleHeight / 2 + 0.035, z: n.spawn[2] };
    const shape = new RAPIER.Capsule(n.capsuleHeight / 2 - n.capsuleRadius, n.capsuleRadius);
    this.world.step();
    let blocked = false;
    // Slightly shrink the clearance probe so normal floor contact is not an overlap.
    const probe = new RAPIER.Capsule(shape.halfHeight, n.capsuleRadius - 0.015);
    this.world.intersectionsWithShape(spawn, { x: 0, y: 0, z: 0, w: 1 }, probe, () => { blocked = true; return false; });
    if (blocked) { this.world.free(); this.world = undefined; throw Error("Spawn intersects a collision surface. Choose an open floor location and recalibrate."); }
    this.player = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y, spawn.z));
    this.capsule = this.world.createCollider(RAPIER.ColliderDesc.capsule(shape.halfHeight, n.capsuleRadius), this.player);
    this.controller = this.world.createCharacterController(0.015); this.controller.enableSnapToGround(0.15); this.controller.enableAutostep(0.15, 0.3, false);
    this.yaw = n.yaw; this.pitch = 0; this.vertical = 0; this.accumulator = 0;
    this.controls.enabled = false; this.walking = true; this.annotations.visible = false; this.keys.clear();
    this.onStatus?.("Click the room, then use WASD and the mouse. Escape releases the mouse.");
  }
  inspect() {
    const wasWalking = this.walking;
    this.walking = false; this.keys.clear(); this.vertical = 0; this.accumulator = 0;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.controls.enabled = !this.paused;
    this.annotations.visible = true;
    if (wasWalking) this.controls.target.copy(this.camera.position).add(this.camera.getWorldDirection(new THREE.Vector3()));
    this.world?.free(); this.world = undefined; this.player = undefined; this.capsule = undefined; this.controller = undefined;
  }
  private disposeMeshes(root: THREE.Object3D) { root.traverse(object => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Sprite) {
      if (!(object instanceof THREE.Sprite)) object.geometry.dispose();
      (Array.isArray(object.material) ? object.material : [object.material]).forEach(m => { if (m instanceof THREE.SpriteMaterial) m.map?.dispose(); m.dispose(); });
    }
  }); }
  private clear() { this.disposeMeshes(this.trackingCameras); this.trackingCameras.clear(); this.disposeMeshes(this.floorReferences); this.floorReferences.clear(); this.disposeMeshes(this.people); this.people.clear(); this.peopleMarkers.clear(); this.mesh?.dispose(); this.mesh = undefined; if (this.collision) this.disposeMeshes(this.collision); this.collision = undefined; this.root.clear(); this.disposeMeshes(this.annotations); this.annotations.clear(); this.root.add(this.annotations); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; ++this.generation; this.abort.abort(); this.inspect(); this.stopRendering(); this.observer.disconnect(); this.controls.removeEventListener("start", this.orbitStart); this.controls.removeEventListener("end", this.orbitEnd); this.controls.dispose();
    this.canvas.removeEventListener("pointerdown", this.pointerDown); this.canvas.removeEventListener("pointerup", this.pointerUp); this.canvas.removeEventListener("click", this.lock);
    document.removeEventListener("pointerlockchange", this.unlock); document.removeEventListener("pointerlockerror", this.lockError); document.removeEventListener("mousemove", this.mouse);
    window.removeEventListener("keydown", this.keyDown); window.removeEventListener("keyup", this.keyUp); window.removeEventListener("blur", this.blur); document.removeEventListener("visibilitychange", this.visibility);
    this.canvas.remove();
    const release = () => { if (this.spark.sorting) { setTimeout(release, 16); return; } this.clear(); this.spark.dispose(); this.renderer.dispose(); };
    release();
  }
}
