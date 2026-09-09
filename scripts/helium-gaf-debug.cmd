@echo off
setlocal
REM Double-click launcher for Helium GAF Debug mode
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0helium-gaf-debug.ps1" %*
if errorlevel 1 pause
