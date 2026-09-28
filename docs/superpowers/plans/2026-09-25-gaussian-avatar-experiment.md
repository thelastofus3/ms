# Gaussian Avatar Experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: executing-plans. Выполнение в текущей сессии, после записи плана, согласно прямому указанию пользователя.

**Goal:** Подготовить вход из видео или фотографий и воспроизводимый изолированный эксперимент HUGS на RTX 2060, сохранив MPFB.

**Architecture:** Отдельный CLI готовит набор кадров с контрольными суммами. HUGS работает в отдельном Linux/CUDA-контейнере; его подготовленные данные и SMPL не смешиваются с MPFB и фото-эталонами API. Готовые кадры явно маркируются как требующие масок, калибровки и SMPL-fitting.

**Tech Stack:** Python, Pillow, FFmpeg, Docker, PyTorch/CUDA, HUGS.

**Spec:** `docs/research/2026-09-25-gaussian-human-video.md`.

## Global Constraints

- Существующий MPFB и API skinned GLB сохраняются.
- Фото/видео не отправляются внешним сервисам.
- Не выдавать подготовку кадров за реконструкцию; не выдавать успешный импорт Python за GPU inference.
- SMPL получать по условиям владельца модели; не искать неофициальные копии.
- Зависимости HUGS изолированы от Python 3.13 сервиса.

## Review Focus

- Повторный output не уничтожает исходные данные.
- Повреждённые картинки и неудачный FFmpeg не оставляют успешный manifest.
- Пути с пробелами передаются без shell-интерполяции.
- Размер и количество кадров ограничены; EXIF-ориентация учитывается.
- Отсутствующая модель или GPU приводит к ясному блокеру, а не фиктивному успеху.

## Task 1: Capture CLI

Files: `services/avatar/src/avatar_service/capture.py`, `services/avatar/tests/test_capture.py`.

Interface: `prepare_capture(source: Path, output: Path, *, max_frames=120, max_side=1024, fps=2.0) -> dict`; `python -m avatar_service.capture SOURCE OUTPUT`.

- [x] RED: тесты набора фото, EXIF, повреждённых данных, повторного output и ограничений. Проверка `pytest services/avatar/tests/test_capture.py -q`.
- [x] GREEN: Pillow-normalization в JPEG, видео через FFmpeg с ограничением кадров, atomic directory publication, SHA256 manifest. Все аргументы subprocess — список.
- [x] Проверить настоящее видео, созданное FFmpeg; прочитать manifest и кадры.

## Task 2: HUGS runtime

Files: `services/avatar/gaussian/Dockerfile`, `services/avatar/gaussian/README.md`, `scripts/bootstrap-hugs.ps1`.

- [x] Зафиксировать HUGS revision, прочитать requirements/submodules и реальные точки запуска.
- [x] Bootstrap получает исходники в `.tools/hugs`, не изменяет существующий checkout с другой revision.
- [x] Собрать Linux/CUDA image с исходными версиями PyTorch и Python; проверить CUDA через Docker.
- [x] Проверить наличие SMPL и prepared dataset до запуска обучения; задокументировать команды исходного HUGS.
- [x] Если внешние модели недоступны, записать точную причину, не помечать inference выполненным.

## Task 3: Documentation and verification

- [x] README: команды для видео/фото, границы текущей реализации и необходимые следующие шаги.
- [x] Запустить тесты Capture и существующие быстрые проверки сервиса.
- [x] Один независимый review добавленных файлов, исправить существенные дефекты.

## Execution ledger

- Начало: пользователь явно просит записывать действия перед реализацией и выполнять. Повторное подтверждение не запрашивается.
- Ruling: не делать commit смешанного незакоммиченного проекта; изменения остаются в рабочем дереве, журнал сохраняется здесь. Цена: нет отдельной commit-границы эксперимента.

### Continuation 2026-09-26 (before code changes)

- Resume Tasks 1–3 inline; existing design and execution were explicitly requested in the conversation. Scope is the Gaussian experiment subsystem.
- Pre-flight: Task 1 produces a capture manifest; Task 2 must NOT treat that manifest as a prepared NeuMan dataset. Task 3 documents this boundary.
- Task 1 tests will check normalized image dimensions/orientation, checksums, non-destructive output, invalid limits, corrupt images and real FFmpeg success/failure. Run `.venv/Scripts/python.exe -m pytest services/avatar/tests/test_capture.py -q`; first expected missing module, then pass.
- Task 2 will pin the already downloaded HUGS commit `86ebe5522a384fc553f07f090b63a76dd4af8d33`, build the original Python/PyTorch/CUDA stack, exercise a CUDA operation, and report model/data prerequisites independently. Attempt inference only with the actual required files.
- Ruling: retain the current working tree and use this plan as the execution ledger instead of commit-based skill helpers because nearly the entire pre-existing project is untracked. Cost: review is file-based and changes are not isolated in commits.
- Task 3 runs the complete avatar Python suite and an independent review of only this experiment's files. No merge/push.
- Task 1: complete — 16 tests passed including real FFmpeg; full avatar suite 46 passed / 11 skipped before review.
- Task 2: preflight 7 tests passed. HUGS trainer unconditionally loads AMASS; include the exact per-sequence motion in prerequisites. SMPL UV is in README but not read by active pinned code, so it is recommended rather than a preflight blocker.
- Build recovery: original `.tools/hugs` submodule checkouts are incomplete. Preserve them and build from `.tools/hugs-runtime`. Inria simple-knn endpoint fails; exact gitlink commit fetched from `https://gitlab.com/shicheng402/simple-knn.git` and verified by Git. No model or dependency revision substituted.
- Before asset download: inspect official ZIP central directories with HTTP ranges, then fetch only lab data/checkpoint if supported. Store downloads under `.runtime`; never extract absolute or parent-traversal paths. This reduces disk/network use. SMPL/AMASS still require the user's official downloads.
- Official lab assets downloaded with HTTP Range and ZIP CRC verification: 1,423 NeuMan files (1,030,806,263 bytes uncompressed) and 4 checkpoint files (1,637,690,587 bytes uncompressed). Locations: `.runtime/hugs-data/neuman/dataset/lab`, `.runtime/hugs-checkpoint`. Source manifests saved beside files.
- Final review by independent agent: fixed repeated six-config training by forwarding `--cfg_id 0`; failing regression test observed, then passed. Fixed stale success report on missing assets; failing regression observed, then passed. Corrected training documentation: release has 14,998 steps and 7,000 initialization steps precede the requested loop.
- Final Python verification so far: 48 passed / 11 skipped; skips require PostgreSQL/Blender opt-in. Ruff clean. CUDA image compilation still in progress; no inference claimed.

