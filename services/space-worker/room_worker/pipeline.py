import json
import re
import shutil
import time
from pathlib import Path
from .commands import run
from .preprocess import prepare
from .geometry import select_room_model, sanitize_camera_depths, build_collision
from .export import compress, digest
from .settings import PROFILES, training_schedule

PIPELINE_REVISION = "video-overlap-shared-intrinsics-parallax-v2"


def reconstruct(job, storage, work: Path, lease):
    profile = PROFILES[job["profile"]]
    started = time.monotonic()
    report = {"profile": profile, "pipelineRevision": PIPELINE_REVISION,
              "tools": {"nerfstudio": "1.1.5", "gsplat": "1.4.0", "colmap": "3.9.1", "pycolmap": "3.11.1"}}
    # Checkpoints are attempt-local and written only after the full stage succeeds.
    # Retries can recover immutable preprocessing/pose artifacts from earlier attempts.
    import hashlib
    fingerprint = hashlib.sha256(json.dumps({"media": job["media"], "profile": profile, "tools": report["tools"],
                                            "pipelineRevision": PIPELINE_REVISION}, sort_keys=True).encode()).hexdigest()
    previous = []
    for marker in sorted(work.parent.glob("*/checkpoint.json"), key=lambda path: path.stat().st_mtime):
        try:
            data = json.loads(marker.read_text())
            if data["fingerprint"] == fingerprint:
                previous.append((data, marker.parent))
        except (OSError, ValueError, KeyError):
            pass
    def recover(stage, directory):
        for checkpoint, root in reversed(previous):
            if checkpoint.get("stage") not in (["poses", "geometry", "export"] if stage == "poses" else ["geometry", "export"]):
                continue
            candidate = root / directory
            files = checkpoint.get("files", {}).get(directory, {})
            if files and all((candidate / name).is_file() and digest(candidate / name) == sha for name, sha in files.items()):
                lease.check()
                shutil.copytree(candidate, work / directory)
                return checkpoint["report"]
        return None
    def checkpoint(stage, directories):
        lease.check()
        paths = [(name, path) for name in directories for path in (work/name).rglob("*") if path.is_file()]
        total_bytes = sum(path.stat().st_size for _, path in paths)
        hashed = 0
        def hashing_progress(size):
            nonlocal hashed
            hashed += size
            lease.progress("Save checkpoint", "Hashing reconstruction checkpoint", hashed, total_bytes, "bytes verified")
        lease.progress("Save checkpoint", "Hashing reconstruction checkpoint", 0, total_bytes, "bytes verified", force=True)
        files = {name: {} for name in directories}
        for name, path in paths:
            files[name][str(path.relative_to(work/name))] = digest(path, hashing_progress)
        temp = work / "checkpoint.tmp"
        temp.write_text(json.dumps({"fingerprint": fingerprint, "stage": stage, "files": files, "report": report}))
        temp.replace(work / "checkpoint.json")
    lease.stage("preprocessing", 0)
    recovered = recover("poses", "dataset")
    if recovered:
        report.update(recovered)
        dataset = work / "dataset"
    else:
        dataset, capture = prepare(job["media"], storage, work, profile, lease)
        report["capture"] = capture
        lease.stage("poses", 0)
        colmap = dataset / "colmap"
        sparse = colmap / "sparse"
        sparse.mkdir(parents=True)
        database = colmap / "database.db"
        run(["colmap", "feature_extractor", "--database_path", database, "--image_path", dataset/"images",
             "--ImageReader.camera_model", "SIMPLE_RADIAL", "--ImageReader.single_camera", "1" if capture["video"] else "0",
             "--SiftExtraction.use_gpu", "1", "--SiftExtraction.max_num_features", "8192"], work, lease)
        images = sorted((dataset/"images").glob("*.jpg"))
        # Nearby video pairs plus distributed revisit pairs; photos use all pairs.
        pairs = work / "pairs.txt"
        video = report["capture"]["video"]
        report["capture"]["intrinsicsPolicy"] = "shared-video-lens" if video else "per-photo"
        pairs.write_text("\n".join(f"{a.name} {b.name}" for i, a in enumerate(images) for j, b in enumerate(images)
                                    if j > i and (not video or j-i <= 12 or i%12 == 0 or j%12 == 0)))
        run(["colmap", "matches_importer", "--database_path", database, "--match_list_path", pairs,
             "--match_type", "pairs", "--SiftMatching.use_gpu", "1", "--SiftMatching.guided_matching", "1"], work, lease)
        run(["colmap", "mapper", "--database_path", database, "--image_path", dataset/"images", "--output_path", sparse], work, lease)
        report["poses"] = select_room_model(sparse, report["capture"]["selectedFrames"], work)
        checkpoint("poses", ["dataset"])
    lease.stage("geometry", 0)
    dense = work / "dense"
    output = work / "output"
    cached_geometry = recover("geometry", "output")
    output.mkdir(exist_ok=True)
    # Revalidate recovered camera checkpoints as well as new reconstructions.
    previous_poses = report["poses"]
    checked, invalidate = sanitize_camera_depths(dataset/"colmap/sparse/0", report["capture"]["selectedFrames"])
    checked["components"] = previous_poses.get("components", [])
    checked["excludedDepthViews"] = sorted(set(checked["excludedDepthViews"] + previous_poses.get("excludedDepthViews", [])))
    for key in ("filteredSparsePoints", "filteredSparseObservations", "collapsedSparsePoints"):
        checked[key] = checked.get(key, 0) + previous_poses.get(key, 0)
    report["poses"] = checked
    if cached_geometry and not invalidate:
        report["geometry"] = cached_geometry["geometry"]
    else:
        cached_dense = recover("poses", "dense")
        if cached_dense:
            # Reuse only immutable checkpoints with matching capture/tool fingerprints.
            for name in invalidate:
                for folder in ("depth_maps", "normal_maps", "consistency_graphs"):
                    for path in (dense/"stereo"/folder).glob(name+".*.bin"):
                        path.unlink()
        run(["colmap", "image_undistorter", "--image_path", dataset/"images", "--input_path", dataset/"colmap/sparse/0",
             "--output_path", dense, "--output_type", "COLMAP", "--max_image_size", profile["resolution"]], work, lease)
        checkpoint("poses", ["dataset", "dense"])
        lease.progress("Depth estimation", "Starting this step", force=True)
        run(["colmap", "patch_match_stereo", "--workspace_path", dense, "--PatchMatchStereo.geom_consistency", "true",
             "--PatchMatchStereo.cache_size", "2", "--PatchMatchStereo.max_image_size", profile["resolution"]], work, lease, 14400)
        report["geometry"] = build_collision(dense, output, report["poses"], lease)
    schedule = training_schedule(profile, report["poses"]["registeredFrames"])
    report["trainingSchedule"] = schedule
    checkpoint("geometry", ["dataset", "output"])
    lease.stage("training", 0)
    training = work / "training"
    resume = []
    if cached_geometry and not invalidate:
        current_files = {str(path.relative_to(dataset)): digest(path) for path in dataset.rglob("*") if path.is_file()}
        for saved, root in previous:
            # Only resume a trainer whose dataset exactly matches the recovered camera checkpoint.
            if saved.get("files", {}).get("dataset") == current_files:
                for path in (root/"training").rglob("step-*.ckpt"):
                    if path.stat().st_size > 0 and (path.parent.parent/"config.yml").is_file():
                        resume.append(path)
    resume_args = []
    remaining_steps = schedule["steps"]
    if resume:
        latest = max(resume, key=lambda path: int(path.stem.split("-")[-1]))
        resume_args = ["--load-dir", latest.parent, "--load-step", int(latest.stem.split("-")[-1])]
        report["resumedTrainingStep"] = resume_args[-1]
        # Nerfstudio 1.1.5 adds max_num_iterations to the checkpoint's next step.
        remaining_steps = max(0, schedule["steps"] - (report["resumedTrainingStep"] + 1))
    if remaining_steps:
        run(["ns-train", "splatfacto", "--data", dataset, "--output-dir", training,
             *resume_args,
             "--max-num-iterations", remaining_steps, "--vis", "tensorboard",
             "--pipeline.datamanager.cache-images", "cpu", "--pipeline.datamanager.cache-images-type", "uint8",
             "--pipeline.model.stop-split-at", schedule["split_until"], "--pipeline.model.densify-grad-thresh", profile["gradient"],
             "--pipeline.model.sh-degree", profile["sh"], "--pipeline.model.rasterize-mode", "classic",
             "--pipeline.model.use-scale-regularization", "True", "colmap",
             "--downscale-factor", "1", "--orientation-method", "none", "--center-method", "none",
             "--auto-scale-poses", "False", "--assume-colmap-world-coordinate-convention", "False", "--scale-factor", "1.0",
             "--load-3D-points", "True"], work, lease, 14400)
        configs = sorted(training.rglob("config.yml"))
    else:
        configs = [latest.parent.parent/"config.yml"]
    if len(configs) != 1:
        raise ValueError("Trainer did not produce one completed configuration")
    # Export must load the newly saved weights, not the step used to start a resume.
    export_config = work/"export-config.yml"
    config_text, replacements = re.subn(r"(?m)^load_step:.*$", "load_step: null", configs[0].read_text())
    if replacements != 1:
        raise ValueError("Trainer configuration is missing its checkpoint selection")
    export_config.write_text(config_text)
    lease.stage("export", 0)
    run(["ns-export", "gaussian-splat", "--load-config", export_config, "--output-dir", output, "--output-filename", "room.ply"], work, lease)
    lease.stage("optimization", 0)
    report["appearance"] = compress(output/"room.ply", output, lease)
    lease.stage("validation", 0)
    report["seconds"] = round(time.monotonic()-started, 2)
    import torch
    report["gpu"] = {"name": torch.cuda.get_device_name(0), "vramBytes": torch.cuda.get_device_properties(0).total_memory}
    (output/"quality-report.json").write_text(json.dumps(report, indent=2))
    assets = {}
    asset_files = {"splats": "room.spz", "source": "room.ply", "collision": "collision.glb", "report": "quality-report.json"}
    total_bytes = sum((output/file).stat().st_size for file in asset_files.values())
    hashed = 0
    def packaging_progress(size):
        nonlocal hashed
        hashed += size
        lease.progress("Package scene", "Verifying scene asset hashes", hashed, total_bytes, "bytes verified")
    lease.progress("Package scene", "Verifying scene asset hashes", 0, total_bytes, "bytes verified", force=True)
    for name, file in asset_files.items():
        path = output/file
        if not path.is_file() or path.stat().st_size < 16:
            raise ValueError("Reconstruction artifact is missing")
        assets[name] = {"path": file, "sha256": digest(path, packaging_progress), "bytes": path.stat().st_size}
    manifest = {"schemaVersion": 1, "sceneId": str(job["id"]), "version": 1, "ready": False,
                "units": "uncalibrated", "axes": "right-handed-y-up",
                "worldFromReconstruction": [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
                "assets": assets, "previewCamera": report["poses"]["previewCamera"],
                "floorProposal": report["geometry"]["floorProposal"], "collisionReviewed": False,
                "scaleProvenance": {"method": "unknown"}, "generator": report["tools"]}
    (output/"manifest.json").write_text(json.dumps(manifest, indent=2))
    checkpoint("export", ["dataset", "output"])
    return output, report
