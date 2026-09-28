"""Local generation and package inspection entry point."""

import argparse
import sys
from pathlib import Path

from .models import AvatarProfile
from .packages import validate_package


def main():
    parser = argparse.ArgumentParser(prog="avatar")
    commands = parser.add_subparsers(dest="command", required=True)
    generate = commands.add_parser("generate")
    generate.add_argument("--profile", type=Path, required=True)
    generate.add_argument("--output", type=Path, required=True)
    generate.add_argument("--blender", type=Path)
    check = commands.add_parser("validate")
    check.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "generate":
            from .generator import generate_avatar

            profile = AvatarProfile.model_validate_json(
                args.profile.read_text(encoding="utf-8")
            )
            manifest = generate_avatar(profile, args.output, blender=args.blender)
        else:
            manifest = validate_package(args.directory)
        print(manifest.model_dump_json(indent=2))
        return 0
    except (ValueError, OSError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
