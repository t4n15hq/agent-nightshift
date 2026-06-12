#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
LOG_FILE="${HOME}/claude-night-worker.log"
MARKER="claude-night-worker:${ROOT_DIR}"
TEMP_FILE="$(mktemp)"
trap 'rm -f "$TEMP_FILE"' EXIT

if [[ ! -f "${ROOT_DIR}/dist/index.js" ]]; then
  echo "dist/index.js is missing. Run npm run build first." >&2
  exit 1
fi

crontab -l 2>/dev/null | grep -Fv "$MARKER" > "$TEMP_FILE" || true
printf '5,35 0-6 * * * cd %q && PATH=%q %q dist/index.js run >> %q 2>&1 # %s\n' \
  "$ROOT_DIR" "$PATH" "$NODE_BIN" "$LOG_FILE" "$MARKER" >> "$TEMP_FILE"
crontab "$TEMP_FILE"

echo "Installed cron schedule:"
grep -F "$MARKER" "$TEMP_FILE"
