@echo off
rem Updates Hearth: double-click me. Gets the newest version (git pull, or the ZIP from GitHub),
rem reinstalls packages, rebuilds and restarts it, with the settings you already chose. Your
rem workspace, password and settings (.hearth\) are not part of the download, so nothing of yours
rem is touched.
rem
rem Why the whole body is one ( ) block, and why install.ps1 runs from a copy in %TEMP%: cmd.exe
rem reads a .bat file bit by bit while it runs it, and the update rewrites this file and install.ps1.
rem A ( ) block is read in full before any of it runs, and `exit /b` at its end means cmd never
rem reads the replaced file again. PowerShell has the same problem with install.ps1.
setlocal EnableDelayedExpansion
(
  cd /d "%~dp0"
  set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
  if not exist "!PS!" set "PS=powershell"
  set "REPO=%~dp0"
  if "!REPO:~-1!"=="\" set "REPO=!REPO:~0,-1!"
  set "TMPPS=%TEMP%\hearth-update-%RANDOM%%RANDOM%.ps1"
  copy /y "%~dp0install.ps1" "!TMPPS!" >nul
  if not exist "!TMPPS!" (
    echo Could not copy install.ps1 into your temp folder.
    pause
    exit /b 1
  )
  "!PS!" -NoProfile -ExecutionPolicy Bypass -File "!TMPPS!" -Action update -Repo "!REPO!" %*
  set "RC=!ERRORLEVEL!"
  del "!TMPPS!" >nul 2>&1
  echo.
  if not "!RC!"=="0" echo The update did not finish ^(exit code !RC!^). Scroll up, or run doctor.bat.
  pause
  exit /b !RC!
)
