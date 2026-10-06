@echo off
rem Review Reply Helper - double-click launcher (Windows)
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is required. Opening the download page...
  echo     Install the LTS version, then run this again.
  start "" https://nodejs.org/ko/download
  pause
  exit /b 1
)
node --disable-warning=ExperimentalWarning scripts\launch.js %*
if errorlevel 1 pause
