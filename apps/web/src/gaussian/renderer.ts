import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  SparkRenderer,
  SplatMesh,
  SplatSkinning,
  SplatSkinningMode,
} from "@sparkjsdev/spark";
import { GaussianRig, demoPose, validateManifest, type Motion } from "./rig";

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
  private skinning?: SplatSkinning;
  private rig?: GaussianRig;
  private abort = new AbortController();
  private generation = 0;
  private disposed = false;
  private frame = 0;
  private observer: ResizeObserver;
  private time = 0;
  private last = 0;
  private previousPose = "";
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
      if (this.rig && this.skinning && this.mesh) {
        const pose = demoPose(this.rig.data, this.motion, this.time, this.arms);
        const key = JSON.stringify(pose);
        if (key !== this.previousPose) {
          this.previousPose = key;
          this.rig
            .matrices(pose)
            .forEach((m, i) => this.skinning!.setBoneMatrix(i, m));
          this.skinning.updateBones();
          this.mesh.needsUpdate = true;
        }
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }
  resetView() {
    this.camera.position.set(0, -0.15, 3.6);
    this.controls.target.set(0, -0.2, 0);
    this.controls.update();
  }
  private clear() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.dispose();
    }
    this.skinning?.skinTexture.dispose();
    this.skinning?.boneTexture.dispose();
    this.mesh = undefined;
    this.skinning = undefined;
    this.rig = undefined;
    this.previousPose = "";
  }
  private begin() {
    this.abort.abort();
    this.abort = new AbortController();
    this.clear();
    return ++this.generation;
  }
  async loadDemo(): Promise<number | undefined> {
    const generation = this.begin(),
      signal = this.abort.signal;
    const get = async (file: string) => {
      const response = await fetch(`/gaussian-demo/${file}`, { signal });
      if (!response.ok)
        throw Error(
          "Пример не подготовлен. Запустите scripts/prepare-gaussian-demo.ps1",
        );
      return response;
    };
    const manifest = validateManifest(
      await (await get("manifest.json")).json(),
    );
    const buffers = await Promise.all(
      [manifest.model, manifest.indices, manifest.weights].map(async (file) => {
        const buffer = await (await get(file)).arrayBuffer();
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
        )
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("");
        if (hash !== manifest.sha256[file])
          throw Error(`Повреждён файл ${file}`);
        return buffer;
      }),
    );
    const n = manifest.num_splats;
    if (
      buffers[0].byteLength !== n * 32 ||
      buffers[1].byteLength !== n * 4 ||
      buffers[2].byteLength !== n * 16
    )
      throw Error("Размеры Gaussian-пакета не совпадают");
    const indices = new Uint8Array(buffers[1]),
      weights = new Float32Array(buffers[2]);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const j = i * 4 + k;
        if (
          indices[j] >= manifest.rig.parents.length ||
          !Number.isFinite(weights[j]) ||
          weights[j] < 0 ||
          weights[j] > 1
        )
          throw Error("Некорректная привязка к скелету");
        sum += weights[j];
      }
      if (Math.abs(sum - 1) > 1e-4)
        throw Error("Веса скелета не нормализованы");
    }
    if (generation !== this.generation || this.disposed) return;
    const mesh = new SplatMesh({
      fileBytes: buffers[0],
      fileName: "avatar.splat",
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
      if (mesh.numSplats !== n) throw Error("Изменилось число Gaussian");
      const skinning = new SplatSkinning({
        mesh,
        numBones: manifest.rig.parents.length,
        mode: SplatSkinningMode.LINEAR_BLEND,
      });
      const bone = new THREE.Vector4(),
        weight = new THREE.Vector4();
      for (let i = 0; i < n; i++)
        skinning.setSplatBones(
          i,
          bone.fromArray(indices, i * 4),
          weight.fromArray(weights, i * 4),
        );
      manifest.rig.parents.forEach((_, i) =>
        skinning.setRestMatrix(i, new THREE.Matrix4()),
      );
      skinning.skinTexture.needsUpdate = true;
      mesh.skinning = skinning;
      mesh.updateGenerator();
      this.skinning = skinning;
      this.rig = new GaussianRig(manifest.rig);
      this.mesh = mesh;
      this.scene.add(mesh);
      this.resetView();
      return n;
    } catch (error) {
      mesh.dispose();
      throw error;
    }
  }
  async loadFile(file: File): Promise<number | undefined> {
    const generation = this.begin();
    if (!/\.(ply|splat)$/i.test(file.name) || file.size > 300 * 1024 * 1024)
      throw Error("Выберите PLY или SPLAT размером до 300 МБ");
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
