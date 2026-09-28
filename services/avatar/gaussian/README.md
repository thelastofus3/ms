# Gaussian avatar experiment

This is an isolated HUGS experiment alongside MPFB. Capture preparation accepts
video or photos; it does **not** reconstruct a person. The existing web/API
continues to use GLB. HUGS inference, training and browser deformation must each
be verified separately.

## 1. Prepare a local capture

From the repository root, using the existing avatar virtual environment:

```powershell
.venv/Scripts/python.exe -m avatar_service.capture C:/capture/person.mp4 .runtime/captures/person-video --fps 2 --max-frames 120 --max-side 1024
.venv/Scripts/python.exe -m avatar_service.capture C:/capture/photos .runtime/captures/person-photos --max-frames 120
```

FFmpeg must be on PATH for video. Photos are read directly from the directory
(JPEG/PNG/WebP/BMP/TIFF), sorted by filename; subdirectories are not searched.
Video samples the beginning at the requested FPS until the frame limit. Thus
120 frames at 2 FPS cover at most the first 60 seconds, not an entire long clip.
Select footage with front/back/side coverage; automatic viewpoint selection is
not implemented. A single photo is accepted but cannot establish unseen surfaces.

Output is a new directory containing RGB JPEGs and a SHA256 manifest. Images
are rotated using EXIF, resized without upscaling, and written without original
metadata. Limits: 10,000 frames, 8192 pixels on the long side, 40 megapixels per
input photo, five minutes for FFmpeg. Existing output is rejected. Failed
decoding does not publish a partial capture. Original media remains local.

`status=frames_only` and `training_ready=false` mean masks, cameras, body pose
fitting and a dataset adapter are still required. This is not a NeuMan dataset.

## 2. Build the isolated runtime

Requires Docker Desktop with Linux containers and NVIDIA GPU passthrough:

```powershell
./scripts/bootstrap-hugs.ps1 -Build
```

The script uses `.tools/hugs-runtime`, checks HUGS revision
`86ebe5522a384fc553f07f090b63a76dd4af8d33`, and refuses a different revision or
local modifications. It leaves the earlier `.tools/hugs` directory intact.
The original `simple-knn` server failed during this experiment; the matching
commit can be fetched using an explicit mirror:

```powershell
./scripts/bootstrap-hugs.ps1 -Build -SimpleKnnMirror https://gitlab.com/shicheng402/simple-knn.git
```

The mirror changes the download location, not the gitlink revision
`f155ec04131cb579f53443a06879d37115f4612f`. Rasterizer revision is
`59f5f77e3ddbac3ed9db93ec2cfe99ed6c5d121d`. The runtime uses Python 3.8,
PyTorch 1.13.1, CUDA 11.7, the upstream PyTorch3D wheel, and NumPy 1.23.5 for
legacy SMPL/chumpy compatibility. CUDA extensions target RTX 2060 (SM 7.5).
Change `TORCH_CUDA_ARCH_LIST` and rebuild for another architecture. The image
is for this research stack, separate from the service's Python 3.13.
Transitive pip dependencies are not fully locked; this is a version-pinned
experiment recipe, not a bit-for-bit reproducible software distribution.

```powershell
$root = (Get-Location).Path
docker run --rm --gpus all --mount "type=bind,source=$root/services/avatar/gaussian,target=/experiment,readonly" avatar-hugs:86ebe55 python /experiment/gpu_probe.py
```

This runs actual simple-knn, PyTorch3D and Gaussian rasterization CUDA operations.
`cuda_kernels_passed` is not avatar inference or an avatar VRAM measurement.

## 3. Canonical checkpoint preview without SMPL

The public checkpoint includes canonical points and neural decoder weights.
`hugs_preview.py` loads the actual four neural modules with strict state-dictionary
checks and calls the original HUGS `canon_forward`. It does not initialize SMPL,
fit a new person, or animate the result. Use the official extracted `lab` checkpoint
at `.runtime/hugs-checkpoint`, already downloaded in this experiment.

```powershell
$root = (Get-Location).Path
New-Item -ItemType Directory -Force .runtime/hugs-output | Out-Null
docker run --rm --gpus all --mount "type=bind,source=$root/.runtime/hugs-checkpoint,target=/checkpoint,readonly" --mount "type=bind,source=$root/.runtime/hugs-output,target=/output" --mount "type=bind,source=$root/services/avatar/src/avatar_service,target=/experiment,readonly" avatar-hugs:86ebe55 python /experiment/hugs_preview.py --checkpoint /checkpoint --output /output/canonical-preview
```

