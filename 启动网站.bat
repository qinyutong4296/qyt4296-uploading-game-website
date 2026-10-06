@echo off
chcp 65001 >nul
cd /d "%~dp0"
title GameHub
echo.
echo ========================================
echo   Game Website - starting...
echo ========================================
echo.

where powershell >nul 2>&1
if errorlevel 1 (
  echo [ERROR] PowerShell not found.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo Install LTS from https://nodejs.org then retry.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0runtime\hub-lifecycle.ps1" -Action start
set "ERR=%ERRORLEVEL%"

REM 网站曾成功启动后又正常关闭：不暂停，直接关窗
if exist "%~dp0runtime\hub.clean-exit" (
  del "%~dp0runtime\hub.clean-exit" >nul 2>&1
  if exist "%~dp0runtime\hub.started" del "%~dp0runtime\hub.started" >nul 2>&1
  exit /b 0
)
if exist "%~dp0runtime\hub.started" (
  del "%~dp0runtime\hub.started" >nul 2>&1
  exit /b 0
)

if not "%ERR%"=="0" (
  echo.
  echo [FAIL] Start failed. ErrorLevel=%ERR%
  echo Check runtime\start-last.log if present.
  pause
  exit /b %ERR%
)
exit /b 0
