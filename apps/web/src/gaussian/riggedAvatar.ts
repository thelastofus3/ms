import * as THREE from "three";
import { SplatMesh, SplatSkinning, SplatSkinningMode } from "@sparkjsdev/spark";
import { GaussianRig, type GaussianManifest, validateManifest } from "./rig";

/** A verified `gaussian-rig` package: shared, read-only bytes that any number of avatar instances can use. */
export type RigPackage = { manifest: GaussianManifest; splat: ArrayBuffer; indices: Uint8Array; weights: Float32Array };

export async function fetchRigPackage(baseUrl: string, signal?: AbortSignal): Promise<RigPackage> {
  const get = async (file: string) => {
    const response = await fetch(`${baseUrl}/${file}`, { signal });
    if (!response.ok) throw Error(`The rigged avatar file ${file} is unavailable`);
    return response;
  };
  const manifest = validateManifest(await (await get("manifest.json")).json());
  const [splat, indices, weights] = await Promise.all([manifest.model, manifest.indices, manifest.weights].map(async file => {
    const buffer = await (await get(file)).arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))).map(v => v.toString(16).padStart(2, "0")).join("");
    if (hash !== manifest.sha256[file]) throw Error(`The file ${file} is corrupted`);
    return buffer;
  }));
  const n = manifest.num_splats;
  if (splat.byteLength !== n * 32 || indices.byteLength !== n * 4 || weights.byteLength !== n * 16)
    throw Error("The Gaussian package sizes do not match");
  const bones = new Uint8Array(indices), values = new Float32Array(weights);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const j = i * 4 + k;
      if (bones[j] >= manifest.rig.parents.length || !Number.isFinite(values[j]) || values[j] < 0 || values[j] > 1)
        throw Error("Invalid skeleton binding");
      sum += values[j];
    }
    if (Math.abs(sum - 1) > 1e-4) throw Error("Skeleton weights are not normalized");
  }
  return { manifest, splat, indices: bones, weights: values };
}

/** One posable instance: its own SplatMesh and bone texture, so several people can move independently. */
export class RiggedAvatar {
  private previousPose = "";
  private constructor(readonly mesh: SplatMesh, readonly rig: GaussianRig, private skinning: SplatSkinning) {}
  static async create(pkg: RigPackage): Promise<RiggedAvatar> {
    // SplatMesh may take ownership of the bytes it parses; give each instance its own copy.
    const mesh = new SplatMesh({ fileBytes: pkg.splat.slice(0), fileName: "avatar.splat", covSplats: true, extSplats: true, lod: false });
    try {
      await mesh.initialized;
      if (mesh.numSplats !== pkg.manifest.num_splats) throw Error("The number of Gaussians changed");
      const skinning = new SplatSkinning({ mesh, numBones: pkg.manifest.rig.parents.length, mode: SplatSkinningMode.LINEAR_BLEND });
      const bone = new THREE.Vector4(), weight = new THREE.Vector4();
      for (let i = 0; i < pkg.manifest.num_splats; i++)
        skinning.setSplatBones(i, bone.fromArray(pkg.indices, i * 4), weight.fromArray(pkg.weights, i * 4));
      pkg.manifest.rig.parents.forEach((_, i) => skinning.setRestMatrix(i, new THREE.Matrix4()));
      skinning.skinTexture.needsUpdate = true;
      mesh.skinning = skinning;
      mesh.updateGenerator();
      return new RiggedAvatar(mesh, new GaussianRig(pkg.manifest.rig), skinning);
    } catch (error) {
      mesh.dispose();
      throw error;
    }
  }
  /** Applies joint axis-angles (T-pose relative); skips the GPU update when the pose did not change. */
  pose(angles: number[][]) {
    const key = JSON.stringify(angles);
    if (key === this.previousPose) return;
    this.previousPose = key;
    this.rig.matrices(angles).forEach((matrix, i) => this.skinning.setBoneMatrix(i, matrix));
    this.skinning.updateBones();
    this.mesh.needsUpdate = true;
  }
  dispose() {
    this.mesh.dispose();
    this.skinning.skinTexture.dispose();
    this.skinning.boneTexture.dispose();
  }
}
