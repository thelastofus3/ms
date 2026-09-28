import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  AvatarController,
  RigAdapter,
  type Binding,
  type Quat,
} from "./controller";

export interface Manifest {
  avatar_id: string;
  version: number;
  schema_version: "1.0";
  representation: "skinned-glb";
  height_m: number;
  sha256: string;
  model_file: "avatar.glb";
  rig: Record<string, { node: number; rest: Quat; basis: Quat }>;
  clips: string[];
}
export class AvatarRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
  private orbit: OrbitControls;
  private frame = 0;
  private previous = 0;
  private disposed = false;
  private loadGeneration = 0;
  private observer: ResizeObserver;
  private keys = new Set<string>();
  private loaded: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private actions: Record<string, THREE.AnimationAction> = {};
  private active: string | null = null;
  controller: AvatarController | null = null;
  constructor(private element: HTMLDivElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.element.appendChild(this.renderer.domElement);
    this.camera.position.set(2.1, 1.55, 3.5);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(0, 0.95, 0);
    this.orbit.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xe8f6ff, 0x756656, 3));
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.position.set(2, 4, 3);
    this.scene.add(sun);
    const grid = new THREE.GridHelper(12, 24, 0x566373, 0x263441);
    this.scene.add(grid);
    this.observer = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      this.renderer.setSize(width, height);
      this.camera.aspect = width / Math.max(1, height);
      this.camera.updateProjectionMatrix();
    });
    this.observer.observe(element);
    element.tabIndex = 0;
    element.addEventListener("keydown", this.keydown);
    element.addEventListener("keyup", this.keyup);
    element.addEventListener("blur", this.blur);
    this.frame = requestAnimationFrame(this.tick);
  }
  private keydown = (event: KeyboardEvent) => {
    if (
      [
        "w",
        "a",
        "s",
        "d",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
      ].includes(event.key)
    ) {
      event.preventDefault();
      this.keys.add(event.key);
    }
  };
  private keyup = (event: KeyboardEvent) => {
    this.keys.delete(event.key);
  };
  private blur = () => this.keys.clear();
  private tick = (now: number) => {
    if (this.disposed) return;
    const dt = Math.min(0.05, (now - this.previous) / 1000);
    this.previous = now;
    const forward =
      Number(this.keys.has("w") || this.keys.has("ArrowUp")) -
      Number(this.keys.has("s") || this.keys.has("ArrowDown"));
    const turn =
      Number(this.keys.has("a") || this.keys.has("ArrowLeft")) -
      Number(this.keys.has("d") || this.keys.has("ArrowRight"));
    this.controller?.update(dt, now, { forward, turn });
    const clip = this.controller?.clip ?? null;
    if (clip !== this.active) {
      this.mixer?.stopAllAction();
      if (clip) this.actions[clip]?.reset().play();
      this.active = clip;
    }
    if (clip) this.mixer?.update(dt);
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.tick);
  };
  cancelPendingLoads() {
    this.loadGeneration++;
  }
  async load(manifest: Manifest, bytes: ArrayBuffer) {
    if (this.disposed) return;
    const generation = ++this.loadGeneration;
    if (
      manifest.schema_version !== "1.0" ||
      manifest.representation !== "skinned-glb"
    )
      throw Error("Неподдерживаемый формат аватара");
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    )
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    if (hash !== manifest.sha256)
      throw Error("Контрольная сумма модели не совпадает");
    if (this.disposed || generation !== this.loadGeneration) return;
    const gltf = await new GLTFLoader().parseAsync(bytes, "");
    if (this.disposed || generation !== this.loadGeneration) {
      this.disposeObject(gltf.scene);
      return;
    }
    const bindings: Record<string, Binding> = {};
    try {
      for (const [name, b] of Object.entries(manifest.rig)) {
        const node = await gltf.parser.getDependency("node", b.node);
        if (!node.isBone) throw Error(`Не найдена кость ${name}`);
        bindings[name] = {
          bone: node,
          rest: new THREE.Quaternion().fromArray(b.rest),
          basis: new THREE.Quaternion().fromArray(b.basis),
        };
      }
    } catch (error) {
      this.disposeObject(gltf.scene);
      throw error;
    }
    if (this.disposed || generation !== this.loadGeneration) {
      this.disposeObject(gltf.scene);
      return;
    }
    if (this.loaded) {
      this.scene.remove(this.loaded);
      this.disposeObject(this.loaded);
    }
    this.loaded = new THREE.Group();
    this.loaded.add(gltf.scene);
    this.scene.add(this.loaded);
    this.mixer = new THREE.AnimationMixer(gltf.scene);
    this.actions = {};
    this.active = null;
    for (const clip of gltf.animations)
      this.actions[clip.name] = this.mixer.clipAction(clip);
    this.controller = new AvatarController(
      this.loaded,
      new RigAdapter(bindings),
      this.mixer,
    );
    const box = new THREE.Box3().setFromObject(gltf.scene);
    return {
      height: box.max.y - box.min.y,
      minimumY: box.min.y,
      bones: Object.keys(bindings).length,
      clips: gltf.animations.map((a) => a.name),
    };
  }
  private disposeObject(root: THREE.Object3D) {
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        for (const m of Array.isArray(object.material)
          ? object.material
          : [object.material]) {
          for (const value of Object.values(m))
            if (value instanceof THREE.Texture) value.dispose();
          m.dispose();
        }
      }
    });
  }
  dispose() {
    this.disposed = true;
    this.cancelPendingLoads();
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.orbit.dispose();
    this.mixer?.stopAllAction();
    this.scene.traverse((o) => {
      if (o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    if (this.loaded) this.disposeObject(this.loaded);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.element.removeEventListener("keydown", this.keydown);
    this.element.removeEventListener("keyup", this.keyup);
    this.element.removeEventListener("blur", this.blur);
  }
}
