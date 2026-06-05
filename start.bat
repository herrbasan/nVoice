@echo off
:: nVoice launcher - uses the venv Python directly, no activation needed.
:: Run install.py first to create the venv and install dependencies.

setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "PYTHON=%ROOT%\venv\Scripts\python.exe"

if not exist "%PYTHON%" (
    echo ERROR: Virtual environment not found at %PYTHON%
    echo Run install.py first to set up the environment.
    pause
    exit /b 1
)

"%PYTHON%" "%ROOT%\run.py" %*
