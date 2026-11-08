import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { demoPose, type Motion } from "./rig";
import { fetchRigPackage, RiggedAvatar } from "./riggedAvatar";

export class GaussianRenderer {
  readonly canvas: HTMLCanvasElement;
  motion: Motion = "idle";
  playing = true;
  arms = 0;
  private renderer = new THREE.WebGLRenderer({ antialias: false });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  private controls: OrbitControls;
  private spark: SparkRenderer;
  private mesh?: SplatMesh;
  private avatar?: RiggedAvatar;
  private abort = new AbortController();
  private generation = 0;
  private disposed = false;
  private frame = 0;
  private observer: ResizeObserver;
  private time = 0;
  private last = 0;
  constructor(private host: HTMLElement) {
    this.canvas = this.renderer.domElement;
    this.canvas.dataset.testid = "gaussian-canvas";
    host.append(this.canvas);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.scene.background = new THREE.Color("#e6e8e7");
    this.spark = new SparkRenderer({
      renderer: this.renderer,
      covSplats: true,
      accumExtSplats: true,
    });
    this.scene.add(this.spark);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.resetView();
    this.observer = new ResizeObserver(() => {
      const w = Math.max(1, host.clientWidth),
        h = Math.max(1, host.clientHeight);
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    });
    this.observer.observe(host);
    const tick = (now: number) => {
      if (this.disposed) return;
      if (this.playing)
        this.time += Math.min((now - (this.last || now)) / 1000, 0.05);
      this.last = now;
      if (this.avatar)
        this.avatar.pose(demoPose(this.avatar.rig.data, this.motion, this.time, this.arms));
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }
  resetView() {
    // Frame the loaded avatar from the front (+z), slightly above its centre; fall back to a standing adult.
    const box = this.mesh?.getBoundingBox();
    const center = box && !box.isEmpty() ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3(0, 0.9, 0);
    const size = box && !box.isEmpty() ? box.getSize(new THREE.Vector3()).length() : 2;
    this.controls.target.copy(center);
    this.camera.position.set(center.x, center.y + 0.1 * size, center.z + 1.5 * size);
    this.controls.update();
  }
  private clear() {
    if (this.mesh) this.scene.remove(this.mesh);
    if (this.avatar) this.avatar.dispose();
    else this.mesh?.dispose();
    this.mesh = undefined;
    this.avatar = undefined;
  }
  private begin() {
    this.abort.abort();
    this.abort = new AbortController();
    this.clear();
    return ++this.generation;
  }
  /** Loads a rigged `gaussian-rig` package (manifest.json, avatar.splat, indices.bin, weights.bin) from a base URL. */
  async loadRigPackage(baseUrl: string): Promise<number | undefined> {
    const generation = this.begin();
    const pkg = await fetchRigPackage(baseUrl, this.abort.signal);
    if (generation !== this.generation || this.disposed) return;
    const avatar = await RiggedAvatar.create(pkg);
    if (generation !== this.generation || this.disposed) { avatar.dispose(); return; }
    this.avatar = avatar;
    this.mesh = avatar.mesh;
    this.scene.add(avatar.mesh);
    this.resetView();
    return pkg.manifest.num_splats;
  }
  async loadFile(file: File): Promise<number | undefined> {
    const generation = this.begin();
    if (!/\.(ply|splat)$/i.test(file.name) || file.size > 300 * 1024 * 1024)
      throw Error("Choose a PLY or SPLAT file up to 300 MB");
    const buffer = await file.arrayBuffer();
    if (generation !== this.generation || this.disposed) return;
    const mesh = new SplatMesh({
      fileBytes: buffer,
      fileName: file.name,
      covSplats: true,
      extSplats: true,
      lod: false,
    });
    try {
      await mesh.initialized;
      if (generation !== this.generation || this.disposed) {
        mesh.dispose();
        return;
      }
      this.mesh = mesh;
      this.scene.add(mesh);
      const box = mesh.getBoundingBox(),
        center = box.getCenter(new THREE.Vector3());
      this.controls.target.copy(center);
      this.camera.position
        .copy(center)
        .add(
          new THREE.Vector3(
            0,
            0,
            Math.max(1, box.getSize(new THREE.Vector3()).length() * 1.4),
          ),
        );
      this.controls.update();
      return mesh.numSplats;
    } catch (error) {
      mesh.dispose();
      throw error;
    }
  }
  dispose() {
    this.disposed = true;
    ++this.generation;
    this.abort.abort();
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.controls.dispose();
    this.canvas.remove();
    // Spark 2.2's dispose does not drain asynchronous GPU readback/sorting.
    // Stop scheduling, then release targets after the in-flight job finishes.
    this.spark.autoUpdate = false;
    this.spark.sortDirty = false;
    clearTimeout(this.spark.sortTimeoutId);
    this.spark.sortTimeoutId = -1;
    const release = () => {
      if (this.spark.sorting) { setTimeout(release, 16); return; }
      this.clear();
      this.spark.dispose();
      this.renderer.dispose();
    };
    release();
  }
}
