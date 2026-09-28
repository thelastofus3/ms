param([string]$Runtime = 'D:/CodexData/MasterProject/lhm')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path "$projectRoot/.tools/lhm-runtime/LHM/models/modeling_human_lrm.py")) {
    throw 'Clone the pinned LHM source first; see services/avatar/gaussian/LHM.md.'
}
$runtimePath = [IO.Path]::GetFullPath($Runtime)
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
New-Item -ItemType Directory -Force -Path "$runtimePath/pretrained_models/dense_sample_points" | Out-Null
New-Item -ItemType Directory -Force -Path "$projectRoot/.tools/lhm-runtime/pretrained_models" | Out-Null
$previousRuntime = $env:LHM_RUNTIME_DIR
try {
    $env:LHM_RUNTIME_DIR = $runtimePath
    $ErrorActionPreference = 'Continue' # Native stderr includes ordinary download progress.
    docker compose --project-directory $projectRoot --profile lhm run --rm avatar-lhm bash /experiment/setup-lhm.sh
    if ($LASTEXITCODE -ne 0) { throw 'LHM environment setup failed; inspect the command output.' }
} finally {
    $env:LHM_RUNTIME_DIR = $previousRuntime
}
