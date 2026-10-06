@echo off
cd /d "%~dp0"

REM Hand off via ASCII-only VBS path so CMD codepage cannot corrupt the filename.
REM Auto-close from the server uses the same run-hidden.vbs + hub-lifecycle.ps1 path.
where wscript >nul 2>&1
if not errorlevel 1 (
  wscript //nologo "%~dp0runtime\run-hidden.vbs" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0runtime\hub-lifecycle.ps1" -Action stop -Quiet
  exit /b 0
)

where powershell >nul 2>&1
if not errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0runtime\hub-lifecycle.ps1" -Action stop -Quiet
  exit /b 0
)

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8080" ^| findstr "LISTENING"') do (
  rem fallback only: prefer hub-lifecycle.ps1; do not kill by window title
  taskkill /F /T /PID %%a >nul 2>&1
)
exit /b 0
