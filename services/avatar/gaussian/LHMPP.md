# Multi-photo LHM++ experiment

This is the personal reconstruction experiment, separate from single-image
LHM-MINI. It is not yet the production upload worker. Follow the live execution
ledger in `docs/superpowers/plans/2026-09-28-lhmpp-personal-avatar.md`.

Source: `.tools/lhmpp-runtime`, upstream aigc3d/LHM-plusplus at
`906b5d9fb967ab42efb92f6fa55bf22cac86b653`.
Runtime: `D:/CodexData/MasterProject/lhmpp` (override `LHMPP_RUNTIME_DIR`).
Python environment: Docker volume `masterproject_avatar-lhmpp-env`.

Official PixelShuffle checkpoint was downloaded from ModelScope revision
`5f1c4274068e11b93721219618d36594b6087cb6`. Complete files were SHA256 verified:

- `models/LHMPP-700M-PixelShuffle/config.json`: 3103 bytes,
  `c365a99f917e21e42ef7ee1b7b15b71e4a76e815efeded095e4b5657b2bc8cee`.
- `models/LHMPP-700M-PixelShuffle/model.safetensors`: 5226465708 bytes,
  `aa0750e7632352c50421c0e041f1e543277ce73a3af7ff26e446399394cac21e`.

`priors-verified.json` records 39 verified files from the official LHMPP-Prior
bundle. Matching files from the older local LHM bundle are hard-linked. New
`dense_sample_points/1_160000.ply` and `voxel_grid/cano_1_volume.npz` are required;
the old LHM prior directory alone is insufficient. Prior files mount read-only.

Build and install (do not launch a second installer while one is active):

```powershell
docker compose --profile lhmpp build avatar-lhmpp
docker compose --profile lhmpp run -d --name avatar-lhmpp-setup avatar-lhmpp bash -c 'bash /experiment/setup-lhmpp.sh > /runtime/setup.log 2>&1'
docker inspect avatar-lhmpp-setup --format '{{.State.Status}} {{.State.ExitCode}}'
Get-Content D:/CodexData/MasterProject/lhmpp/setup.log -Tail 20
```

Only after successful base setup, install CUDA extensions:

```powershell
docker compose --profile lhmpp run --rm avatar-lhmpp bash /experiment/setup-lhmpp-extensions.sh
```

Prepare all 24 local photographs, explicitly selecting eight surrounding views
for the first reconstruction and retaining the other 16 for validation:

```powershell
docker compose --profile lhmpp run --rm avatar-lhmpp python -m avatar_service.lhmpp_capture --input /input --output /runtime/capture-24 --views cam18.jpg cam21.jpg cam00.jpg cam03.jpg cam06.jpg cam09.jpg cam12.jpg cam15.jpg
```

This runs local CPU person segmentation and writes masks, normalized images and
a manifest. Originals are never overwritten. Filename order is not camera
calibration. The image size is 504 x 840; subject cropping must be visually checked
before inference. The initial eight-view choice does not claim all 24 images have
already influenced the model.

Hardware: RTX 2060 6 GB, Turing. Official model memory budget is 8 GB. The upstream
point attention has a non-Flash fallback, but its dense attention matrices may
exceed available memory. A memory-efficient Turing attention adapter must be
numerically checked. The joint transformer also explicitly requests Flash-only
SDPA and needs a compatible backend selection. Neither an installed environment
nor a prepared capture constitutes an avatar.
