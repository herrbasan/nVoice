@echo off
:: Download ONNX Runtime Web WASM files for client-side VAD.
:: These are large (23MB+) and not committed to git.
:: Run this after cloning, or after upgrading onnxruntime-web version.

setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "ORT_VER=1.21.0"
set "SDK_DIR=%ROOT%sdk"
set "BASE=https://cdn.jsdelivr.net/npm/onnxruntime-web@%ORT_VER%/dist"

echo Downloading ONNX Runtime Web %ORT_VER% WASM files...

curl -sL "%BASE%/ort-wasm-simd-threaded.jsep.wasm" -o "%SDK_DIR%\ort-wasm-simd-threaded.jsep.wasm"
curl -sL "%BASE%/ort-wasm-simd-threaded.jsep.mjs" -o "%SDK_DIR%\ort-wasm-simd-threaded.jsep.mjs"
curl -sL "%BASE%/ort-wasm-simd-threaded.wasm" -o "%SDK_DIR%\ort-wasm-simd-threaded.wasm"
curl -sL "%BASE%/ort-wasm-simd-threaded.mjs" -o "%SDK_DIR%\ort-wasm-simd-threaded.mjs"

echo Done. Files in %SDK_DIR%:
dir /b "%SDK_DIR%\ort-wasm*"
