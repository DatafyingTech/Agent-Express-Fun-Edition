@echo off
rem Stops Agent Express (Fun Edition) and removes its logon task, shortcuts and Tailscale share. Your workspace and this folder are kept.
cd /d "%~dp0"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Action uninstall %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
