[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('dir', 'nsis')]
  [string]$Target
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-NormalizedFullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Assert-StrictChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Child,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $parentFull = Get-NormalizedFullPath $Parent
  $childFull = Get-NormalizedFullPath $Child
  $prefix = $parentFull + [System.IO.Path]::DirectorySeparatorChar
  if (-not $childFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label is outside its verified parent: $childFull"
  }
  if ($childFull -eq $parentFull) {
    throw "$Label must not equal its parent."
  }
}

function Test-AsciiLocalPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  # Windows PowerShell 5.1 runs on .NET Framework, where
  # Path.IsPathFullyQualified is unavailable. IsPathRooted plus an explicit
  # root check gives us the local absolute-path guarantee needed here.
  if (-not [System.IO.Path]::IsPathRooted($Path)) { return $false }
  if ([string]::IsNullOrWhiteSpace([System.IO.Path]::GetPathRoot($Path))) { return $false }
  if ($Path.StartsWith('\\', [System.StringComparison]::Ordinal)) { return $false }
  return $Path -notmatch '[^\x20-\x7e]'
}

function Remove-VerifiedReparsePoint {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$TargetPath,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not (Test-Path -LiteralPath $TargetPath)) { return }
  Assert-StrictChildPath -Parent $Parent -Child $TargetPath -Label $Label
  $item = Get-Item -LiteralPath $TargetPath -Force
  if (-not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw "Refusing cleanup because $Label is not a reparse point: $TargetPath"
  }

  # Remove-Item can throw a NullReferenceException for junctions in Windows
  # PowerShell 5.1. The non-recursive .NET APIs remove only the link itself.
  if ($item.PSIsContainer) {
    [System.IO.Directory]::Delete($item.FullName, $false)
  } else {
    [System.IO.File]::Delete($item.FullName)
  }
  if (Test-Path -LiteralPath $TargetPath) {
    throw "Failed to remove verified ${Label}: $TargetPath"
  }
}

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function New-AsciiStage {
  param([Parameter(Mandatory = $true)][string]$Token)

  $candidateParents = [System.Collections.Generic.List[string]]::new()
  if (-not [string]::IsNullOrWhiteSpace($env:PERSONAL_TODO_ASCII_STAGE_ROOT)) {
    $candidateParents.Add($env:PERSONAL_TODO_ASCII_STAGE_ROOT)
  }
  $candidateParents.Add([System.IO.Path]::GetTempPath())
  if (-not [string]::IsNullOrWhiteSpace($env:SystemRoot)) {
    $candidateParents.Add((Join-Path $env:SystemRoot 'Temp'))
  }
  $workspaceDrive = [System.IO.Path]::GetPathRoot($script:WorkspaceRoot)
  if (-not [string]::IsNullOrWhiteSpace($workspaceDrive)) {
    $candidateParents.Add((Join-Path $workspaceDrive 'personal-todo-temp'))
  }

  $attempted = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($candidateParent in $candidateParents) {
    try {
      $parentFull = Get-NormalizedFullPath $candidateParent
      if (-not (Test-AsciiLocalPath $parentFull)) { continue }
      $base = Join-Path $parentFull 'personal-todo-packaging'
      $base = Get-NormalizedFullPath $base
      if (-not $attempted.Add($base)) { continue }
      New-Item -ItemType Directory -Path $base -Force | Out-Null
      $stage = Join-Path $base "personal-todo-package-$Token"
      Assert-StrictChildPath -Parent $base -Child $stage -Label 'staging directory'
      New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
      $marker = Join-Path $stage '.personal-todo-stage.json'
      [System.IO.File]::WriteAllText(
        $marker,
        (@{ token = $Token; kind = 'personal-todo-packaging-stage' } | ConvertTo-Json -Compress),
        [System.Text.UTF8Encoding]::new($false)
      )
      return [pscustomobject]@{ Base = $base; Path = $stage; Marker = $marker }
    } catch {
      Write-Verbose "Cannot use ASCII staging parent '$candidateParent': $($_.Exception.Message)"
    }
  }
  throw 'No writable, local, ASCII-only staging directory is available. Set PERSONAL_TODO_ASCII_STAGE_ROOT to a safe absolute ASCII path.'
}

