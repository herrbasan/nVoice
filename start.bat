@echo off
:: nVoice v3 launcher — starts the Node.js management layer.
:: Node spawns per-engine Python workers as needed.
:: Run install.py first to set up Python venvs, and `cd server && npm install` for Node deps.

setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "NODE=%ROOT%\server\node_modules\.bin\node"
if not exist "%NODE%" set "NODE=node"

if not exist "%ROOT%\server\node_modules" (
    echo ERROR: Node dependencies not found. Run: cd server ^&^& npm install
    pause
    exit /b 1
)

"%NODE%" "%ROOT%\server\index.js" %*
