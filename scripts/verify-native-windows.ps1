[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("x86_64", "aarch64")]
    [string] $Architecture,

    [Parameter(Mandatory = $true)]
    [string] $Binary,

    [Parameter(Mandatory = $true)]
    [string] $Manifest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$expectedRuntimeArchitecture = switch ($Architecture) {
    "x86_64" { [System.Runtime.InteropServices.Architecture]::X64 }
    "aarch64" { [System.Runtime.InteropServices.Architecture]::Arm64 }
}
$actualRuntimeArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($actualRuntimeArchitecture -ne $expectedRuntimeArchitecture) {
    throw "runner OS architecture is $actualRuntimeArchitecture, expected $expectedRuntimeArchitecture"
}

$manifestValue = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$Version = [string]$manifestValue.release.version
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
    throw "$Manifest contains an invalid release version"
}
$assetKey = "windows-$Architecture"
$asset = @($manifestValue.assets | Where-Object { $_.key -eq $assetKey })
if ($asset.Count -ne 1) {
    throw "$Manifest must contain exactly one $assetKey asset"
}
if ([string]$asset[0].executable.path -ne "pyr.exe" -or [string]$asset[0].executable.format -ne "pe") {
    throw "$assetKey does not declare a root pyr.exe PE"
}

$resolvedBinary = (Resolve-Path -LiteralPath $Binary).Path
$bytes = [System.IO.File]::ReadAllBytes($resolvedBinary)
if ($bytes.Length -lt 70 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
    throw "$resolvedBinary is not an MZ executable"
}
$peOffset = [BitConverter]::ToUInt32($bytes, 0x3c)
if ($peOffset + 6 -gt $bytes.Length) {
    throw "$resolvedBinary has a truncated PE header"
}
$peSignature = [BitConverter]::ToUInt32($bytes, [int]$peOffset)
if ($peSignature -ne 0x00004550) {
    throw "$resolvedBinary has no PE signature"
}
$machine = [BitConverter]::ToUInt16($bytes, [int]$peOffset + 4)
$expectedMachine = switch ($Architecture) {
    "x86_64" { 0x8664 }
    "aarch64" { 0xaa64 }
}
if ($machine -ne $expectedMachine) {
    throw ("PE machine is 0x{0:x4}, expected 0x{1:x4}" -f $machine, $expectedMachine)
}

$reportedVersion = (& $resolvedBinary --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "$resolvedBinary --version exited $LASTEXITCODE`: $reportedVersion"
}
if ($reportedVersion -ne $Version) {
    throw "$resolvedBinary reported version $reportedVersion, expected $Version"
}

$help = (& $resolvedBinary --help 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $help -notmatch "usage: pyr") {
    throw "$resolvedBinary --help did not execute successfully"
}

Write-Host "executed Pyr $reportedVersion as native $Architecture PE on $actualRuntimeArchitecture Windows"
