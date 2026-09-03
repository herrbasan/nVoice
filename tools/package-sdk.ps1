# nVoice SDK packager — assembles release artifacts into dist/sdk/
#
# Usage:  powershell -File tools/package-sdk.ps1 [-Version 1.0.0]
#
# Produces:
#   dist/sdk/nvoice-sdk-<ver>.zip       core: nVoiceClient.js, nspeech-client.js, README
#                                       (the chat integration is ort-free — assistant wake
#                                       runs worker-side, dictation is button-gated)
#   dist/sdk/nvoice-sdk-full-<ver>.zip  + ort.js, ort-wasm-*.mjs/.wasm, silero_vad.onnx
#                                       (legacy local-VAD path only; ~40MB)
#   dist/sdk/loose/                     core files loose, for direct upload as
#                                       individual release assets
param([string]$Version = "1.0.0")

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$sdk  = Join-Path $root "sdk"
$out  = Join-Path (Join-Path $root "dist") "sdk"
$loose = Join-Path $out "loose"

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $loose -Force | Out-Null

$core = @("nVoiceClient.js", "nspeech-client.js", "README.md")
$extras = @("ort.js", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm",
            "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm",
            "silero_vad.onnx", "download-wasm.bat")

# Stage core
$stage = Join-Path $out "nvoice-sdk-$Version"
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($f in $core) {
    Copy-Item (Join-Path $sdk $f) (Join-Path $stage $f)
    Copy-Item (Join-Path $sdk $f) (Join-Path $loose $f)
}

# Version stamp into the staged README (loose copy too)
$stamp = "# nVoice SDK v$Version`n`n" + (Get-Content (Join-Path $sdk "README.md") -Raw)
Set-Content (Join-Path $stage "README.md") $stamp -Encoding UTF8
Set-Content (Join-Path $loose "README.md") $stamp -Encoding UTF8

Compress-Archive -Path "$stage\*" -DestinationPath (Join-Path $out "nvoice-sdk-$Version.zip") -Force

# Stage full
$stageFull = Join-Path $out "nvoice-sdk-full-$Version"
New-Item -ItemType Directory -Path $stageFull -Force | Out-Null
Copy-Item "$stage\*" $stageFull
foreach ($f in $extras) {
    $src = Join-Path $sdk $f
    if (Test-Path $src) { Copy-Item $src $stageFull } else { Write-Warning "missing optional file: $f" }
}
Compress-Archive -Path "$stageFull\*" -DestinationPath (Join-Path $out "nvoice-sdk-full-$Version.zip") -Force

Get-ChildItem $out | Select-Object Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) }} | Format-Table -AutoSize
Write-Host "artifacts in $out"