Output must be a new directory. It receives four 512×512 PNGs, `canonical.ply`,
and `report.json` only after the render and validation succeed. Run only trusted
checkpoints: the original format is serialized with pickle.

The first successful disposable probe on RTX 2060 rendered **531,701 Gaussians**,
using 1,192,294,400 bytes peak PyTorch allocated memory and 1,570,766,848 bytes
reserved (about **1.11 / 1.46 GiB**). These counters exclude the CUDA context and
allocations outside PyTorch. Four rasterization calls took 171/24/14/17 ms at
512×512; this includes a cold first call and is not an end-to-end animation FPS
benchmark. Total measured decode/export/four-view verification time was 10.29 s.
Images were visually checked from front and back; hair and clothing are visible,
with blur/artifacts in places. This is a pretrained author example, not the user.

The checkpoint produces signed scale components. The CUDA rasterizer forms
covariance `(S R)^T(S R)`, so signs cancel; PLY's log-scale representation requires
absolute magnitudes. The command checks signed/absolute-scale GPU image equivalence
in every view before publishing. It also zeros inactive SH coefficients and clamps
opacity to `[1e-6, 1-1e-6]` for finite PLY logits. This static PLY contains no live
deformation model and is not an animated avatar package.

## 4. Required assets and preflight for full evaluation/training

