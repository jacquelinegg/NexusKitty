"""Generate extension/popup/config.js from backend/.env.

A browser extension cannot read backend/.env at runtime, so the values the
extension needs have to be baked into a JS file that popup.html loads. This
script is the single source of truth for that file: it reads EXTENSION_API_KEY
from the backend .env and rewrites the key in extension/popup/config.js in
place, leaving the rest of the file untouched.

Usage (from the repo root):
    python scripts/sync_extension_config.py
    python scripts/sync_extension_config.py --env backend/.env
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ENV_FILE = REPO_ROOT / "backend" / ".env"
CONFIG_FILE = REPO_ROOT / "extension" / "popup" / "config.js"

KEY_LINE_RE = re.compile(
    r"^(?P<indent>\s*)EXTENSION_API_KEY:\s*(?P<value>.*?),\s*$",
    re.MULTILINE,
)


def read_env_value(env_file: Path, name: str) -> str:
    """Read a single variable from a .env file without extra dependencies."""
    if not env_file.is_file():
        raise SystemExit(f"ERROR: env file not found: {env_file}")

    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key.strip() != name:
            continue
        return value.strip().strip('"').strip("'")

    raise SystemExit(f"ERROR: {name} is not set in {env_file}")


def inject_key(config_source: str, api_key: str) -> str:
    """Replace the EXTENSION_API_KEY value inside a config.js source string."""
    quoted = f"'{api_key}'"
    match = KEY_LINE_RE.search(config_source)
    if not match:
        raise SystemExit(
            f"ERROR: no 'EXTENSION_API_KEY:' line found in {CONFIG_FILE}.\n"
            "Expected a line like:  EXTENSION_API_KEY: '...',"
        )
    return (
        config_source[: match.start()]
        + f"{match.group('indent')}EXTENSION_API_KEY: {quoted},"
        + config_source[match.end() :]
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env",
        type=Path,
        default=DEFAULT_ENV_FILE,
        help=f"path to the .env file (default: {DEFAULT_ENV_FILE})",
    )
    args = parser.parse_args()

    api_key = read_env_value(args.env.resolve(), "EXTENSION_API_KEY")

    if not CONFIG_FILE.is_file():
        raise SystemExit(f"ERROR: extension config not found: {CONFIG_FILE}")

    source = CONFIG_FILE.read_text(encoding="utf-8")
    updated = inject_key(source, api_key)

    if updated == source:
        print(f"config.js already matches {args.env} - nothing to do.")
        return 0

    CONFIG_FILE.write_text(updated, encoding="utf-8")
    # Only the fingerprint is printed; the key itself must stay out of logs.
    print(f"Wrote EXTENSION_API_KEY (...{api_key[-6:]}) to {CONFIG_FILE}")
    print("Reload the extension in chrome://extensions to pick it up.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
