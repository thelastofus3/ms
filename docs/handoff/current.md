# MasterProject handoff — 2026-09-26

## Latest research correction - 2026-09-28

Read `docs/research/2026-09-28-photographic-avatar-options.md` before choosing
the next reconstruction experiment. HumanSplat and 2K2K were reviewed alongside
video methods. LHM++ PixelShuffle and SMPLX-FREE Gaussian-export weights ARE
accessible anonymously on the official ModelScope mirror, despite Hugging Face
returning 401. Actual ranged weight downloads and the PixelShuffle safetensors
header were checked; full config JSON parsed. No inference was run.

Recommended next candidate: LHM++ PixelShuffle with several photos, checking
raw Gaussian quality, RTX 2060 attention compatibility and VRAM before browser
deformation export. Official memory budget is 8 GB; 6 GB operation is unverified.
GaussianAvatar own-video processing is the fallback. This changes the proposed
experiment order below, not the product goal. Original single-image LHM-MINI
remains parked. The working HUGS author demo remains the rendering baseline.
Do not resume historical LHM-MINI setup or claim personal generation is ready.

## Priority correction ? earlier user steering

The user reiterated that the goal is reconstruction from a COLLECTION of photos
or a video, not a single-image avatar. Follow the new current specification:
`docs/superpowers/specs/2026-09-27-photographic-avatar-design.md`.
Park LHM-MINI as a single-image experiment. Do not spend the next continuation
finishing its setup as if that fulfilled the requested multiframe reconstruction.
Next main test: train HUGS on the available reference sequence (not load its
finished author checkpoint), measure GPU memory/quality, then implement actual
personal capture masks/camera/body fitting and integrate the verified job pipeline.
The linked tracking design concerns driving the completed avatar, not creating it.
Old MPFB-first specifications now carry explicit supersession notices.

Latest runtime facts: prior archive recovery verified 70 files with SHA256 in
D:/CodexData/MasterProject/lhm/prior-verified.json. LHM base dependencies installed
in Docker volume masterproject_avatar-lhm-env (mounted /runtime/env), not the
preserved partial D:/.../env. setup-linux.log records completion; extensions did
NOT run because the scratch recovery script's last command had a CRLF suffix.
No LHM inference occurred. Docker Linux daemon was unavailable at the last check.
Compose now has optional lhm profile and scripts/bootstrap-lhm.ps1 uses it.
Do not treat an old running-container claim below as current. New single-image
probe instructions: services/avatar/gaussian/LHM.md. Photo API tests most recently
passed 3/3; the service was healthy before Docker became unavailable.

## Latest user request and current result

2026-09-27 continuation: original LHM-MINI investigation is ACTIVE. Code cloned
in `.tools/lhm-runtime` at 4f88aaeb3629249fbbddb4d0784a06962d9e1338. Model weights
2775668536 bytes and official prior TAR 18818365440 bytes fully downloaded to
`D:/CodexData/MasterProject/lhm` (C only ~10 GB free, D had ~252 GB).
Prior extraction and isolated Python3.10/PyTorch2.3cu118 setup are in progress.
Original setup container `cf0e563bf145` kept running after PowerShell stderr
handling failed; duplicate `68280318b40a` was explicitly stopped. Check docker ps
and docker logs, not the early failed shell session. Environment lives on D bind
mount /runtime/env. Scripts: scripts/bootstrap-lhm.ps1,
services/avatar/gaussian/setup-lhm.sh and setup-lhm-extensions.sh. The latter
must run AFTER base deps succeed; compiles pinned PyTorch3D/rasterizer/simple-knn.
No system Python or working HUGS environment was modified.

`services/avatar/gaussian/lhm_smoke.py` is an UNVERIFIED isolated real-neural probe:
mean body shape, supplied head crop, white-background input, face SR disabled,
FP16 and stagewise CPU offload. First source image selected and visually inspected:
train_data/example_imgs/video_image_20240913__-videos_clips__-data__-326594731337_0.png
(full-body person on white), head box 315,18,452,185. Do not use cartoon 7.JPG.
Next: finish deps/extraction, run probe in /opt/lhm with pretrained_models mounted
from D, inspect actual PLY and memory, then implement proper personal pipeline and
animated browser export only if real inference succeeds. Current web generation
is STILL unavailable. LHM-MINI original is single-image, not multi-view fusion.

