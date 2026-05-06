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

# 2. Install dir.
if (Test-Path $installDir) {
    Write-Host "→ removing $installDir"
    Remove-Item -Recurse -Force $installDir -ErrorAction SilentlyContinue
}
else {
    Write-Host "→ install dir"
    Write-Host "  (already gone)"
}

# 3. Stale state mirror.
$stateFile = Join-Path $linkHome "state.json"
if (Test-Path $stateFile) {
    Remove-Item -Force $stateFile -ErrorAction SilentlyContinue
}

# 4. Optionally remove identity + salt files.
if (Test-Path $linkHome) {
    $isInteractive = [Environment]::UserInteractive -and $Host.UI.RawUI
    if ($isInteractive) {
        $yn = Read-Host "Also delete persisted identities + salt at $linkHome? [y/N]"
        if ($yn -match '^(y|yes)$') {
            Remove-Item -Recurse -Force $linkHome
            Write-Host "✓ identities + salt removed"
        }
        else {
            Write-Host "→ kept $linkHome (delete it manually if you want a clean slate)"
        }
    }
    else {
        Write-Host "→ identities + salt at $linkHome left in place (re-run interactively or rm -r to clear)"
    }
}

Write-Host "✓ opencode-link uninstalled from Claude Code. Restart any open ``claude`` sessions."
