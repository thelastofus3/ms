# Photographic Gaussian avatar in the browser

User instruction: implement the photographic, animatable direction and make the
result visible in the application, instead of another offline preview or MPFB figure.
Execution: inline, with tests and one independent review. No commits of the existing
mixed/untracked project. This plan is written before implementation.

## Design and success criteria

TripoSplat (https://github.com/VAST-AI-Research/TripoSplat) predicts static Gaussian
assets from a single image. Its published exporter contains no human skeleton or
skinning weights. It is not an animatable-human reconstruction pipeline by itself.
AniGS's repository still has no released animation code. Keep the already working
HUGS appearance and learned deformation weights as the first integration.

Deliver a default photographic workspace in the web app, showing actual decoded
HUGS Gaussians. Controls must rotate the view and articulate joints; a translated
or rotating static cloud does not count as skeletal animation. Keep MPFB available
as an explicitly separate legacy workspace. Allow importing an external PLY/SPLAT
(including TripoSplat output) but never claim an unrigged import can articulate.

Export a self-contained Gaussian package: compact splats in original order,
top-four learned bone indices/weights per splat, 24-joint hierarchy/rest positions,
canonical rest rotations, provenance and approximation metadata. The official lab
data contains posed SMPL24 joints and axis-angle rotations. Recover rest offsets by
inverse forward kinematics and aggregate across frames. This is an estimated rig
from published capture data; different fitted body shapes and four-weight reduction
prevent calling it exact HUGS/SMPL deformation. Quantify retained weights and FK
reconstruction error. No invented personal capture, no hidden SMPL substitute.

The browser uses Spark 2.2.0 with covariance linear-blend skinning if supported by
the installed release. Verify matrix order from code; do not assume Spark's rest
matrix convention equals HUGS. Use identity bind matrices and pass explicit
current-world * inverse-canonical-world transformations when required. Test rest
identity and articulated joint transforms independently. Keep numerical metadata
in documentation; show users only source and relevant approximation status.

## Tasks

1. Export and verify package.
   - Files: `services/avatar/src/avatar_service/gaussian_rig.py`,
     `hugs_browser.py`, `tests/test_gaussian_rig.py`.
   - RED: two-joint FK/inverse reconstruction, non-finite/bad hierarchy rejection,
     normalized top-four weights, bounded binary record sizes/order.
   - GREEN: exporter reuses original HUGS decoding, preserves splat order, records
     quantization/rig approximation and publishes output atomically.
   - Run on official lab checkpoint; validate finite output, byte lengths,
     normalized weights and source provenance. No licensed model download needed.
2. Browser Gaussian renderer and skeletal controls.
   - Files: `apps/web/src/gaussian/{rig,renderer}.ts`, tests and Spark dependency.
   - RED: canonical transform identity, bone rotation moves descendants, invalid
     package rejected. GREEN: renderer with cancellation/disposal and loading/error
     states, linear-blend skinning, orbit, explicit playback/pose controls.
3. Visible photographic workspace and integration checks.
   - Files: `apps/web/src/gaussian/Studio.tsx`, `main.tsx`, styles, browser tests,
     README and bootstrap command for locally generated demo assets.
   - Default entry opens the photographic workspace; MPFB is a separate tab.
   - Show real example by default, allow local Gaussian import, disable animation
     for unrigged imports. Never make photo-reference upload pretend to reconstruct.
   - Check build/unit suite, real browser load, articulated frame change, pause,
     mode switch and cleanup. Inspect actual screenshots.
   - Independent review; fix material findings and report remaining generation
     limits. Own-person reconstruction still needs actual capture and fitting;
     no claims that a static TripoSplat export solves human animation.

## Ledger

- Implemented and actually exported 531701-splat package; original order checked
  against decoded canonical positions. Browser default now uses true Gaussians
  with covariance skeletal deformation, local static import and separate MPFB tab.
- Inspected canonical and raised-arm browser screenshots; photographic clothing,
  hair and face visible, with approximation/blur artifacts. No personal capture
  or live camera input claimed. Full Python suite 60 passed/11 skipped; frontend
  unit suite 10 passed; build passed; browser suite 5 passed/1 skipped.
- Independent review completed: fixed generic exporter provenance and reject SH
  degree > 0; actual revised Docker export succeeded in browser-lab-verified.
- Spark covariance requires extended mesh/accumulator data. Software headless
  render was too slow; Chromium D3D11 renders real example successfully. Lifecycle
  regression revealed asynchronous sort/readback must drain before GPU disposal.

- Additional user request: create and install a local context-handoff plugin,
  save project state and a resume prompt under docs/handoff; record compose services
  without copying credentials. Validate plugin and installation, then update the
  handoff with the browser verification outcome. No chat export service required.

- Source review complete: TripoSplat has static PLY/SPLAT exporters; HUGS has
  learned 24-bone weights and published ROMP SMPL24 joints/poses in NeuMan data.
- Spark current npm release is 2.2.0; upstream supports covariance LBS in addition
  to DQS. Exact installed API will be inspected before integration.