User approved the visual example, requested removal of the skeletal prototype
from app capabilities, and personal photo-to-avatar generation. New plan:
`docs/superpowers/plans/2026-09-26-personal-photo-avatar.md`.
Public main now renders only GaussianStudio; `?mode=mesh` no longer opens MPFB.
Archived UI source `apps/web/src/avatar/LegacyStudio.tsx` has no public entry.
Retired studio.spec.ts excluded from active browser suite; underlying unit/API
tests remain. Do not bring MPFB back into navigation or call it an app capability.

Implemented real personal photo intake, previews/history/delete in Photos.tsx;
`photo_api.py` provides private session-owned normalized captures in a Docker
volume. `compose.yaml` now ALSO has `avatar-photos` (loopback 8002), built with
Dockerfile.photos. It is running; restart with `docker compose up -d --build
avatar-photos`. Vite 5173 proxies /v1/photo-captures to it. Cookie ownership is a
local MVP, not platform accounts. EXIF/GPS removed. Up to 32 photos, 10 MB each,
24 MP, 100 MB total. Capture deletion available. Service rejects missing upload
Content-Length and envelopes exceeding 101 MiB before multipart parsing.

CRITICAL: Requested automatic personal reconstruction is STILL UNFINISHED.
Photo sets are photos_ready, not avatars. UI discloses unavailable generation;
POST generate returns 503, no fake queue/progress/demo substitution.
Verified again: 3DAIGC/LHMPP-700M-PixelShuffle and SMPLX-FREE config.json HEAD401;
ordinary LHMPP-700M HEAD200 but current exporter only accepts the former models.
Upstream README says PixelShuffle weights pending. Existing HUGS also needs
cameras/masks/SMPL fitting. Next meaningful work is a runnable personal
reconstruction backend, not another upload UI or changing the demo's label.

Independent review found first-load cookie/list race. Added failing browser test
with delayed initial GET; upload now disabled until session/list initialized,
retry on connection error and abort stale initialization on unmount. Tests and
final verification results are in the latest plan ledger. No user photos supplied;
integration tests use a generated 1-pixel image and delete their capture.

## Objective and constraints

User wants a photographic, animatable human reconstructed from video or many
photos, displayed alongside a realistic Gaussian room in the browser. They reject
the old MPFB figure as the final result. Record plans before implementation and
continue autonomously. RTX 2060 has 6 GB VRAM; measure before rejecting methods.
Latest request also installs a context-transfer plugin. Do not commit/reset the
mixed existing tree: most application files are untracked user work.

## Completed and artifacts

- HUGS pinned at 86ebe5522a384fc553f07f090b63a76dd4af8d33 in `.tools/hugs-runtime`.
  Docker image `avatar-hugs:86ebe55` runs CUDA on this GPU.
- Official lab checkpoint `.runtime/hugs-checkpoint`; lab capture data
  `.runtime/hugs-data/neuman/dataset/lab`. Canonical photographic appearance decoded
  from real networks without licensed SMPL initialization. No personal capture used.
- `.runtime/hugs-output/canonical-cli`: PLY and four real rendered views, report.
  531701 Gaussians. Torch peak allocated 1.11 GiB, reserved 1.46 GiB, excluding
  CUDA context/external allocations. Training memory has not been measured.
- Browser package `.runtime/hugs-output/browser-lab`: compact avatar.splat,
  indices.bin, weights.bin, manifest.json. Copied into ignored
  `apps/web/public/gaussian-demo` by `scripts/prepare-gaussian-demo.ps1`.
- `hugs_browser.py` decodes learned weights and estimates rest skeleton from
  official ROMP joints. Top four weights retain mean 0.9985358; this is approximate
  skinning, not full original HUGS deformation with fitted SMPL body shape.
