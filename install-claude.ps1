# One-shot installer for opencode-link as a Claude Code MCP server (PowerShell).
#
# Usage:
#   irm https://raw.githubusercontent.com/AlexZihaoXu/opencode-link/main/install-claude.ps1 | iex
#
# Configurable via env vars before running:
#   $env:OPENCODE_LINK_REPO        = "foo/opencode-link"
#   $env:OPENCODE_LINK_REF         = "dev"
#   $env:OPENCODE_LINK_INSTALL_DIR = "C:\path\to\custom\install"

$ErrorActionPreference = "Stop"

$repo       = if ($env:OPENCODE_LINK_REPO) { $env:OPENCODE_LINK_REPO } else { "AlexZihaoXu/opencode-link" }
$ref        = if ($env:OPENCODE_LINK_REF)  { $env:OPENCODE_LINK_REF  } else { "main" }
$installDir = if ($env:OPENCODE_LINK_INSTALL_DIR) { $env:OPENCODE_LINK_INSTALL_DIR } else { Join-Path $HOME ".config\opencode-link\install" }

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Error "bun not found on PATH. Install it from https://bun.sh first."
    exit 1
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Error "claude CLI not found on PATH. Install Claude Code first: https://claude.com/claude-code"
    exit 1
}

if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}
$pkgJson = Join-Path $installDir "package.json"
if (-not (Test-Path $pkgJson)) {
    Set-Content -Path $pkgJson -Value '{ "name": "opencode-link-claude-host", "private": true, "type": "module" }' -Encoding utf8
}

Write-Host "→ installing opencode-link from github:${repo}#${ref} into $installDir"
Push-Location $installDir
try {
    & bun add "github:${repo}#${ref}"
    if ($LASTEXITCODE -ne 0) { throw "bun add failed" }

    # Fetch node-datachannel prebuilt native binary directly (bun skips the
    # postinstall on transitive deps).
    $nd = Join-Path $installDir "node_modules\node-datachannel"
    $nodeBin = Join-Path $nd "build\Release\node_datachannel.node"
    if ((Test-Path $nd) -and -not (Test-Path $nodeBin)) {
        $ndPkg = Get-Content (Join-Path $nd "package.json") -Raw | ConvertFrom-Json
        $version = $ndPkg.version
        $arch = (Get-CimInstance Win32_Processor).Architecture
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

    $mcpScript = Join-Path $installDir "node_modules\opencode-link\src\mcp.ts"
    if (-not (Test-Path $mcpScript)) {
        Write-Error "MCP entry script missing at $mcpScript — install may be corrupt."
        exit 1
    }

    Write-Host "→ registering with claude (user scope)"
    & claude mcp remove opencode-link --scope user 2>$null
    & claude mcp add --scope user opencode-link -- bun run "$mcpScript"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "claude mcp add failed"
        exit 1
    }
}
finally {
    Pop-Location
}

Write-Host "✓ opencode-link installed for Claude Code."
Write-Host ""
Write-Host "  package : $installDir\node_modules\opencode-link"
Write-Host "  MCP id  : opencode-link (user scope)"
Write-Host ""
Write-Host "Don't forget to set a shared salt:"
Write-Host "  `$bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes(`$bytes); Set-Content -Path `"`$HOME/.config/opencode-link/salt`" -Value ([BitConverter]::ToString(`$bytes).Replace('-','').ToLower()) -NoNewline -Encoding utf8"
Write-Host "Both ends of any conversation must use the SAME salt."
Write-Host ""
Write-Host "Restart any open ``claude`` sessions to load the MCP server."
Write-Host ""
Write-Host "Channels (the wake-up-on-incoming-message feature) are an experimental"
Write-Host "Claude Code feature. To enable, launch Claude with:"
Write-Host "  claude --dangerously-load-development-channels server:opencode-link"
Write-Host "Without that flag, link tools work fine but incoming peer messages"
Write-Host "won't auto-wake the agent — call link_inbox to see them."
