"""Validate completed input identities before checkpoints or media consumers use them."""
import hashlib
import re

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_SNAPSHOT_KEY = re.compile(rf"sealed-inputs/{_UUID}/{_UUID}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")


def validate_media(media):
    if not isinstance(media, list) or not media:
        raise ValueError("Capture requires pinned input snapshots")
    for item in media:
        if not isinstance(item, dict) or not isinstance(item.get("key"), str) or not _SNAPSHOT_KEY.fullmatch(item["key"]):
            raise ValueError("Capture requires a private pinned input snapshot")
        if not isinstance(item.get("sha256"), str) or not _SHA256.fullmatch(item["sha256"]):
            raise ValueError("Pinned input requires a lowercase SHA-256 checksum")
        if type(item.get("size")) is not int or item["size"] < 1:
            raise ValueError("Pinned input requires a positive file size")


def verify_download(path, item, lease):
    if path.stat().st_size != item["size"]:
        raise ValueError("Uploaded file size changed")
    result = hashlib.sha256()
    verified = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            lease.check()
            result.update(chunk)
            verified += len(chunk)
            lease.progress("Verify capture", "Checking pinned input SHA-256", verified, item["size"], "bytes verified")
    lease.check()
    if verified != item["size"] or result.hexdigest() != item["sha256"]:
        raise ValueError("Pinned input SHA-256 checksum does not match completed upload")
