# One-shot installer for opencode-link (PowerShell).
#
# Usage:
#   irm https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/install.ps1 | iex
#
# Configurable via env vars before running:
#   $env:OPENCODE_LINK_REPO = "foo/opencode-link"
#   $env:OPENCODE_LINK_REF  = "dev"

$ErrorActionPreference = "Stop"

$repo      = if ($env:OPENCODE_LINK_REPO) { $env:OPENCODE_LINK_REPO } else { "AlexZihaoXu/opencode-link" }
$ref       = if ($env:OPENCODE_LINK_REF)  { $env:OPENCODE_LINK_REF  } else { "main" }
$configDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $HOME ".config\opencode" }

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Error "bun not found on PATH. Install it from https://bun.sh first."
    exit 1
}

if (-not (Test-Path $configDir)) {
    Write-Error "opencode config dir not found at $configDir. Run ``opencode`` once so it creates the directory, then re-run this installer."
    exit 1
}

$pluginsDir = Join-Path $configDir "plugins"
if (-not (Test-Path $pluginsDir)) {
    New-Item -ItemType Directory -Path $pluginsDir | Out-Null
}

Write-Host "→ installing opencode-link from github:${repo}#${ref} into $configDir"
Push-Location $configDir
try {
    & bun add "github:${repo}#${ref}"
    if ($LASTEXITCODE -ne 0) { throw "bun add failed" }

    # node-datachannel's prebuild-install postinstall is skipped when the
    # package lands as a transitive dep (bun ignores our trustedDependencies
    # in that case). Run it directly so the .node binary actually downloads.
    $nd = Join-Path $configDir "node_modules\node-datachannel"
    $nodeBin = Join-Path $nd "build\Release\node_datachannel.node"
    if ((Test-Path $nd) -and -not (Test-Path $nodeBin)) {
        Write-Host "→ fetching node-datachannel prebuilt native binary"
        Push-Location $nd
        try {
            & bunx prebuild-install -r napi
            if ($LASTEXITCODE -ne 0) {
                Write-Error "prebuild-install failed. node-datachannel may not have a prebuilt binary for your platform. With a C++ toolchain you can build manually: cd `"$nd`"; npm run _prebuild"
                exit 1
            }
        }
        finally { Pop-Location }
    }

    $bridge = "export { server } from `"opencode-link`";`n"
    $bridgePath = Join-Path $pluginsDir "opencode-link.ts"
    Set-Content -Path $bridgePath -Value $bridge -NoNewline -Encoding utf8
}
finally {
    Pop-Location
}

Write-Host "✓ opencode-link installed."
Write-Host ""
Write-Host "  package : $configDir\node_modules\opencode-link"
Write-Host "  bridge  : $configDir\plugins\opencode-link.ts"
Write-Host ""
Write-Host "Restart opencode (or open a new session) to load it."
Write-Host "Uninstall: cd `"$configDir`" && bun remove opencode-link && rm plugins\opencode-link.ts"
