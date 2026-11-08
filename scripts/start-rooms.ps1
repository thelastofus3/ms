param([switch]$Gpu)
$ErrorActionPreference = 'Stop'
$roomWorkspace = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $roomWorkspace
try {
    if ($Gpu) {
        docker compose --profile room-gpu up -d --build web room-worker avatar-worker
    } else {
        docker compose --profile rooms up -d --build web
    }
    if ($LASTEXITCODE -ne 0) { throw 'Room services could not be started.' }
    Write-Host 'Room API: http://127.0.0.1:8003 (automatic camera alignment starts with the web app)'
    Write-Host 'Open http://127.0.0.1:5173/#pipelines. The web frontend runs in Docker.'
    if (-not $Gpu) { Write-Host 'Gaussian PLY imports run on the CPU. Photo/video reconstruction jobs wait for a GPU worker started with -Gpu.' }
} finally { Pop-Location }