function Remove-VerifiedTree {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$TargetPath,
    [Parameter(Mandatory = $true)][string]$Token,
    [Parameter(Mandatory = $true)][string]$MarkerName,
    [Parameter(Mandatory = $true)][string]$ExpectedKind
  )
  if (-not (Test-Path -LiteralPath $TargetPath)) { return }
  Assert-StrictChildPath -Parent $Parent -Child $TargetPath -Label 'cleanup target'
  $targetFull = Get-NormalizedFullPath $TargetPath
  $expectedLeaf = if ($ExpectedKind -eq 'personal-todo-packaging-stage') {
    "personal-todo-package-$Token"
  } else {
    ".incoming-$Token"
  }
  if ([System.IO.Path]::GetFileName($targetFull) -ne $expectedLeaf) {
    throw "Refusing cleanup because the directory name is unexpected: $targetFull"
  }
  $markerPath = Join-Path $targetFull $MarkerName
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw "Refusing cleanup because marker is missing: $targetFull"
  }
  $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
  if ($marker.token -ne $Token -or $marker.kind -ne $ExpectedKind) {
    throw "Refusing cleanup because marker does not match: $targetFull"
  }

  # Remove reparse points first so recursive cleanup cannot traverse a junction.
  $reparsePoints = @(
    Get-ChildItem -LiteralPath $targetFull -Force -Recurse -Attributes ReparsePoint -ErrorAction SilentlyContinue |
      Sort-Object { $_.FullName.Length } -Descending
  )
  foreach ($item in $reparsePoints) {
    Remove-VerifiedReparsePoint -Parent $targetFull -TargetPath $item.FullName -Label 'reparse point'
  }
  Remove-Item -LiteralPath $targetFull -Recurse -Force
}

function Publish-FileSafely {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$Token,
    [Parameter(Mandatory = $true)][string]$ReleaseRoot
  )
  Assert-StrictChildPath -Parent $ReleaseRoot -Child $Destination -Label 'release file'
  $partial = "$Destination.$Token.partial"
  $previous = "$Destination.$Token.previous"
  Assert-StrictChildPath -Parent $ReleaseRoot -Child $partial -Label 'release partial file'
  Assert-StrictChildPath -Parent $ReleaseRoot -Child $previous -Label 'release previous file'
  if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
  if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Force }
  Copy-Item -LiteralPath $Source -Destination $partial
  try {
    if ((Get-Sha256Hex -Path $Source) -ne (Get-Sha256Hex -Path $partial)) {
      throw "Copied release file failed SHA-256 verification: $Source"
    }
  } catch {
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    throw
  }
  $hadPrevious = Test-Path -LiteralPath $Destination
  try {
    if ($hadPrevious) { Move-Item -LiteralPath $Destination -Destination $previous }
    Move-Item -LiteralPath $partial -Destination $Destination
    if ((Get-Sha256Hex -Path $Source) -ne (Get-Sha256Hex -Path $Destination)) {
      throw "Published release file failed SHA-256 verification: $Destination"
    }
    if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Force }
  } catch {
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
    if (Test-Path -LiteralPath $previous) { Move-Item -LiteralPath $previous -Destination $Destination }
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    throw
  }
}

