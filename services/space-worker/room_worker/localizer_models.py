"""Pinned camera-localization weights, downloaded only during explicit setup.

Inference calls ``ensure_localizer_models()`` before constructing ALIKED and
LightGlue. Both upstream loaders find these names in TORCH_HOME's checkpoint
directory, so serving a localization request never needs to download a model.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import tempfile
import time
import urllib.request
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


DEFAULT_TORCH_HOME = "/opt/room-models/torch"
DEFAULT_CPU_TORCH_THREADS = 2
_DOWNLOAD_TIMEOUT_SECONDS = 30
_DOWNLOAD_DEADLINE_SECONDS = 300
_CHUNK_BYTES = 1024 * 1024


@dataclass(frozen=True)
class _Model:
    filename: str
    size: int
    sha256: str
    url: str


_MODELS = {
    "aliked": _Model(
        "aliked-n16.pth",
        2738091,
        "5be8704840ed662d9d8c561bf7279c222092674e7eb05fd0feab94899e9d82f2",
        "https://raw.githubusercontent.com/Shiaoming/ALIKED/ef4a438ea85cd8c46283c5beb5817fa23db6f692/models/aliked-n16.pth",
    ),
    "lightglue": _Model(
        "aliked_lightglue_v0-1_arxiv.pth",
        47632827,
        "d975e965b105311a6143194852297dff4f02aea5cc2e10cecfed966ca0e22503",
        "https://github.com/cvg/LightGlue/releases/download/v0.1_arxiv/aliked_lightglue.pth",
    ),
}


def _file_identity(path: Path) -> tuple[int, int, int, int, int]:
    stat = path.stat()
    if not path.is_file():
        raise ValueError("checkpoint is not a regular file")
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


@lru_cache(maxsize=8)
def _verified_sha256(path: str, identity: tuple[int, int, int, int, int]) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(_CHUNK_BYTES), b""):
            digest.update(chunk)
    if _file_identity(Path(path)) != identity:
        raise ValueError("checkpoint changed during verification")
    return digest.hexdigest()


def _validate(path: Path, model: _Model) -> None:
    identity = _file_identity(path)
    if identity[2] != model.size:
        raise ValueError(f"checkpoint size differs from pinned {model.size} bytes")
    if _verified_sha256(str(path), identity) != model.sha256:
        raise ValueError("checkpoint SHA-256 differs from its pinned checksum")


def _download(path: Path, model: _Model) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{model.filename}.", suffix=".download", dir=path.parent
    )
    temporary = Path(temporary_name)
    deadline = time.monotonic() + _DOWNLOAD_DEADLINE_SECONDS
    request = urllib.request.Request(model.url, headers={"User-Agent": "room-localizer-model-setup"})
    try:
        with os.fdopen(descriptor, "wb") as destination:
            with urllib.request.urlopen(request, timeout=_DOWNLOAD_TIMEOUT_SECONDS) as response:
                length = response.headers.get("Content-Length")
                if length is not None and int(length) != model.size:
                    raise ValueError("download Content-Length differs from the pinned checkpoint size")
                received = 0
                while True:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("checkpoint download exceeded its time limit")
                    chunk = response.read(_CHUNK_BYTES)
                    if not chunk:
                        break
                    received += len(chunk)
                    if received > model.size:
                        raise ValueError("download exceeds the pinned checkpoint size")
                    destination.write(chunk)
            destination.flush()
            os.fsync(destination.fileno())
        _validate(temporary, model)
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def ensure_localizer_models(download: bool = False) -> dict[str, Path]:
    """Return checked ALIKED/LightGlue checkpoints without runtime networking.

    Model hashes are cached for unchanged files within this process. Explicit
    ``download=True`` is reserved for image construction or operator setup and
    atomically replaces an absent or invalid checkpoint after verification.
    """
    torch_home = Path(os.environ.setdefault("TORCH_HOME", DEFAULT_TORCH_HOME)).expanduser()
    checkpoints = (torch_home / "hub" / "checkpoints").resolve()
    result = {}
    for name, model in _MODELS.items():
        path = checkpoints / model.filename
        try:
            _validate(path, model)
        except (OSError, ValueError) as error:
            if not download:
                raise RuntimeError(
                    f"Camera localizer checkpoint {model.filename} is missing or invalid. "
                    "Rebuild the room worker image to install its checked model weights."
                ) from error
            _download(path, model)
            _validate(path, model)
        result[name] = path
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="explicitly install pinned model weights")
    arguments = parser.parse_args()
    for name, path in ensure_localizer_models(download=arguments.download).items():
        print(f"{name}: verified {path.name}")


if __name__ == "__main__":
    main()
