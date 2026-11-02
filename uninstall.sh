#!/usr/bin/env bash
set -euo pipefail

SPEC="${1:-${GOLDFISH_SPEC:-${MONKEY_MEMORY_SPEC:-github:josealvim/goldfish}}}"
DEST="${GOLDFISH_DIR:-${MONKEY_MEMORY_DIR:-${HOME}/.config/opencode/plugins/goldfish}}"

if ! command -v opencode >/dev/null 2>&1; then
  echo "error: opencode is not on PATH" >&2
  exit 1
fi

if opencode plugin remove "${SPEC}"; then
  echo "Removed ${SPEC}. Restart OpenCode or run /reload."
  exit 0
fi

cat <<EOF
No managed plugin entry was found for ${SPEC}.

If you installed manually, remove:
  ${DEST}

and delete its path from the "plugins" array in
~/.config/opencode/opencode.json. Then restart OpenCode or run /reload.
EOF
