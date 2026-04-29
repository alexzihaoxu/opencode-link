#!/usr/bin/env bash
# One-shot installer for opencode-link.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<user>/opencode-link/main/install.sh | bash
#
# Or with a fork / branch:
#   OPENCODE_LINK_REPO=foo/opencode-link OPENCODE_LINK_REF=dev \
#     curl -fsSL https://raw.githubusercontent.com/foo/opencode-link/dev/install.sh | bash

set -euo pipefail

REPO="${OPENCODE_LINK_REPO:-AlexZihaoXu/opencode-link}"
REF="${OPENCODE_LINK_REF:-main}"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

err() { echo "✗ $*" >&2; }
say() { echo "→ $*"; }
ok()  { echo "✓ $*"; }

if ! command -v bun >/dev/null 2>&1; then
  err "bun not found on PATH. Install it from https://bun.sh first."
  exit 1
fi

if [ ! -d "$CONFIG_DIR" ]; then
  err "opencode config dir not found at $CONFIG_DIR."
  err "Run \`opencode\` at least once so it creates the directory, then re-run this installer."
  exit 1
fi

mkdir -p "$CONFIG_DIR/plugins"
cd "$CONFIG_DIR"

say "installing opencode-link from github:$REPO#$REF into $CONFIG_DIR"
bun add "github:$REPO#$REF"

# node-datachannel ships a prebuilt native binary that needs explicit trust on
# bun install. trustedDependencies in our package.json should cover it, but
# call it again here so the user doesn't have to know the magic command.
bun pm trust node-datachannel >/dev/null 2>&1 || true

# Drop a one-line bridge file into the plugins directory. opencode auto-loads
# everything in plugins/, which avoids the npm-name collision we'd hit if we
# tried to put "opencode-link" in the plugin array of opencode.jsonc.
cat > "$CONFIG_DIR/plugins/opencode-link.ts" <<'EOF'
export { server } from "opencode-link";
EOF

ok "opencode-link installed."
echo
echo "  package : $CONFIG_DIR/node_modules/opencode-link"
echo "  bridge  : $CONFIG_DIR/plugins/opencode-link.ts"
echo
echo "Restart opencode (or open a new session) to load it."
echo "To upgrade, re-run this installer. To uninstall:"
echo "  cd \"$CONFIG_DIR\" && bun remove opencode-link && rm plugins/opencode-link.ts"
