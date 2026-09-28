# Photographic animated avatar: research and next experiment

Date: 2026-09-28. Research only: no new avatar inference or training completed.

## Goal and current gap

Create the actual user's full-body photographic appearance, including clothes and
hair, from several photos or video; animate it in the Gaussian room in the browser.
The existing HUGS author-avatar demonstration proves part of the rendering path.
The personal photo intake does not yet reconstruct a person: generation remains
unavailable. The tracking specification drives an already created avatar; it does
not provide reconstruction data or a reconstruction algorithm.

## Compared released implementations

| Candidate | Actual input/output | Assessment for this application |
|---|---|---|
| [HumanSplat](https://github.com/humansplat/humansplat) | Single image to human Gaussians | Relevant representation, but not a released multi-photo fusion workflow. Complete reproducible inference and new-pose export were not established in this review. |
| [2K2K](https://github.com/SangHunHan92/2K2K) | Single 2K image plus OpenPose keypoints to depth/normals, point cloud, then Poisson mesh | Published checkpoint is downloadable. Useful static geometry baseline; separate fitting, rigging and skinning would be needed. A point-cloud PLY is not a Gaussian avatar package. |
| [LHM++](https://github.com/aigc3d/LHM-plusplus) | One or multiple pose-free images to animatable human representation | Best first multi-photo candidate following the ModelScope availability correction below. Test PixelShuffle raw GS quality and GPU compatibility before integration. |
| [GaussianAvatar](https://github.com/aipixel/GaussianAvatar) | A monocular video with masks, camera and body parameters to person-specific animatable Gaussians | Strong video alternative, with published own-video preparation instructions. Requires per-person optimization and a browser export adapter. |
| [HUGS](https://github.com/apple-aiml-research/ml-hugs) | Video to human/scene reconstruction | Keep the working viewer and author-checkpoint baseline. Personal training and capture preparation are not yet demonstrated in our application. |
| [Animatable Gaussians](https://github.com/lizhe00/AnimatableGaussians) | Calibrated multiview capture and body parameters | Higher-effort capture route; not a ready casual-photo upload backend. |

HumanSplat's [checkpoint issue](https://github.com/humansplat/humansplat/issues/12)
reports a missing inference checkpoint. This is evidence of reproducibility
uncertainty, not proof that all weights are unavailable. Its
[pose-transfer issue](https://github.com/humansplat/humansplat/issues/8) also does
not establish a completed animation workflow.

2K2K's [checkpoint release](https://github.com/SangHunHan92/2K2K/releases/tag/Checkpoint)
lists `ckpt_bg_mask.pth.tar`, 933159856 bytes. The release asset responded to a
download HEAD request. No 6 GB inference peak was established.

## Important correction: LHM++ GS weights are accessible

Earlier anonymous Hugging Face requests returned 401 for the two GS-export
variants. That was incorrectly generalized to overall unavailability.
The authors' [model registry](https://github.com/aigc3d/LHM-plusplus/blob/906b5d9fb967ab42efb92f6fa55bf22cac86b653/core/utils/model_card.py)
also maps these models to ModelScope. Anonymous listing and actual ranged weight
downloads succeeded there today.

| ModelScope model | Weight bytes | Published revision |
|---|---:|---|
| [Damo_XR_Lab/LHMPP-700M-PixelShuffle](https://modelscope.cn/models/Damo_XR_Lab/LHMPP-700M-PixelShuffle) | 5226465708 | `5f1c4274068e11b93721219618d36594b6087cb6` |
| [Damo_XR_Lab/LHMPP-700M-SMPLX-FREE](https://modelscope.cn/models/Damo_XR_Lab/LHMPP-700M-SMPLX-FREE) | 5229190116 | `f6dbf4305504d63c5efcf23015de6f3d7b1c96b4` |

Evidence: ModelScope repository API returned success; `model.safetensors` range
requests returned HTTP 206 with matching total lengths. The PixelShuffle
safetensors header parsed with 1523 tensors, including GS xyz, scaling, rotation,
opacity and SH output heads. A complete non-range config request returned 3103
bytes and parsed successfully. Earlier partial-range config parse errors were
resolved by reading the full file.

Published weight SHA256 values (not independently verified against a full download):

- PixelShuffle: `aa0750e7632352c50421c0e041f1e543277ce73a3af7ff26e446399394cac21e`
- SMPLX-FREE: `63cfc88d58b7197617f56112431325ea913896cc70c06af985e11d6e1a253973`

No full weight download or inference was performed. File size is not VRAM usage.
Source examined at commit `906b5d9fb967ab42efb92f6fa55bf22cac86b653`.
The original LHM-MINI experiment remains parked; it is a different, single-image
model. Do not assume its dependencies or priors satisfy LHM++ without validation.

## Integration and hardware constraints

The [GS exporter](https://github.com/aigc3d/LHM-plusplus/blob/906b5d9fb967ab42efb92f6fa55bf22cac86b653/scripts/inference/to_gs_ply.py)
supports canonical or single-pose PLY output. Its image-path selection is capped
at eight images. A larger upload must use explicit view selection rather than
silently taking the first eight files. Video can supply selected views; that is
sparse-view reconstruction, not learning every frame's clothing dynamics.

For browser animation, export the canonical Gaussians plus the model's deformation
data and reproduce its pose transform. Verify canonical and posed outputs against
the upstream renderer. Reusing our HUGS rig format without checking LHM++'s body
model and transformations could produce incorrect motion. Static PLY alone does
not carry the complete animation mechanism. Compare raw `gs_render` output,
because neural-refined frames need not match what a browser splat renderer shows.

The official LHM++ model registry budgets 8000 MB. Our RTX 2060 has 6 GB: runtime
feasibility is unverified. The checkpoint config enables flash attention; check
the exact executed attention backend before a full attempt.
[Upstream FlashAttention-2](https://github.com/Dao-AILab/flash-attention#nvidia-cuda-support)
does not directly support Turing in its main CUDA implementation. A compatible
attention fallback or separate Turing implementation must be validated; merely
adding RAM or CPU offload would not solve an unsupported kernel. A fallback may
also increase memory. No compatible fallback has been tested here.

For GaussianAvatar, [InstantAvatar preprocessing](https://github.com/tijiang13/InstantAvatar/blob/master/scripts/custom/process-sequence.sh)
provides OpenPose, SAM masks, ROMP and body refinement steps. GaussianAvatar's
[avatar model](https://github.com/aipixel/GaussianAvatar/blob/main/model/avatar_model.py)
has a first stage with pose-independent appearance and a second stage conditioned
on pose features. My implementation inference: stage one is a simpler candidate
for baking into a browser package. Stage two needs neural evaluation or an
explicitly approximate baked model; exporting one PLY cannot preserve it exactly.

## Proposed next experiment and acceptance criteria

1. Pin LHM++ separately, validate checkpoint/dependency compatibility and attention
   on the RTX 2060. Download PixelShuffle from the verified official mirror and
   verify the full hash. Keep the working HUGS environment isolated.
2. Use an author example first, then 4-8 informative full-body views of one person
   in the same clothes, covering front, back and sides. Record selected views.
   For video, sample informative sharp views rather than adjacent similar frames.
3. Produce actual raw Gaussian renders: canonical appearance, a rear/side view,
   and two unseen poses. Record peak GPU allocation/reservation, process VRAM,
   latency, settings and any failure. Try FP16/staged offload where valid; treat
   these as experiments, not a promise of fitting 6 GB.
4. Inspect face, hair, clothing, missing surfaces and deformation. Compare pure
   GS against neural-refined output. Reject a nominally successful export if its
   appearance does not meet the photographic objective.
5. Export canonical appearance and deformation to the browser; compare the same
   poses with upstream renders. Then connect the verified reconstruction runner
   to private upload jobs, progress, artifact storage and participant assignment.
6. If LHM++ fails on quality or compatibility, use GaussianAvatar own-video
   preprocessing/stage-one training as the next candidate, with HUGS retained as
   the viewer reference. If measured GPU limits are decisive, report the actual
   requirement before choosing a stronger reconstruction machine.

Success is a newly reconstructed person, visibly based on their supplied views,
animated in our room. A model download, demo screenshot, static PLY, or working
upload form alone is not completion. No production backend was switched by this
research update.
