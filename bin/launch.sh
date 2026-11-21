#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ENTRY="$SCRIPT_DIR/../server/index.mjs"
NODE_BIN=""

if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi

if [ -z "$NODE_BIN" ]; then
  for cand in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "${HOME:-}/.volta/bin/node" \
    "${HOME:-}/.fnm/current/bin/node" \
    "${HOME:-}/.asdf/shims/node" \
    "${HOME:-}/.local/share/mise/shims/node"
  do
    if [ -x "$cand" ]; then
      NODE_BIN="$cand"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ] && [ -d "${HOME:-}/.nvm/versions/node" ]; then
  for cand in $(ls -1d "${HOME}/.nvm/versions/node/"*/bin/node 2>/dev/null | sort -r); do
    if [ -x "$cand" ]; then
      NODE_BIN="$cand"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo "[sidedesk] Error: Node.js executable not found in PATH, Homebrew, or NVM." >&2
  exit 1
fi

exec "$NODE_BIN" "$ENTRY" "$@"
