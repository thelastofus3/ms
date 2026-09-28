# Personal photo avatar

User wants the photographic workspace to become the product, with no visible
MPFB capability, and people to upload photos to create their own avatar.
Implementation is authorized; record work before editing, preserve existing files.

Architecture: retain the working Gaussian viewer; remove public legacy navigation
and query-string entry. Add a separate photo intake API, persistent private capture
storage and browser upload/history/delete flow, deployed through compose. Local
browser sessions own captures through an HttpOnly cookie. This is a local MVP,
not cross-device account authentication. Never expose other sessions' photos.

Reconstruction prerequisite: current HUGS input normalization does NOT recover
cameras, masks and SMPL poses. LHM++ advertises multi-photo reconstruction but
the published export path's model availability must be checked before integration.
Do not fake an avatar from demo data or call uploaded photos a completed avatar.
If a real engine is unavailable, persist validated photos with an explicit
awaiting-engine status, expose the precise reason, and record generation as
unfinished. No simulated progress or success.

1. Test removal of legacy UI and the intake API (real image decode, invalid input,
   size/count limits, session isolation, persistence, deletion, engine unavailable).
2. Implement bounded uploads with EXIF normalization/metadata removal, atomic
   publication, private access and no client-controlled disk paths. Docker service
   on loopback; Vite proxy routes intake independently from legacy service.
3. Add photo selection/previews, capture guidance, upload state, saved sets and
   deletion. Keep model example explicitly labeled. Photos never leave local API.
4. Verify accessible reconstruction weights/assets. Integrate only if runnable;
   otherwise document measured blocking prerequisites and keep generation visibly
   unavailable, not queued for a nonexistent worker.
5. Run backend/frontend/browser checks and actual compose upload smoke test.
   Independent final review, docs and context handoff update.

## Ledger

- User steering 2026-09-27: refocus on reconstruction from a photo collection or
  video. Single-image LHM installation has consumed too much effort without
  satisfying that requirement. See the new 2026-09-27-photographic-avatar-design
  specification: next main experiment is training HUGS from reference frames,
  followed by real personal-capture fitting. Park further LHM work; preserve it.
  At this check Docker's Linux daemon is unavailable. Persisted setup-linux.log
  proves base LHM dependencies installed, but extensions did not run because a
  scratch recovery shell command ended in CRLF. No LHM inference was executed.

- Ruling: use a named Linux volume for the Python environment, keeping weights
  on D. Windows bind-mount metadata overhead makes installs/builds very slow.
  C has 11.4 GB free; expected environment ~5 GB. Preserve the partial D env.
  Reuse already downloaded wheels and keep build scratch inside the container.

- Recovery 2026-09-27: previous setup/extraction processes disappeared. Torch
  import fails because libtorch_global_deps.so is missing (interrupted install).
  Resume dependencies in a named container with a persistent log; verify/extract
  official prior files from the existing archive, excluding unused .git copies.
  Restart photo service, then run the real inference probe before enabling jobs.
  CUDA extension checkout must initialize the pinned repository's submodules.
- Recovery evidence: 70 prior files checked against the archive with SHA256;
  `prior-verified.json` saved on D. PyTorch 2.3.0+cu118 now imports and executes
  a CUDA matrix product on RTX 2060 (sum 32768). Photo service healthy again,
  photo API tests 3/3 pass. Compose lhm profile validates and executes CLI help.
  Base dependencies still installing. Disable build isolation for BasicSR after
  installing its build prerequisites: otherwise it fetches a second unpinned
  torch into a temporary build environment. Preserve LF for Linux shell scripts.
  LHM MINI needs writable dense_sample_points cache (1_20000.ply absent from
  official archive); other mounted prior models and source are read-only.

- LHM-MINI weights published (model.safetensors 2775668536 bytes); official prior
  TAR Content-Length 18818365440. C has only ~10 GB free; D ~252 GB. New runtime
  artifacts go to D:/CodexData/MasterProject/lhm, without deleting existing data.
  Reuse existing CUDA base and bind-mounted dependencies to avoid filling C with
  another full CUDA image. Upstream memory estimate 14–16 GB is not a measured
  refusal on this 6 GB GPU; assess staged/offloaded inference before conclusion.

- Intake implemented, composed and browser-tested. Final checks: 63 Python passed,
  11 skipped; 10 frontend units; 2 active browser tests; production build passed.
  Legacy UI removed from public entry, source preserved in avatar/LegacyStudio.
- Final review found initialization-cookie race; delayed-initial-GET test failed
  before fix, passed after serializing initialization and upload. Retry and abort
  stale initialization added. Multipart envelope rejects >101 MiB before parsing.
- 2026-09-27 continuation: inspect original LHM-MINI as a runnable alternative to
  LHM++ GS checkpoints. Clone pinned 4f88aaeb3629249fbbddb4d0784a06962d9e1338 in
  .tools/lhm-runtime. Before dependency/model downloads, check storage and required
  model sizes, then build isolated inference environment if resources permit.
  Test author input first; do not mark generation available until actual photo
  reconstruction and browser-compatible animated export both succeed.

- Official LHM++ README currently says PixelShuffle hub weights pending and
  recommends a local checkpoint; plain LHMPP weights are not interchangeable with
  the two models accepted by its Gaussian exporter. Rechecking access.
