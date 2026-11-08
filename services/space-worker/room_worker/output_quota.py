"""Reserve a bounded attempt's exact object sizes before publication or log writes."""
from .jobs import reserve_outputs, StorageQuotaExceeded

MAX_OUTPUT_BYTES = 2 * 1024**3


def reserve_files(job, paths, prefix, allocations):
    objects = dict(allocations)
    for path in paths:
        size = path.stat().st_size
        if size < 1:
            raise ValueError("Generated output must contain bytes")
        key = prefix + path.name
        if key in objects and objects[key] != size:
            raise ValueError("Reserved output size changed")
        objects[key] = size
    if sum(objects.values()) > MAX_OUTPUT_BYTES:
        raise StorageQuotaExceeded("Generated output exceeds the 2 GiB attempt storage limit")
    # A lost commit acknowledgement may still have admitted these exact keys.
    # Include that intent in any later log batch and its attempt-size bound.
    allocations.update(objects)
    if objects:
        reserve_outputs(job, objects)