function Publish-PackagingOutput {
  param(
    [Parameter(Mandatory = $true)][string]$StageRelease,
    [Parameter(Mandatory = $true)][string]$Token,
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$ProductName,
    [Parameter(Mandatory = $true)][string]$InstallerPattern
  )
  if (-not (Test-Path -LiteralPath $StageRelease -PathType Container)) {
    throw "electron-builder did not create its release directory: $StageRelease"
  }
  $releaseRoot = Join-Path $script:WorkspaceRoot 'release'
  New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
  $incoming = Join-Path $releaseRoot ".incoming-$Token"
  Assert-StrictChildPath -Parent $releaseRoot -Child $incoming -Label 'incoming release directory'
  New-Item -ItemType Directory -Path $incoming | Out-Null
  $incomingMarker = Join-Path $incoming '.personal-todo-incoming.json'
  [System.IO.File]::WriteAllText(
    $incomingMarker,
    (@{ token = $Token; kind = 'personal-todo-release-incoming' } | ConvertTo-Json -Compress),
    [System.Text.UTF8Encoding]::new($false)
  )

  try {
    foreach ($item in Get-ChildItem -LiteralPath $StageRelease -Force) {
      Copy-Item -LiteralPath $item.FullName -Destination $incoming -Recurse
    }
    $incomingApp = Join-Path $incoming 'win-unpacked'
    $appExecutable = Join-Path $incomingApp "$ProductName.exe"
    $appAsar = Join-Path $incomingApp 'resources\app.asar'
    $nativeModule = Join-Path $incomingApp 'resources\app.asar.unpacked\node_modules\better-sqlite3\prebuilds\win32-x64.node'
    foreach ($required in @($appExecutable, $appAsar, $nativeModule)) {
      if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Packaged directory is incomplete; missing: $required"
      }
    }
    if ($Target -eq 'nsis') {
      $installers = @(Get-ChildItem -LiteralPath $incoming -File -Filter $InstallerPattern)
      if ($installers.Count -ne 1) {
        throw "Expected exactly one NSIS installer, found $($installers.Count)."
      }
    }

    $destinationApp = Join-Path $releaseRoot 'win-unpacked'
    $previousApp = Join-Path $releaseRoot ".previous-win-unpacked-$Token"
    Assert-StrictChildPath -Parent $releaseRoot -Child $destinationApp -Label 'unpacked release'
    Assert-StrictChildPath -Parent $releaseRoot -Child $previousApp -Label 'previous unpacked release'
    if (Test-Path -LiteralPath $previousApp) {
      throw "Unexpected previous release path already exists: $previousApp"
    }
    $hadPreviousApp = Test-Path -LiteralPath $destinationApp
    try {
      if ($hadPreviousApp) { Move-Item -LiteralPath $destinationApp -Destination $previousApp }
      Move-Item -LiteralPath $incomingApp -Destination $destinationApp
      if (-not (Test-Path -LiteralPath (Join-Path $destinationApp "$ProductName.exe") -PathType Leaf)) {
        throw 'Published unpacked application failed validation.'
      }
    } catch {
      if (Test-Path -LiteralPath $destinationApp) {
        # This path was created by this invocation and has an exact expected name.
        Remove-Item -LiteralPath $destinationApp -Recurse -Force
      }
      if (Test-Path -LiteralPath $previousApp) { Move-Item -LiteralPath $previousApp -Destination $destinationApp }
      throw
    }
    if (Test-Path -LiteralPath $previousApp) {
      # The previous path is an exact rename of release/win-unpacked on this invocation.
      Remove-Item -LiteralPath $previousApp -Recurse -Force
    }

    foreach ($file in Get-ChildItem -LiteralPath $incoming -File | Where-Object { $_.Name -ne '.personal-todo-incoming.json' }) {
      Publish-FileSafely -Source $file.FullName -Destination (Join-Path $releaseRoot $file.Name) -Token $Token -ReleaseRoot $releaseRoot
    }
  } finally {
    Remove-VerifiedTree -Parent $releaseRoot -TargetPath $incoming -Token $Token -MarkerName '.personal-todo-incoming.json' -ExpectedKind 'personal-todo-release-incoming'
  }
}

