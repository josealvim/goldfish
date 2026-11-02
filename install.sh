#!/usr/bin/env bash
set -euo pipefail

# Install goldfish directly from GitHub. No npm publish is involved.
#
# Usage:
#   ./install.sh
#   ./install.sh github:josealvim/goldfish#v0.2.0
#   GOLDFISH_SPEC=github:josealvim/goldfish ./install.sh

SPEC="${1:-${GOLDFISH_SPEC:-github:josealvim/goldfish}}"
DEST="${GOLDFISH_DIR:-${HOME}/.config/opencode/plugins/goldfish}"

if ! command -v opencode >/dev/null 2>&1; then
  echo "error: opencode is not on PATH" >&2
  exit 1
fi

echo "Trying OpenCode's Git installer for ${SPEC}..."
if opencode plugin add "${SPEC}"; then
  echo
  echo "Installed. Restart OpenCode or run /reload."
  echo "Verify with: opencode plugin list"
  exit 0
fi

echo
echo "OpenCode's Git installer did not complete. Falling back to a manual clone."
if ! command -v git >/dev/null 2>&1; then
  echo "error: git is not on PATH" >&2
  exit 1
fi

REPO="${GOLDFISH_REPO:-https://github.com/josealvim/goldfish.git}"
if [ -d "${DEST}/.git" ]; then
  git -C "${DEST}" pull --ff-only
else
  mkdir -p "$(dirname "${DEST}")"
  git clone --depth 1 "${REPO}" "${DEST}"
fi

cat <<EOF

Cloned to:
  ${DEST}

Add this to ~/.config/opencode/opencode.json:

{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": ["${DEST}"]
}

Then restart OpenCode or run /reload.
EOF
