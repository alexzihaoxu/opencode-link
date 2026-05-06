# Uninstaller for the Claude Code MCP server side of opencode-link (PowerShell).
#
# Usage:
#   irm https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/uninstall-claude.ps1 | iex

$ErrorActionPreference = "Stop"

$installDir = if ($env:OPENCODE_LINK_INSTALL_DIR) { $env:OPENCODE_LINK_INSTALL_DIR } else { Join-Path $HOME ".config\opencode-link\install" }
$linkHome   = if ($env:OPENCODE_LINK_HOME) { $env:OPENCODE_LINK_HOME } else { Join-Path $HOME ".config\opencode-link" }

# 1. claude mcp remove (idempotent).
if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Host "→ removing MCP registration"
    & claude mcp remove opencode-link --scope user 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  (no registration found)"
    }
}
else {
    Write-Host "→ claude CLI not on PATH — skipping MCP unregister"
}

# 2. Install dir (Claude-specific).
if (Test-Path $installDir) {
    Write-Host "→ removing $installDir"
    Remove-Item -Recurse -Force $installDir -ErrorAction SilentlyContinue
}
else {
    Write-Host "→ install dir"
    Write-Host "  (already gone)"
}

# Note: persisted identities + salt + state.json under $linkHome are SHARED
# with the opencode install (if any). Don't touch them here — the user can
# rm -rf $linkHome manually if they're sure neither harness uses it.

Write-Host "✓ opencode-link uninstalled from Claude Code. Restart any open ``claude`` sessions."
Write-Host ""
Write-Host "Note: persisted identities + salt at $linkHome were left in place."
Write-Host "They're shared with the opencode install. Delete manually with"
Write-Host "  Remove-Item -Recurse -Force `"$linkHome`""
Write-Host "if you don't use opencode-link with opencode either."
