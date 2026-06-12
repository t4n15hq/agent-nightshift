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

# caffeinate keeps the machine awake while a run is in progress. It does not
# wake a sleeping machine; schedule wakes separately (see README).
CMD_PREFIX=""
if command -v caffeinate >/dev/null 2>&1; then
  CMD_PREFIX="$(command -v caffeinate) -i "
fi

crontab -l 2>/dev/null | grep -Fv "$MARKER" > "$TEMP_FILE" || true
printf '5,35 0-6 * * * cd %q && PATH=%q %s%q dist/index.js run >> %q 2>&1 # %s\n' \
  "$ROOT_DIR" "$PATH" "$CMD_PREFIX" "$NODE_BIN" "$LOG_FILE" "$MARKER" >> "$TEMP_FILE"
crontab "$TEMP_FILE"

echo "Installed cron schedule:"
grep -F "$MARKER" "$TEMP_FILE"

if [[ "$(uname)" == "Darwin" ]]; then
  cat <<'EOF'

macOS skips cron jobs while the machine is asleep. To make overnight runs
actually happen, schedule a wake just before the first tick, e.g.:

  sudo pmset repeat wakeorpoweron MTWRFSU 00:04:00

and stay logged in so the login keychain (Claude/GitHub credentials) stays
available. See the README section "Keeping the machine awake".
EOF
fi
