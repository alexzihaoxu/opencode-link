# Uninstaller for opencode-link (PowerShell).
#
# Usage:
#   irm https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/uninstall.ps1 | iex

$ErrorActionPreference = "Stop"

$configDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $HOME ".config\opencode" }
$linkHome  = if ($env:OPENCODE_LINK_HOME)   { $env:OPENCODE_LINK_HOME   } else { Join-Path $HOME ".config\opencode-link" }

if (-not (Test-Path $configDir)) {
    Write-Host "✗ opencode config dir not found at $configDir. Nothing to do."
    exit 0
}

Push-Location $configDir
try {
    # 1. Remove the package
    $pkg = Join-Path $configDir "node_modules\opencode-link"
    $pkgJson = Join-Path $configDir "package.json"
    $hasDep = (Test-Path $pkgJson) -and (Select-String -Path $pkgJson -Pattern '"opencode-link"' -Quiet)
    if ((Test-Path $pkg) -or $hasDep) {
        Write-Host "→ removing opencode-link package"
        & bun remove opencode-link 2>$null
        if (Test-Path $pkg) { Remove-Item -Recurse -Force $pkg -ErrorAction SilentlyContinue }
    }
    else {
        Write-Host "→ opencode-link package"
        Write-Host "  (already gone)"
    }

    # 2. Remove the bridge files
    $bridges = @(
        (Join-Path $configDir "plugins\opencode-link.ts"),
        (Join-Path $configDir "plugins\opencode-link-tui.ts")
    )
    $removedAny = $false
    foreach ($b in $bridges) {
        if (Test-Path $b) {
            Write-Host "→ removing $b"
            Remove-Item -Force $b
            $removedAny = $true
        }
    }
    if (-not $removedAny) {
        Write-Host "→ plugin bridge files"
        Write-Host "  (already gone)"
    }

    # 2b. Remove the state file (regenerated on next launch).
    $stateFile = Join-Path $linkHome "state.json"
    if (Test-Path $stateFile) {
        Remove-Item -Force $stateFile -ErrorAction SilentlyContinue
    }

    # 3. Optionally remove identity files.
    if (Test-Path $linkHome) {
        $isInteractive = [Environment]::UserInteractive -and $Host.UI.RawUI
        if ($isInteractive) {
            $yn = Read-Host "Also delete persisted identities + salt at $linkHome? [y/N]"
            if ($yn -match '^(y|yes)$') {
                Remove-Item -Recurse -Force $linkHome
                Write-Host "✓ identities removed"
            }
            else {
                Write-Host "→ kept $linkHome (delete it manually if you want a clean slate)"
            }
        }
        else {
            Write-Host "→ identities at $linkHome left in place (re-run interactively or rm -r to clear)"
        }
    }
}
finally {
    Pop-Location
}

Write-Host "✓ opencode-link uninstalled. Restart opencode to drop the tools from active sessions."
