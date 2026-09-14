<#
.SYNOPSIS
Installs pyr on Windows.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

# Windows PowerShell 5.1 does not always negotiate TLS 1.2 by default. Set it
# before touching GitHub so the one-line installer behaves like PowerShell 7.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Headers = @{ Accept = "application/vnd.github+json" }
$Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $Headers
$Tag = [string]$Release.tag_name
if ($Tag -notmatch '^v[0-9A-Za-z._-]+$') {
    throw "invalid latest release tag"
}
$AssetName = "pyr-$target.zip"
$asset = @($Release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1)
if ($asset.Count -eq 0 -and $target -eq "windows-aarch64") {
    # Older releases predate the native ARM64 artifact. Windows on ARM can
    # emulate the x86_64 binary, so keep the installer useful until a release
    # carries the native asset. A release with the native asset always wins.
    $fallbackTarget = "windows-x86_64"
    $fallbackName = "pyr-$fallbackTarget.zip"
    $fallbackAsset = @($Release.assets | Where-Object { $_.name -eq $fallbackName } | Select-Object -First 1)
    if ($fallbackAsset.Count -eq 0) {
        throw "latest release $Tag has neither $AssetName nor $fallbackName"
    }
    Write-Warning "latest release $Tag has no native Windows ARM64 asset; installing $fallbackName (Windows x86_64 emulation)"
    $target = $fallbackTarget
    $AssetName = $fallbackName
    $asset = $fallbackAsset
}
if ($asset.Count -eq 0) {
    throw "latest release $Tag has no $AssetName asset"
}
$BaseUrl = "https://github.com/$Repo/releases/download/$Tag"
$Url = "$BaseUrl/$AssetName"
Write-Host "installing pyr ($AssetName)..."
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
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
        throw "$AssetName does not contain pyr.exe at its archive root"
    }
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
