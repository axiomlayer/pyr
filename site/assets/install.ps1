<#
.SYNOPSIS
Installs pyr on Windows.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 inherits its TLS default from .NET Framework/Schannel
# system defaults, which on an unpatched or older host can still exclude
# TLS 1.2. GitHub's API and CDN require it, and the failure mode is a bare
# "the underlying connection was closed" with no hint that TLS is the cause.
# CI's windows-latest runner is always current enough not to need this, which
# is exactly why this can pass there and fail on a real machine. Bitwise-OR
# in the flag rather than assigning it outright, so an already-correct or
# broader system setting is preserved.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = "jasenc7/pyr"
$PyrHome = if ($env:PYR_HOME) { $env:PYR_HOME } else { Join-Path $env:USERPROFILE ".pyr" }
$InstallDir = Join-Path $PyrHome "bin"
# The Windows install_only layout puts python.exe at the root of the managed
# tree, not under bin\ as on macOS and Linux (see managedPython in lib.ts).
$PythonDir  = Join-Path $PyrHome "python"

switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { $target = "windows-x86_64" }
    "ARM64" { $target = "windows-aarch64" }
    default { Write-Error "unsupported arch: $env:PROCESSOR_ARCHITECTURE"; exit 1 }
}

$AssetName = "pyr-$target.zip"
$Headers = @{ Accept = "application/vnd.github+json" }
$Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $Headers
$Tag = [string]$Release.tag_name
if ($Tag -notmatch '^v[0-9A-Za-z._-]+$') {
    throw "invalid latest release tag"
}
$BaseUrl = "https://github.com/$Repo/releases/download/$Tag"
$Url = "$BaseUrl/$AssetName"
Write-Host "installing pyr..."
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zipPath = Join-Path $tmp "pyr.zip"
    $sumsPath = Join-Path $tmp "SHA256SUMS"
    Invoke-WebRequest -Uri "$BaseUrl/SHA256SUMS" -OutFile $sumsPath -UseBasicParsing
    $expected = $null
    foreach ($line in Get-Content -LiteralPath $sumsPath) {
        $parts = $line -split '\s+', 2
        if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $AssetName) {
            $expected = $parts[0]
            break
        }
    }
    if ([string]::IsNullOrEmpty($expected) -or $expected -notmatch '^[0-9A-Fa-f]{64}$') {
        throw "SHA256SUMS has no valid entry for $AssetName"
    }

    Invoke-WebRequest -Uri $Url -OutFile $zipPath -UseBasicParsing
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash
    if ($actual -ine $expected) {
        throw "SHA-256 mismatch for $AssetName"
    }
    Expand-Archive -Path $zipPath -DestinationPath $tmp -Force

    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }
    $src = Join-Path $tmp "pyr.exe"
    $dst = Join-Path $InstallDir "pyr.exe"
    Move-Item -Path $src -Destination $dst -Force
    Write-Host "installed to $dst"

    # check PATH
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = if ($userPath) { $userPath.Split(';', [StringSplitOptions]::RemoveEmptyEntries) } else { @() }
    $hasInstall = $parts -icontains $InstallDir
    $hasPython  = $parts -icontains $PythonDir

    if (-not ($hasInstall -and $hasPython)) {
        $missing = @()
        if (-not $hasInstall) { $missing += $InstallDir }
        if (-not $hasPython)  { $missing += $PythonDir }
        $toPrepend = $missing -join ';'

        Write-Host ""
        Write-Host "add to your user PATH (run in PowerShell):"
        Write-Host "  [Environment]::SetEnvironmentVariable('Path', '$toPrepend;' + [Environment]::GetEnvironmentVariable('Path','User'), 'User')"
        Write-Host ""
        Write-Host "then restart your shell."
    }
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
