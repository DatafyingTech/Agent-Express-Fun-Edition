@echo off
rem Sets a new sign-in password for Hearth (press Enter at the prompt for a generated one), and restarts it.
cd /d "%~dp0"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Action password %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
