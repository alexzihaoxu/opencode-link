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

# node-datachannel ships a prebuilt native binary fetched by its postinstall
# (prebuild-install). When opencode-link is installed as a transitive dep,
# bun does NOT honor our package's trustedDependencies and the postinstall
# is silently skipped — leaving us without the .node binary. Even running
# `bunx prebuild-install` after the fact has been observed to fail silently
# on some setups. So we just fetch the tarball directly from GitHub releases:
# bulletproof, one HTTP GET, no node-side magic.
ND="$CONFIG_DIR/node_modules/node-datachannel"
ND_BIN="$ND/build/Release/node_datachannel.node"

fetch_native_binary() {
  local version platform url
  version=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$ND/package.json" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
  if [ -z "$version" ]; then err "could not read node-datachannel version"; return 1; fi

  local os arch
  os=$(uname -s)
  arch=$(uname -m)
  case "$os/$arch" in
    Darwin/arm64)         platform="darwin-arm64" ;;
    Darwin/x86_64)        platform="darwin-x64" ;;
    Linux/x86_64)         platform="linux-x64" ;;
    Linux/aarch64)        platform="linux-arm64" ;;
    Linux/armv7l|Linux/armv6l) platform="linux-arm" ;;
    MINGW*/*|MSYS*/*|CYGWIN*/x86_64) platform="win32-x64" ;;
    MINGW*/aarch64|MSYS*/aarch64) platform="win32-arm64" ;;
    *) err "unsupported platform: $os/$arch"; return 1 ;;
  esac

  url="https://github.com/murat-dogan/node-datachannel/releases/download/v${version}/node-datachannel-v${version}-napi-v8-${platform}.tar.gz"
  say "downloading prebuilt binary: $platform v$version"
  if ! curl -fsSL "$url" -o /tmp/oc-link-nd.tgz; then
    err "download failed from $url"
    return 1
  fi
  mkdir -p "$ND/build/Release"
  if ! tar -xzf /tmp/oc-link-nd.tgz -C "$ND"; then
    err "tar extraction failed"
    return 1
  fi
  rm -f /tmp/oc-link-nd.tgz
  if [ ! -f "$ND_BIN" ]; then
    err "binary not found at expected path after extraction: $ND_BIN"
    return 1
  fi
  return 0
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

# Drop bridge files into the plugins directory. opencode auto-loads everything
# in plugins/, which avoids the npm-name collision we'd hit if we tried to put
# "opencode-link" in the plugin array of opencode.jsonc.
#
# Two bridges because the server plugin and the TUI sidebar plugin are
# mutually-exclusive module shapes in @opencode-ai/plugin's types
# (PluginModule vs TuiPluginModule).
cat > "$CONFIG_DIR/plugins/opencode-link.ts" <<'EOF'
export { server } from "opencode-link";
EOF

cat > "$CONFIG_DIR/plugins/opencode-link-tui.ts" <<'EOF'
export { default } from "opencode-link/tui";
EOF

ok "opencode-link installed."
echo
echo "  package      : $CONFIG_DIR/node_modules/opencode-link"
echo "  server bridge: $CONFIG_DIR/plugins/opencode-link.ts"
echo "  tui bridge   : $CONFIG_DIR/plugins/opencode-link-tui.ts"
echo
echo "Restart opencode (or open a new session) to load it."
echo "To upgrade, re-run this installer. To uninstall:"
echo "  cd \"$CONFIG_DIR\" && bun remove opencode-link && rm plugins/opencode-link*.ts"
