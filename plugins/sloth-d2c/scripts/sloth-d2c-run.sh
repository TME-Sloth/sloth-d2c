#!/usr/bin/env bash
set -euo pipefail

if ! command -v sloth >/dev/null 2>&1; then
  echo "sloth CLI is not installed. Install sloth-d2c-mcp first." >&2
  exit 127
fi

exec sloth d2c "$@"
