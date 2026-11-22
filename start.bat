@echo off
cd /d "%~dp0"

set "PY="
where python >nul 2>&1 && set "PY=python"
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"

if not defined PY (
  echo Python not found. Install Python 3.13 and run: pip install -r requirements.txt
  pause
  exit /b 1
)

%PY% -c "import dettato" >nul 2>&1
if errorlevel 1 (
  echo dettato is not installed in %PY%.
  echo Run: %PY% -m pip install -r requirements.txt
  echo.
)

%PY% server.py --port 8765
pause
