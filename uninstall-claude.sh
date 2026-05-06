#!/usr/bin/env bash
# Uninstaller for the Claude Code MCP server side of opencode-link.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/uninstall-claude.sh | bash
#
# Removes the user-scope MCP registration, the install dir, and (if run
# interactively) optionally the persisted identity / salt files.

set -euo pipefail

INSTALL_DIR="${OPENCODE_LINK_INSTALL_DIR:-$HOME/.config/opencode-link/install}"
LINK_HOME="${OPENCODE_LINK_HOME:-$HOME/.config/opencode-link}"

err() { echo "✗ $*" >&2; }
say() { echo "→ $*"; }
ok()  { echo "✓ $*"; }
skip(){ echo "  (already gone)"; }

# 1. claude mcp remove (idempotent).
if command -v claude >/dev/null 2>&1; then
  say "removing MCP registration"
  if claude mcp remove opencode-link --scope user >/dev/null 2>&1; then
    :
  else
    say "  (no registration found)"
  fi
else
  say "claude CLI not on PATH — skipping MCP unregister"
fi

# 2. Install dir (Claude-specific: ~/.config/opencode-link/install/).
if [ -d "$INSTALL_DIR" ]; then
  say "removing $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
else
  say "install dir"; skip
fi

# Note on $LINK_HOME (~/.config/opencode-link/): we deliberately do NOT touch
# anything else under it. The identity files (identity-*.json), the salt file,
# and state.json are SHARED with the opencode install (if you have one), so
# removing them here could trash a working opencode setup. If you really want
# a clean slate, run:
#   rm -rf "$LINK_HOME"
# manually after confirming you don't have opencode-link installed for
# opencode too.

ok "opencode-link uninstalled from Claude Code. Restart any open \`claude\` sessions."
echo
echo "Note: persisted identities + salt at $LINK_HOME were left in place."
echo "They're shared with the opencode install. Delete manually with"
echo "  rm -rf \"$LINK_HOME\""
echo "if you don't use opencode-link with opencode either."
