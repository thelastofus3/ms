# LHM photo reconstruction experiment

This is an isolated **single-image** LHM-MINI experiment, not yet the personal
photo generation API. Multiple uploaded photos are not fused by this model.
The web application still reports generation unavailable until inference and
animated export have been verified. The existing HUGS viewer is independent.

Prerequisites on this workstation:

- CUDA image `avatar-hugs:86ebe55` built by the HUGS experiment.
- Original LHM checkout in `.tools/lhm-runtime`, revision
  `4f88aaeb3629249fbbddb4d0784a06962d9e1338`.
- Official LHM-MINI and prior models in
  `D:/CodexData/MasterProject/lhm/pretrained_models`.
- Isolated Python environment in Compose volume `avatar-lhm-env`, mounted at
  `/runtime/env`. A Linux volume avoids slow metadata access on Windows binds.

Set `LHM_RUNTIME_DIR` to override the runtime directory. Keep large artifacts on
the data disk. Model terms and separate dependencies are in ../THIRD_PARTY.md.
The Python volume uses Docker's storage disk (approximately 5 GB); it is separate
from the large model files. An earlier partial `env` on D is preserved but unused.
Create the empty `.tools/lhm-runtime/pretrained_models` mountpoint before running
Compose (Docker cannot create it inside the read-only code mount).

From the repository root, the optional `lhm` profile provides GPU access:

```powershell
docker compose --profile lhm run --rm avatar-lhm python /experiment/lhm_smoke.py --help
```

Base setup and CUDA extensions must finish before actual inference. Run only one
installer at a time; logs from detached containers remain available with
`docker logs <container-name>`. `scripts/bootstrap-lhm.ps1` installs the base;
extensions can be installed through the same Compose service:

```powershell
docker compose --profile lhm run --rm avatar-lhm bash /experiment/setup-lhm-extensions.sh
```

Prepared author image probe (use a new output directory for every attempt):

```powershell
docker compose --profile lhm run --rm avatar-lhm python /experiment/lhm_smoke.py --image train_data/example_imgs/video_image_20240913__-videos_clips__-data__-326594731337_0.png --head-box 315,18,452,185 --output /runtime/output/smoke-01
```

The probe records stage, errors, time, and PyTorch GPU memory in `report.json`.
Only successful neural inference creates `canonical.ply` and `neural-output.pt`.
It currently uses mean body shape, a supplied head crop, a white-background
source, FP16 stages and no face super-resolution. These approximations are
recorded, and this command does not submit uploads or replace the browser demo.