$script:WorkspaceRoot = Get-NormalizedFullPath (Join-Path $PSScriptRoot '..')
$packageJson = Join-Path $script:WorkspaceRoot 'package.json'
$outDirectory = Join-Path $script:WorkspaceRoot 'out'
$sourceNodeModules = Join-Path $script:WorkspaceRoot 'node_modules'
if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) { throw "package.json is missing: $packageJson" }
if (-not (Test-Path -LiteralPath $outDirectory -PathType Container)) { throw 'Build output is missing. Run npm run build first.' }
if (-not (Test-Path -LiteralPath $sourceNodeModules -PathType Container)) { throw 'node_modules is missing. Run npm ci first.' }
# Windows PowerShell 5.1 otherwise decodes a BOM-less UTF-8 package.json with
# the active ANSI code page. That corrupts a Chinese productName before JSON
# parsing and makes the release script fail before electron-builder starts.
$packageMetadata = Get-Content -LiteralPath $packageJson -Raw -Encoding UTF8 | ConvertFrom-Json
$productName = [string]$packageMetadata.build.productName
$artifactName = [string]$packageMetadata.build.win.artifactName
if ([string]::IsNullOrWhiteSpace($productName)) { throw 'build.productName must be configured.' }
if ([string]::IsNullOrWhiteSpace($artifactName)) { throw 'build.win.artifactName must be configured.' }
$installerPattern = $artifactName.Replace('${version}', '*').Replace('${arch}', 'x64').Replace('${ext}', 'exe')
$sourceIcon = Join-Path $script:WorkspaceRoot 'build\icon.ico'
if (-not (Test-Path -LiteralPath $sourceIcon -PathType Leaf)) { throw "Windows icon is missing: $sourceIcon" }

$token = [Guid]::NewGuid().ToString('N')
$stageInfo = New-AsciiStage -Token $token
$stageRoot = $stageInfo.Path
$nodeModulesJunction = Join-Path $stageRoot 'node_modules'
$previousCscSetting = $env:CSC_IDENTITY_AUTO_DISCOVERY
try {
  Copy-Item -LiteralPath $packageJson -Destination (Join-Path $stageRoot 'package.json')
  $packageLock = Join-Path $script:WorkspaceRoot 'package-lock.json'
  if (Test-Path -LiteralPath $packageLock -PathType Leaf) {
    Copy-Item -LiteralPath $packageLock -Destination (Join-Path $stageRoot 'package-lock.json')
  }
  Copy-Item -LiteralPath $outDirectory -Destination (Join-Path $stageRoot 'out') -Recurse
  $stageBuild = Join-Path $stageRoot 'build'
  New-Item -ItemType Directory -Path $stageBuild | Out-Null
  Copy-Item -LiteralPath $sourceIcon -Destination (Join-Path $stageBuild 'icon.ico')
  New-Item -ItemType Junction -Path $nodeModulesJunction -Target $sourceNodeModules | Out-Null

  $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
  $builderCli = Join-Path $nodeModulesJunction 'electron-builder\out\cli\cli.js'
  $electronDist = Join-Path $nodeModulesJunction 'electron\dist'
  foreach ($required in @($builderCli, (Join-Path $electronDist 'electron.exe'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required packaging file is missing: $required" }
  }
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  $builderArguments = @($builderCli)
  if ($Target -eq 'dir') {
    $builderArguments += '--dir'
  } else {
    $builderArguments += @('--win', 'nsis')
  }
  $builderArguments += "--config.electronDist=$electronDist"

  Write-Host "Packaging from ASCII staging directory: $stageRoot"
  Push-Location $stageRoot
  try {
    & $nodeExe @builderArguments
    if ($LASTEXITCODE -ne 0) { throw "electron-builder exited with code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  Publish-PackagingOutput -StageRelease (Join-Path $stageRoot 'release') -Token $token -Target $Target -ProductName $productName -InstallerPattern $installerPattern
  Write-Host "Packaging output published to: $(Join-Path $script:WorkspaceRoot 'release')"
} finally {
  if ($null -eq $previousCscSetting) {
    Remove-Item Env:CSC_IDENTITY_AUTO_DISCOVERY -ErrorAction SilentlyContinue
  } else {
    $env:CSC_IDENTITY_AUTO_DISCOVERY = $previousCscSetting
  }
  if (Test-Path -LiteralPath $nodeModulesJunction) {
    Remove-VerifiedReparsePoint -Parent $stageRoot -TargetPath $nodeModulesJunction -Label 'node_modules staging junction'
  }
  Remove-VerifiedTree -Parent $stageInfo.Base -TargetPath $stageRoot -Token $token -MarkerName '.personal-todo-stage.json' -ExpectedKind 'personal-todo-packaging-stage'
}
