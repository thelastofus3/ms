"""Stage scripts print `PROGRESS {...}` lines; the avatar worker turns them into job status for the web UI."""
import json


def report(fraction=None, message="", **metrics):
    print("PROGRESS " + json.dumps({"fraction": fraction, "message": message, **metrics}), flush=True)
