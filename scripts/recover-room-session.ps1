param(
    [Parameter(Mandatory=$true)][Guid]$JobId,
    [ValidateSet('http://127.0.0.1:5173','http://localhost:5173')][string]$Address = 'http://127.0.0.1:5173'
)
$ErrorActionPreference = 'Stop'
$roomWorkspace = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $roomWorkspace
try {
    $recoveryBytes = New-Object byte[] 32
    $recoveryRandom = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $recoveryRandom.GetBytes($recoveryBytes) } finally { $recoveryRandom.Dispose() }
    $recoveryToken = [Convert]::ToBase64String($recoveryBytes).TrimEnd('=').Replace('+','-').Replace('/','_')
    $recoveryDigest = [System.Security.Cryptography.SHA256]::Create()
    try { $recoveryHash = -join ($recoveryDigest.ComputeHash([Text.Encoding]::UTF8.GetBytes($recoveryToken)) | ForEach-Object { $_.ToString('x2') }) }
    finally { $recoveryDigest.Dispose() }
    $recoverySql = @"
DELETE FROM room_session_recovery WHERE expires_at<=now();
INSERT INTO room_session_recovery(token_hash,owner,job_id,expires_at)
SELECT '$recoveryHash',owner,id,now()+interval '1 hour' FROM room_jobs WHERE id='$JobId'
RETURNING job_id;
"@
    $recoveryResult = $recoverySql | docker compose exec -T room-db psql -X -v ON_ERROR_STOP=1 -U rooms -d rooms -At
    if ($LASTEXITCODE -ne 0 -or $recoveryResult -notcontains $JobId.ToString()) { throw 'Room not found or recovery link could not be generated.' }
    Write-Output "$Address/#rooms?recover=$recoveryToken"
} finally { Pop-Location }
