param([switch]$Gpu)
$ErrorActionPreference = 'Stop'
$roomWorkspace = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $roomWorkspace
try {
    if ($Gpu) {
        docker compose --profile room-gpu up -d --build web room-worker
    } else {
        docker compose --profile rooms up -d --build web
    }
    if ($LASTEXITCODE -ne 0) { throw 'Room services could not be started.' }
    Write-Host 'Room API: http://127.0.0.1:8003 (automatic camera alignment starts with the web app)'
    Write-Host 'Open http://127.0.0.1:5173/#pipelines. The web frontend runs in Docker.'
    if (-not $Gpu) { Write-Host 'Uploads are available; jobs stay queued until a GPU worker is started with -Gpu.' }
} finally { Pop-Location }