Use `.runtime/hugs-data` as the host data root. Follow the
[upstream instructions](https://github.com/apple/ml-hugs#preparing-the-datasets-and-models):

- Obtain `smpl/SMPL_NEUTRAL.pkl` from the official SMPL download after registration.
  Upstream also requests `smpl/smpl_uv.obj`; the pinned active code does not read
  the UV file, so preflight does not block on it.
- Put prepared NeuMan sequences in `neuman/dataset/<sequence>/`: `images`,
  `segmentations`, COLMAP ASCII `sparse/{cameras,images,points3D}.txt`,
  `4d_humans/smpl_optimized_aligned_scale.npz`, and
  `4d_humans/sam_segmentations/*.png`.
- For `lab`, obtain AMASS `SFU/0008/0008_ChaCha001_poses.npz` through the official
  AMASS site. The upstream trainer creates its animation dataset on initialization,
  including during training/evaluation. Other supported sequences have different
  required motion files, listed by preflight.
- Evaluation needs an author checkpoint directory with `config_train.yaml` and
  human weights. For `human_scene`, it also needs scene weights at that directory's
  root, as expected by the original evaluate script.

```powershell
.venv/Scripts/python.exe -m avatar_service.hugs_runtime --data .runtime/hugs-data --sequence lab
```

Missing files produce JSON diagnostics and exit code 2. Presence checks do not
validate calibration, pose alignment or file contents; the actual upstream loader
must still validate them. Arbitrary sequence names are rejected because the pinned
implementation contains sequence-specific animation/camera assumptions.

Official downloads were reachable on 2026-09-26 (HTTP HEAD 200):
[NeuMan data](https://docs-assets.developer.apple.com/ml-research/models/hugs/neuman_data.zip)
(4,513,980,377 bytes) and
[checkpoints](https://docs-assets.developer.apple.com/ml-research/models/hugs/hugs_pretrained_models.zip)
(2,195,828,803 bytes). They do not replace separately obtained SMPL/AMASS assets.
No user media is sent to these services.

## 5. Measured runs after assets are present

Create `.runtime/hugs-data` and `.runtime/hugs-output` before mounting. Run from
the project root; evaluation mounts a writable copy of the author's checkpoint
directory because upstream writes images, logs and metrics there.

```powershell
$root = (Get-Location).Path
docker run --rm --gpus all --mount "type=bind,source=$root/.runtime/hugs-data,target=/opt/hugs/data,readonly" --mount "type=bind,source=$root/.runtime/hugs-output,target=/output" --mount "type=bind,source=$root/services/avatar/src/avatar_service,target=/experiment,readonly" --mount "type=bind,source=$root/.runtime/hugs-checkpoint,target=/checkpoint" avatar-hugs:86ebe55 python /experiment/hugs_runtime.py --action evaluate --checkpoint /checkpoint --sequence lab --report /output/evaluate.json
docker run --rm --gpus all --mount "type=bind,source=$root/.runtime/hugs-data,target=/opt/hugs/data,readonly" --mount "type=bind,source=$root/.runtime/hugs-output,target=/output" --mount "type=bind,source=$root/services/avatar/src/avatar_service,target=/experiment,readonly" avatar-hugs:86ebe55 python /experiment/hugs_runtime.py --action train --sequence lab --steps 100 --report /output/train-smoke.json
```

The wrapper checks assets before loading CUDA and executes the upstream scripts.
The downloaded configuration uses the legacy `hugs_triplane` name; the wrapper
maps it to `hugs_trimlp` for the pinned loader. Neural module compatibility has
been checked by the canonical preview; full posed evaluation remains unverified.
Its report includes elapsed time and PyTorch peak allocated/reserved memory;
these counters exclude allocations outside PyTorch. Record `nvidia-smi` alongside
them for total process/device usage. The wrapper selects one upstream configuration with `--cfg_id 0` to avoid
repeating the same sequence six times. `--steps 100` limits only the main training
loop: upstream first performs **7,000 initialization optimization steps**. It is
not a 100-step total budget. The pinned release YAML uses 14,998 main steps
(the generic config has 30,000). Fewer main steps do not guarantee a lower
memory peak. Both training and evaluation also run animation in upstream code.

## Remaining work

1. Run full posed evaluation/animation once SMPL/AMASS are present;
   measure memory separately from the successful canonical preview.
2. Add mask generation, camera estimation and SMPL fitting for personal captures;
   validate their coordinate alignment before training.
3. Connect live body poses and room placement to the browser prototype below.
   A static PLY alone is insufficient.

## Browser experiment (2026-09-26)

The default web workspace now loads actual photographic HUGS/lab Gaussians and
articulates 24 joints using Spark 2.2.0 covariance linear blend skinning.
The old MPFB workspace is a separate tab (`?mode=mesh`). Local PLY/SPLAT import
is static; the UI disables skeletal controls for an unrigged file.

```powershell
./scripts/prepare-gaussian-demo.ps1
cd apps/web
npm run dev
```

Open http://127.0.0.1:5173. Demo assets are generated files, ignored by git.
Source package: `.runtime/hugs-output/browser-lab`; 531701 splats, approximately
27 MB total. Export command, from the root with the previously prepared inputs:

```powershell
$root = (Get-Location).Path
docker run --rm --gpus all --env PYTHONPATH=/opt/hugs:/service --mount "type=bind,source=$root/services/avatar/src,target=/service,readonly" --mount "type=bind,source=$root/.runtime/hugs-checkpoint,target=/checkpoint,readonly" --mount "type=bind,source=$root/.runtime/hugs-data,target=/data,readonly" --mount "type=bind,source=$root/.runtime/hugs-output,target=/output" avatar-hugs:86ebe55 python -m avatar_service.hugs_browser --checkpoint /checkpoint --preview-ply /output/canonical-cli/canonical.ply --predictions /data/neuman/dataset/lab/smpl_pred --output /output/browser-lab
```

Exporter refuses an existing output. Only use trusted checkpoints/NPZ predictions:
their upstream formats require pickle. Compact export supports SH degree zero.
The skeleton is estimated from ROMP SMPL24 predictions using inverse FK and
median rest joints. Top four learned weights retain mean 0.9985358 of weight mass
(minimum 0.6691286). Median-rig mean joint reconstruction error is 0.000468 m;
this checks observations, not equivalence to HUGS's fitted SMPL rig.
RGBA/quaternions are quantized. Fine features and extreme joint bends have visible
artifacts. This is an author-provided person, not a reconstructed user capture.

Spark needs `extSplats` on the mesh, `accumExtSplats` on the renderer, and
`covSplats` on both. Identity rest matrices plus `world * inverseCanonicalWorld`
avoid Spark's differing rest-matrix multiplication convention. Original splat order
is preserved so weight indices remain aligned. Browser SHA256 and array lengths
are verified before attaching a rig. Use hardware WebGL; Playwright's software
headless shell is too slow for this model. Windows tests use Chromium with D3D11.

See the [recorded plan](../../../docs/superpowers/plans/2026-09-25-gaussian-avatar-experiment.md)
and [research](../../../docs/research/2026-09-25-gaussian-human-video.md).
