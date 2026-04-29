#!/usr/bin/env bash
# Uninstaller for opencode-link.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/uninstall.sh | bash
#
# Removes the package, the bridge plugin file, and (optionally) identity files.

set -euo pipefail

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
LINK_HOME="${OPENCODE_LINK_HOME:-$HOME/.config/opencode-link}"

err() { echo "✗ $*" >&2; }
say() { echo "→ $*"; }
ok()  { echo "✓ $*"; }
skip(){ echo "  (already gone)"; }

if [ ! -d "$CONFIG_DIR" ]; then
  err "opencode config dir not found at $CONFIG_DIR. Nothing to do."
  exit 0
fi

cd "$CONFIG_DIR"

# 1. Remove the package from the dep tree.
if [ -d "node_modules/opencode-link" ] || grep -q '"opencode-link"' package.json 2>/dev/null; then
  say "removing opencode-link package"
  bun remove opencode-link >/dev/null 2>&1 || rm -rf node_modules/opencode-link
else
  say "opencode-link package"
  skip
fi

# 2. Remove the bridge file.
BRIDGE="$CONFIG_DIR/plugins/opencode-link.ts"
if [ -f "$BRIDGE" ]; then
  say "removing $BRIDGE"
  rm -f "$BRIDGE"
else
  say "plugin bridge file"
  skip
fi

# 3. Optionally remove identity files. Only ask if running interactively.
if [ -d "$LINK_HOME" ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    read -r -p "Also delete persisted identities at $LINK_HOME? [y/N] " yn
    case "$yn" in
      y|Y|yes)
        rm -rf "$LINK_HOME"
        ok "identities removed"
        ;;
      *)
        say "kept $LINK_HOME (delete it manually if you want a clean slate)"
        ;;
    esac
  else
    say "identities at $LINK_HOME left in place (re-run interactively or rm -rf to clear)"
  fi
fi

ok "opencode-link uninstalled. Restart opencode to drop the tools from active sessions."
