param([switch]$Build, [string]$CheckoutPath = '.tools/hugs-runtime',
    [string]$SimpleKnnMirror = '')
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Checkout = [System.IO.Path]::GetFullPath((Join-Path $Root $CheckoutPath))
$Revision = '86ebe5522a384fc553f07f090b63a76dd4af8d33'
function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    # Windows PowerShell represents redirected native stderr as error records.
    $ErrorActionPreference = 'Continue'
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}
if (-not (Test-Path -LiteralPath $Checkout)) {
    Invoke-Checked git @('clone', 'https://github.com/apple/ml-hugs.git', $Checkout)
    Invoke-Checked git @('-C', $Checkout, 'checkout', '--detach', $Revision)
}
$Actual = & git -C $Checkout rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $Actual -ne $Revision) {
    throw "Existing checkout is not HUGS $Revision. It has been left unchanged: $Checkout"
}
$Dirty = & git -C $Checkout status --porcelain
if ($LASTEXITCODE -ne 0 -or $Dirty) { throw 'HUGS checkout has local changes; preserve them before bootstrap.' }
if ($SimpleKnnMirror) {
    # Only the transport changes: git still requires the exact upstream gitlink commit.
    Invoke-Checked git @('-C', $Checkout, 'config', 'submodule.submodules/simple-knn.url', $SimpleKnnMirror)
}
Invoke-Checked git @('-C', $Checkout, 'submodule', 'update', '--init', '--recursive')
if ($Build) {
    Invoke-Checked docker @('build', '--progress=plain', '-t', 'avatar-hugs:86ebe55',
        '-f', (Join-Path $Root 'services/avatar/gaussian/Dockerfile'), $Checkout)
}
Write-Output "HUGS sources ready at $Checkout ($Revision)"