- New GaussianRig math, Spark 2.2.0 covariance LBS renderer and default photographic
  workspace implemented. Legacy workspace accessible via `?mode=mesh` and tab.
  Actual canonical and raised-arm browser screenshots inspected. Face, clothes,
  hair are photographic, with visible blur/artifacts around bends.
- Browser build and 10 frontend unit tests passed. Full Python suite: 60 passed,
  11 skipped. Full browser suite: 5 passed, 1 skipped (live API/worker test).
  Enhanced pause/import/reload regression added afterward; final result recorded
  below. Screenshot `.runtime/gaussian-browser.png` is the actual UI, not a mockup.
- Independent review found hardcoded lab provenance and missing higher-SH rejection
  in reusable exporter. Fixed metadata to operator-supplied source with checkpoint
  SHA256 and sequence name, and reject nonzero SH degree. Reran real Docker export
  successfully into `.runtime/hugs-output/browser-lab-verified`. Existing browser
  demo remains the known official lab package; no user capture implied.

## Remaining work / immediate next action

1. Continue personal-capture pipeline from the working browser example; first
   inspect current validation results and the user's available video/photos.
2. Improve deformation quality and compare with original HUGS posed output once
   licensed assets are available. Do not call approximate browser rig exact SMPL.
3. Personal reconstruction remains unfinished: need actual user's capture,
   cameras/masks/body fitting and training. SMPL model and AMASS unavailable locally;
   full original HUGS motion path still requires them. Never describe demo as user.
4. Real-time camera pose input and placement into the room remain further work.

## Plans and source files

- `docs/superpowers/plans/2026-09-26-photographic-avatar-browser.md`
- `docs/superpowers/plans/2026-09-25-gaussian-avatar-experiment.md`
- `services/avatar/gaussian/README.md`, `services/avatar/README.md`
- `services/avatar/src/avatar_service/{hugs_preview,hugs_browser,gaussian_rig}.py`
- `apps/web/src/gaussian/{rig,renderer}.ts`, `Studio.tsx`
- `apps/web/tests/gaussian.spec.ts`

## Local commands and services

Root is `C:/Users/aleks/IdeaProjects/MasterProject`. PowerShell. Python executable
is `.venv/Scripts/python.exe`; plain `python` is a broken Windows alias.

```powershell
./scripts/prepare-gaussian-demo.ps1
cd apps/web
npm run dev
# http://127.0.0.1:5173
npm run build
npm test
npx playwright test
```

`compose.yaml` defines only PostgreSQL service `avatar-db`, image postgres:17-alpine,
loopback port 55432, persistent named volume and healthcheck. Use
`docker compose up -d avatar-db` for legacy API work. Gaussian example needs no DB,
API or running training container. Recheck running processes; do not assume a
development server survives a chat change.

## Context plugin

Final enhanced Gaussian browser test passed (8.0 s): actual pose change, stable
paused frame, changed resumed frame, static import disables motion, demo reload,
legacy switch and absence of console/page errors. Spark disposal now stops sort
scheduling and drains in-flight sorting before releasing GPU targets. Windows
Playwright uses full Chromium/D3D11 rather than software headless shell.

Local `context-handoff` plugin created at `C:/Users/aleks/plugins/context-handoff`,
registered in `C:/Users/aleks/.agents/plugins/marketplace.json` (personal), installed
through `codex plugin add context-handoff@personal`. Plugin and skill validators
passed. New threads pick up installed skills. It saves factual files, not a full
conversation export. No cloud service, credentials or external messaging involved.

## Research decisions

TripoSplat official repository exports static PLY/SPLAT without a human skeleton.
Current browser supports such static imports but disables joint controls for them.
HUGS has actual learned human weights and already-tested appearance on this GPU.
Spark's matrix convention requires identity rest matrices plus explicit
current-world * inverse-canonical-world transforms. Preserve splat ordering when
exporting compact records: weights index the same Gaussian array.
