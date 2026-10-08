@echo off
rem Checks everything Hearth needs and prints a fix for each problem. doctor.bat -Force also applies the fixes it can.
cd /d "%~dp0"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Action doctor %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
