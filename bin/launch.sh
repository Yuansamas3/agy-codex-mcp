#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENTRY="$SCRIPT_DIR/../server/index.mjs"

if command -v node >/dev/null 2>&1; then
  exec node "$ENTRY" "$@"
fi

for CAND in \
  "$HOME/.volta/bin/node" \
  "$HOME/.fnm/current/bin/node" \
  "$HOME/.asdf/shims/node" \
  "/opt/homebrew/bin/node" \
  "/usr/local/bin/node" \
  "/usr/bin/node"
do
  if [ -x "$CAND" ]; then
    exec "$CAND" "$ENTRY" "$@"
  fi
done

echo "[sidedesk] Error: Node.js executable not found in PATH or standard installation directories." >&2
exit 1
