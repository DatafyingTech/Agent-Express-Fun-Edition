@echo off
rem Agent Express (Fun Edition) installer: double-click me. Options go through to install.ps1, e.g. install.bat -Port 4700
rem PowerShell's execution policy is bypassed for this one command only, so no Windows security
rem setting is ever changed. PowerShell is called by its full path: with a damaged PATH, a bare
rem "powershell" fails with exit code 9009, which looks like a bug in the app and isn't.
cd /d "%~dp0"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo The install did not finish ^(exit code %RC%^). Scroll up to see what went wrong,
  echo or double-click doctor.bat for a checklist with fixes.
)
echo.
pause
exit /b %RC%
