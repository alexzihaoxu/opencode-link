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

    # node-datachannel's postinstall (prebuild-install) is silently skipped
    # when the package lands as a transitive dep — bun ignores our
    # trustedDependencies in that case. Fetch the prebuilt tarball directly
    # from GitHub releases; bulletproof and no node-side magic.
    $nd = Join-Path $configDir "node_modules\node-datachannel"
    $nodeBin = Join-Path $nd "build\Release\node_datachannel.node"
    if ((Test-Path $nd) -and -not (Test-Path $nodeBin)) {
        $ndPkg = Get-Content (Join-Path $nd "package.json") -Raw | ConvertFrom-Json
        $version = $ndPkg.version
        $arch = (Get-CimInstance Win32_Processor).Architecture
        # 9 = arm64 on Windows; 5,12 also arm; 0,9 = x64; default to x64
        $platform = if ($arch -eq 9 -or $arch -eq 12 -or $env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win32-arm64" } else { "win32-x64" }
        $url = "https://github.com/murat-dogan/node-datachannel/releases/download/v$version/node-datachannel-v$version-napi-v8-$platform.tar.gz"
        $tar = Join-Path $env:TEMP "oc-link-nd.tgz"
        Write-Host "→ downloading prebuilt binary: $platform v$version"
        try {
            Invoke-WebRequest -Uri $url -OutFile $tar -UseBasicParsing
            New-Item -ItemType Directory -Path (Join-Path $nd "build\Release") -Force | Out-Null
            & tar -xzf $tar -C $nd
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path $nodeBin)) {
                throw "tar extraction failed or binary missing at $nodeBin"
            }
            Remove-Item $tar -ErrorAction SilentlyContinue
        }
        catch {
            Write-Error "Could not install node-datachannel native binary: $_"
            Write-Error "Manual fallback: cd `"$nd`"; bunx prebuild-install -r napi"
            exit 1
        }
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
