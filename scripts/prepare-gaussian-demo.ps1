param([string]$PackagePath = '.runtime/hugs-output/browser-lab')
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Source = Join-Path $Root $PackagePath
$Destination = Join-Path $Root 'apps/web/public/gaussian-demo'
$Files = @('manifest.json', 'avatar.splat', 'indices.bin', 'weights.bin')
foreach ($Name in $Files) {
    if (-not (Test-Path -LiteralPath (Join-Path $Source $Name))) {
        throw "Gaussian package missing: $Source/$Name. Run the HUGS browser exporter documented in services/avatar/gaussian/README.md."
    }
}
if (Test-Path -LiteralPath $Destination) {
    foreach ($Name in $Files) {
        $Existing = Join-Path $Destination $Name
        if (-not (Test-Path -LiteralPath $Existing) -or
            (Get-FileHash -LiteralPath $Existing).Hash -ne (Get-FileHash -LiteralPath (Join-Path $Source $Name)).Hash) {
            throw "Existing demo differs; it was left unchanged: $Destination"
        }
    }
} else {
    New-Item -ItemType Directory -Path $Destination | Out-Null
    foreach ($Name in $Files) { Copy-Item -LiteralPath (Join-Path $Source $Name) -Destination $Destination }
}
Write-Output "Photographic demo ready: $Destination"
