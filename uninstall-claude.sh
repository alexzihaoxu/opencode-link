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

# 2. Install dir.
if [ -d "$INSTALL_DIR" ]; then
  say "removing $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
else
  say "install dir"; skip
fi

# 3. Stale state file (TUI mirror; harmless to leave).
STATE="$LINK_HOME/state.json"
if [ -f "$STATE" ]; then
  rm -f "$STATE"
fi

# 4. Optionally remove identity + salt files. Only ask interactively.
if [ -d "$LINK_HOME" ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    read -r -p "Also delete persisted identities + salt at $LINK_HOME? [y/N] " yn
    case "$yn" in
      y|Y|yes)
        rm -rf "$LINK_HOME"
        ok "identities + salt removed"
        ;;
      *)
        say "kept $LINK_HOME (delete it manually if you want a clean slate)"
        ;;
    esac
  else
    say "identities + salt at $LINK_HOME left in place (re-run interactively or rm -rf to clear)"
  fi
fi

ok "opencode-link uninstalled from Claude Code. Restart any open \`claude\` sessions."
