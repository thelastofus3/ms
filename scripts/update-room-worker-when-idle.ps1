$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
Write-Output 'Waiting for room reconstruction to finish before applying the worker update.'
$deadline = (Get-Date).AddHours(12)
while ((Get-Date) -lt $deadline) {
    $active = & docker compose exec -T room-db psql -U rooms -d rooms -Atc "SELECT count(*) FROM room_jobs WHERE state = 'QUEUED' OR (state = 'RUNNING' AND lease_until > now());"
    if ($LASTEXITCODE -eq 0 -and ($active | Out-String).Trim() -eq '0') {
        & docker compose --profile room-gpu up -d --no-deps room-worker
        if ($LASTEXITCODE -ne 0) { throw 'Could not apply the room worker update.' }
        Write-Output 'Room worker updated while idle.'
        exit 0
    }
    Start-Sleep -Seconds 10
}
throw 'Worker was not idle within 12 hours; the running reconstruction was left untouched.'