### Additional probe before declaring model-blocked (2026-09-26)

The public human checkpoint contains canonical xyz and all decoder weights. Test the upstream `HUGS_TRIMLP.canon_forward` independently of SMPL initialization: load the actual four neural modules, call the original method on a small holder, render canonical outputs through upstream renderer, save PNGs and static PLY under `.runtime/hugs-output`. This is a disposable feasibility probe (`.runtime/hugs-canonical-probe.py`), not an animation implementation. No SMPL is synthesized or substituted. Assert finite values and positive Gaussian scales; do not silently clamp invalid geometry. Measure CUDA memory/time. If it works, report exactly canonical pretrained appearance, not reconstruction/training or new-pose inference. This extends Task 2 while licensed model inputs remain missing.
- Checkpoint config has legacy `human.name=hugs_triplane`; the wrapper translates it to current `hugs_trimlp` (regression test RED then GREEN). Full weight compatibility still needs execution.
- Canonical probe loaded all four neural module state dictionaries strictly, but rejected negative scales before export. Source inspection shows CUDA computes Sigma=(S*R)^T*(S*R), so scale signs cancel. Next probe uses absolute scales ONLY for PLY and compares GPU images from signed vs absolute scales (atol=1e-6, rtol=1e-5). Zero scales remain an error. This is a documented covariance-preserving conversion, not geometry clamping.

### Reusable canonical preview (plan before implementation)

The disposable probe succeeded: 531,701 Gaussians, four 512px views, strict checkpoint module loading, signed/absolute scale rendering equivalent. Preserve this useful capability as `avatar_service.hugs_preview`, a local CLI run inside the isolated image with explicit checkpoint/output paths. It must reject missing model files and existing output before loading torch; publish PNG/PLY/report only after finite-value and actual GPU image-equivalence checks. Add host tests for those rejection paths and CLI help, watch them fail first, then verify the real CLI against the official lab checkpoint in Docker. It remains a canonical preview, not personal reconstruction or animation. This is part of the user-authorized HUGS implementation; no API/browser changes are implied.


## Final verified state ? 2026-09-26

- Tasks 1?3 complete for the recorded experiment scope: capture preparation, isolated runtime, diagnostics, documentation and independent review. This does NOT mean personal avatar reconstruction or animation is complete.
- Docker build exited 0; image `avatar-hugs:86ebe55`, manifest list `sha256:e5e41a1375281ae727aa55458fcd6eb585c1cb9c2e8f450fb55dccb9b068b3cf`. Actual CUDA simple-knn, PyTorch3D KNN and Gaussian rasterization passed on RTX 2060, PyTorch 1.13.1+cu117. Log: `.runtime/hugs-gpu-probe.log`.
- Reusable `avatar_service.hugs_preview` verified in Docker using the official lab checkpoint. Four 512?512 views and static Gaussian PLY at `.runtime/hugs-output/canonical-cli`. Report status `canonical_checkpoint_rendered`, animation=false, personal_reconstruction=false. 531,701 Gaussians; peak PyTorch allocated 1,192,294,400 bytes, reserved 1,570,766,848 bytes. CUDA context/external allocations are not included. Total measured runtime 8.65 s; this is not application FPS.
- Final PLY independently read: 531,701 vertices, 62 fields, every float finite, normalized quaternions, inactive SH zero, 131,863,379 bytes. Four images verified as 512?512 and visually inspected (front/back/side). Blur and local reconstruction artifacts remain visible in the author example.
- GPU comparison of signed vs absolute scales passed for all four views. PLY conversion uses covariance-equivalent absolute scales and a documented opacity boundary clamp. This choice is verified for the canonical renderer; browser equivalence remains untested.
- Additional independent review of reusable preview: no material findings; host tests 3/3 passed. Final complete avatar suite: **52 passed, 11 skipped** (7 PostgreSQL integration, 4 Blender/MPFB); Ruff clean. Logs: `.runtime/gaussian-python-final.log`, `.runtime/hugs-preview-cli.log`, `.runtime/hugs-artifact-check.log`.
- Missing for full upstream evaluation/animation: `.runtime/hugs-data/smpl/SMPL_NEUTRAL.pkl` and `.runtime/hugs-data/SFU/0008/0008_ChaCha001_poses.npz`. Diagnostic saved in `.runtime/hugs-preflight.json`. User was asked for local paths while independent work continued; no files were supplied in this session.
- Remaining user objective: real capture mask/camera/SMPL fitting and dataset adaptation, reconstruction/training of their person, new-pose evaluation, and browser deformation/room integration. No full avatar animation, personal reconstruction, training VRAM, or room rendering is claimed.
- No commits or merges: preserve the pre-existing mixed/untracked worktree. No review findings deferred.
