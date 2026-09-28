param([switch]$SkipBlender)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolsRoot = Join-Path $projectRoot '.tools'
New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null

function Get-VerifiedArchive($Url, $Path, $Sha256) {
    if (-not (Test-Path -LiteralPath $Path)) {
        & curl.exe --fail --location --retry 2 --silent --show-error $Url --output $Path
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
    }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($actual -ne $Sha256) { throw "Checksum mismatch: $Path. Remove this archive and retry." }
}

if (-not $SkipBlender) {
    $archive = Join-Path $toolsRoot 'blender.zip'
    Get-VerifiedArchive 'https://download.blender.org/release/Blender4.5/blender-4.5.14-windows-x64.zip' $archive 'b9533d2397ac1984db4466fb23a7a4649391cca93f6e84209f9bcc60d071c8b9'
    $blenderExe = Join-Path $toolsRoot 'blender/blender-4.5.14-windows-x64/blender.exe'
    if (-not (Test-Path -LiteralPath $blenderExe)) {
        Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $toolsRoot 'blender')
    }
}

$revision = '7fcc8df56f26776923e0a825f4551c3c3779befe'
$mpfbRoot = Join-Path $toolsRoot 'mpfb2'
if (-not (Test-Path -LiteralPath $mpfbRoot)) {
    & git init $mpfbRoot
    if ($LASTEXITCODE -ne 0) { throw 'Cannot initialize MPFB checkout' }
    & git -C $mpfbRoot remote add origin https://github.com/makehumancommunity/mpfb2.git
    & git -C $mpfbRoot fetch --depth 1 origin $revision
    if ($LASTEXITCODE -ne 0) { throw 'Cannot fetch pinned MPFB revision' }
    & git -C $mpfbRoot checkout --detach FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Cannot check out MPFB' }
}
$actualRevision = & git -C $mpfbRoot rev-parse HEAD
if ($actualRevision -ne $revision) { throw "Expected MPFB $revision; found $actualRevision" }

$assetsArchive = Join-Path $toolsRoot 'system-assets.zip'
Get-VerifiedArchive 'https://files2.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip' $assetsArchive 'b542127a8e25547c7c29c19f2d1d2adb9a664c80396ecd694095dbc8028a0107'
$assetsRoot = Join-Path $toolsRoot 'system-assets'
if (-not (Test-Path -LiteralPath $assetsRoot)) {
    Expand-Archive -LiteralPath $assetsArchive -DestinationPath $assetsRoot
}
Write-Output 'Avatar toolchain is ready in .tools (no global Blender profile changes).'
