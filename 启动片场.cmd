@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0.onset-local\bin\node.exe" (
  "%~dp0.onset-local\bin\node.exe" "%~dp0scripts\start-local.mjs" %*
) else (
  node "%~dp0scripts\start-local.mjs" %*
)
if errorlevel 1 pause
