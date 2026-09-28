# LHM++ personal avatar implementation plan

> Execute inline using executing-plans. User requested implementation of the
> preceding research proposal and supplied dataset/cam00.jpg through cam23.jpg.

**Goal:** Reconstruct this supplied person from multiple photos, inspect raw
Gaussian appearance and new poses, and deliver a browser animation if the model
passes hardware and quality checks.

**Architecture:** Isolated pinned LHM++ runtime and official PixelShuffle weights;
explicit selected-view manifest; canonical and posed Gaussian outputs followed
by a deformation adapter into the existing Gaussian viewer. Do not enable the
personal generation API until inference and artifacts are actually verified.

**Tech stack:** Python, PyTorch/CUDA in Docker, LHM++, existing Spark viewer.

**Spec:** ../specs/2026-09-27-photographic-avatar-design.md
**Approved candidate update:** ../../research/2026-09-28-photographic-avatar-options.md

## Global constraints

- Preserve all 24 original photographs. Keep personal inputs/artifacts local.
- Use multiple views; record selected and excluded images explicitly.
- Isolate dependencies from the working HUGS runtime and parked LHM-MINI.
- Measure memory; report kernel incompatibility/OOM instead of fabricating output.
- No existing author avatar may be presented as reconstruction of this person.
- Preserve unrelated uncommitted files and staged IDE changes; no bulk commit.

## Task 1: Reproducible runtime and supplied capture inspection

Files: `.tools/lhmpp-runtime` (pinned upstream), runtime assets on D,
`services/avatar/gaussian/LHMPP.md`, optional `compose.yaml` lhmpp service.

- [ ] Inspect input dimensions and representative images; identify usable views.
- [ ] Pin upstream 906b5d9fb967ab42efb92f6fa55bf22cac86b653 and inspect executed
  inference dependencies, attention fallback and deformation representation.
- [ ] Download official PixelShuffle checkpoint and verify SHA256 against research.
- [ ] Start Docker and build an isolated environment; run small CUDA/attention
  probes before expensive full inference. Expected: compatible kernels, or an
  exact recorded blocking exception.

## Task 2: Multiview reconstruction experiment

Files: isolated runtime experiment scripts, input manifest and report under D.
Consumes: validated checkpoint, local selected images, compatible environment.
Produces: actual canonical/posed GS artifacts and measured execution report.

- [ ] Record the selected photo names and preprocessing; use up to eight distinct
  views initially because upstream export currently caps image selection at eight.
- [ ] Run upstream-compatible inference with validated low-memory changes only.
- [ ] Inspect raw GS output and compare against source photos and withheld views.
- [ ] Render two new poses and report identity/clothing/deformation limitations.

## Task 3: Verified browser delivery

Consumes: successful Task 2 artifacts and actual upstream deformation semantics.
Files: focused exporter and tests in services/avatar; existing Gaussian viewer.

- [ ] Write failing numerical tests for deformation/export coordinate transforms
  before implementing the adapter. Test canonical and nonidentity joint poses.
- [ ] Export the reconstructed person with deformation data, verify parity against
  upstream posed positions/covariances, then run relevant Python/browser tests.
- [ ] Inspect the actual person in the browser and record screenshot and limits.
- [ ] Update README/handoff with reproducible commands and measured result.

## Review focus

Input ordering must not pretend to infer camera angles; no silent first-image
fallback; checkpoints must be validated; static PLY must not imply animation;
inference failure must not replace the demo or expose a false successful job.

## Execution ledger

- Located and inspected 24 input JPEGs, each 1330 x 1150. Eight surrounding views
  selected explicitly; front cam18, back cam06, sides cam00/cam12.
- Original Docker image/volume inventory was empty after startup. Built new
  avatar-lhmpp:cu121; verified RTX 2060 visibility. Base setup runs detached as
  avatar-lhmpp-setup with /runtime/setup.log.
- Complete PixelShuffle config and 5,226,465,708-byte checkpoint hash verified.
  39 required prior files hash verified, 37 reused by hard link and two downloaded.
- Capture preparation RED: missing lhmpp_capture module. GREEN: five tests passed;
  full avatar Python suite: 68 passed, 11 skipped. Actual segmentation pending setup.
- Packed attention RED: missing lhmpp_attention module in the CUDA environment.
  GREEN: independent sequence reference parity and sequence-isolation check on
  RTX 2060 passed. Large 163840-token/4096-window probe: finite output, 0.17 seconds,
  130 MiB peak torch allocation. These are kernel measurements, not full inference.
- Adaptation ruling: use xformers block-diagonal attention with identical packing
  instead of materializing the fallback's huge attention matrix. Joint attention
  must allow efficient SDPA on Turing. Model appearance quality still untested.

- Preflight: Task 2 consumes Task 1's actual kernel/checkpoint result. Task 3 is
  conditional on verified artifacts, not on installation completing.
- Existing spec's HUGS-first experiment order is superseded by the user's approved
  LHM++ research proposal; photographic multi-observation goal is unchanged.

- 2026-09-28 resumed for fastest concrete reconstruction result. Three CUDA
  extensions had built successfully; final import check failed because torch was
  not imported first. Corrected setup check and verified all imports on RTX 2060.
- First inference exposed upstream train()/eval() returning None; separated model
  construction from eval(). Second inference loaded the checkpoint without key
  mismatches and encoded all eight selected photos, then failed in spconv implicit
  GEMM at 2,727,751,680 peak allocated bytes. No avatar output from this attempt.
- FP32 native sparse convolution matches implicit FP32 reference (max absolute
  difference 2.86e-6 on 32,768 points). Added adapter preserving feature dtype;
  actual GPU adapter comparison passed. FP16 native parity was insufficient at
  strict tolerance, so accumulation stays FP32. Third eight-view run started.
- Fresh existing Python suite: 68 passed, 11 skipped (9.30 seconds).
