"""Generate extension/popup/config.js from backend/.env.

A browser extension cannot read backend/.env at runtime, so the values the
extension needs have to be baked into a JS file that popup.html loads. This
script is the single source of truth for that file: it reads EXTENSION_API_KEY
from the backend .env and rewrites the key in extension/popup/config.js in
place, leaving the rest of the file untouched.

It can also switch APP_ENV, which decides which backend the extension talks to.
The key and the target are two different things and forgetting the second one
is a recurring source of "Failed to fetch" from a machine with no local backend
running: the script happily syncs the key and leaves the extension pointing at
localhost.

Usage (from the repo root):
    python scripts/sync_extension_config.py
    python scripts/sync_extension_config.py --env backend/.env
    python scripts/sync_extension_config.py --app-env production
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
APP_ENV_RE = re.compile(r"^const APP_ENV\s*=\s*'(?P<value>[a-z]+)';", re.MULTILINE)

API_BASE_FOR_ENV = {
    "development": "http://localhost:8000",
    "production": "https://nexuskitty.onrender.com",
}


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


def set_app_env(config_source: str, app_env: str) -> str:
    """Point config.js at the chosen backend, and report which one that is."""
    match = APP_ENV_RE.search(config_source)
    if not match:
        raise SystemExit(
            "ERROR: no \"const APP_ENV = '...';\" line found in "
            f"{CONFIG_FILE}."
        )
    return (
        config_source[: match.start()]
        + f"const APP_ENV = '{app_env}';"
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
    parser.add_argument(
        "--app-env",
        choices=sorted(API_BASE_FOR_ENV),
        default=None,
        help=(
            "which backend the extension talks to. Omitted, APP_ENV is left "
            "as it is."
        ),
    )
    args = parser.parse_args()

    api_key = read_env_value(args.env.resolve(), "EXTENSION_API_KEY")

    if not CONFIG_FILE.is_file():
        raise SystemExit(f"ERROR: extension config not found: {CONFIG_FILE}")

    source = CONFIG_FILE.read_text(encoding="utf-8")
    updated = inject_key(source, api_key)
    if args.app_env:
        updated = set_app_env(updated, args.app_env)

    current = APP_ENV_RE.search(updated)
    app_env = current.group("value") if current else "?"

    if updated == source:
        print(f"config.js already matches {args.env} - nothing to rewrite.")
    else:
        CONFIG_FILE.write_text(updated, encoding="utf-8")
        # Only the fingerprint is printed; the key itself must stay out of logs.
        print(f"Wrote EXTENSION_API_KEY (...{api_key[-6:]}) to {CONFIG_FILE}")

    print(f"APP_ENV = '{app_env}' -> {API_BASE_FOR_ENV.get(app_env, 'unknown')}")
    print("Reload the extension in chrome://extensions to pick it up.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
