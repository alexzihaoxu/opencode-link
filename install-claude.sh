#!/usr/bin/env bash
# One-shot installer for opencode-link as a Claude Code MCP server.
#
# (Yes, the package name says "opencode" — historical, the same project now
# also targets Claude Code via this MCP entry point.)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/install-claude.sh | bash
#
# Or with a fork / branch:
#   OPENCODE_LINK_REPO=foo/opencode-link OPENCODE_LINK_REF=dev curl … | bash

set -euo pipefail

REPO="${OPENCODE_LINK_REPO:-AlexZihaoXu/opencode-link}"
REF="${OPENCODE_LINK_REF:-main}"
INSTALL_DIR="${OPENCODE_LINK_INSTALL_DIR:-$HOME/.config/opencode-link/install}"

err() { echo "✗ $*" >&2; }
say() { echo "→ $*"; }
ok()  { echo "✓ $*"; }

if ! command -v bun >/dev/null 2>&1; then
  err "bun not found on PATH. Install it from https://bun.sh first."
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  err "claude CLI not found on PATH. Install Claude Code first:"
  err "  https://claude.com/claude-code"
  exit 1
fi

# Dedicated install root so this works regardless of opencode being present.
mkdir -p "$INSTALL_DIR"
if [ ! -f "$INSTALL_DIR/package.json" ]; then
  cat > "$INSTALL_DIR/package.json" <<EOF
{ "name": "opencode-link-claude-host", "private": true, "type": "module" }
EOF
fi

say "installing opencode-link from github:$REPO#$REF into $INSTALL_DIR"
( cd "$INSTALL_DIR" && bun add "github:$REPO#$REF" )

# node-datachannel ships a prebuilt native binary that bun's transitive-dep
# trust handling silently skips. Fetch the tarball directly from GitHub
# releases — bulletproof, one HTTP GET, no node-side magic.
ND="$INSTALL_DIR/node_modules/node-datachannel"
ND_BIN="$ND/build/Release/node_datachannel.node"

fetch_native_binary() {
  local version platform url
  version=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$ND/package.json" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
  if [ -z "$version" ]; then err "could not read node-datachannel version"; return 1; fi

  local os arch
  os=$(uname -s); arch=$(uname -m)
  case "$os/$arch" in
    Darwin/arm64)              platform="darwin-arm64" ;;
    Darwin/x86_64)             platform="darwin-x64" ;;
    Linux/x86_64)              platform="linux-x64" ;;
    Linux/aarch64)             platform="linux-arm64" ;;
    Linux/armv7l|Linux/armv6l) platform="linux-arm" ;;
    MINGW*/*|MSYS*/*|CYGWIN*/x86_64) platform="win32-x64" ;;
    MINGW*/aarch64|MSYS*/aarch64)    platform="win32-arm64" ;;
    *) err "unsupported platform: $os/$arch"; return 1 ;;
  esac

  url="https://github.com/murat-dogan/node-datachannel/releases/download/v${version}/node-datachannel-v${version}-napi-v8-${platform}.tar.gz"
  say "downloading prebuilt binary: $platform v$version"
  if ! curl -fsSL "$url" -o /tmp/oc-link-nd.tgz; then
    err "download failed from $url"; return 1
  fi
  mkdir -p "$ND/build/Release"
  if ! tar -xzf /tmp/oc-link-nd.tgz -C "$ND"; then
    err "tar extraction failed"; rm -f /tmp/oc-link-nd.tgz; return 1
  fi
  rm -f /tmp/oc-link-nd.tgz
  if [ ! -f "$ND_BIN" ]; then
    err "binary not found at expected path after extraction: $ND_BIN"; return 1
  fi
}

if [ -d "$ND" ] && [ ! -f "$ND_BIN" ]; then
  if ! fetch_native_binary; then
    err "Could not install node-datachannel native binary."
    err "Manual fallback:"
    err "  cd $ND && bunx prebuild-install -r napi"
    err "Or build from source (needs CMake + a C++ toolchain):"
    err "  cd $ND && npm run _prebuild"
    exit 1
  fi
fi

MCP_SCRIPT="$INSTALL_DIR/node_modules/opencode-link/src/mcp.ts"
if [ ! -f "$MCP_SCRIPT" ]; then
  err "MCP entry script missing at $MCP_SCRIPT — install may be corrupt."
  exit 1
fi

# Idempotent: drop any previous registration before adding.
say "registering with claude (user scope)"
claude mcp remove opencode-link --scope user >/dev/null 2>&1 || true
if ! claude mcp add --scope user opencode-link -- bun run "$MCP_SCRIPT"; then
  err "claude mcp add failed."
  exit 1
fi

ok "opencode-link installed for Claude Code."
echo
echo "  package : $INSTALL_DIR/node_modules/opencode-link"
echo "  MCP id  : opencode-link (user scope)"
echo "  spawn   : bun run $MCP_SCRIPT"
echo
echo "Don't forget to set a shared salt:"
echo "  echo \"\$(openssl rand -hex 32)\" > ~/.config/opencode-link/salt"
echo "Both ends of any conversation must use the SAME salt — share out of band."
echo
echo "Restart any open \`claude\` sessions to load the MCP server."
echo
echo "Channels (the wake-up-on-incoming-message feature) are an experimental"
echo "Claude Code feature. To enable, launch Claude with:"
echo "  claude --dangerously-load-development-channels server:opencode-link"
echo "Without that flag, the link tools work fine, but incoming peer messages"
echo "won't auto-wake the agent — you'll need to call link_inbox to see them."
echo
echo "To upgrade, re-run this installer."
echo "To uninstall, see uninstall-claude.sh."
