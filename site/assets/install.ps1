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

$Url = "https://github.com/$Repo/releases/latest/download/pyr-$target.zip"
Write-Host "installing pyr..."
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zipPath = Join-Path $tmp "pyr.zip"
    Invoke-WebRequest -Uri $Url -OutFile $zipPath -UseBasicParsing
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
