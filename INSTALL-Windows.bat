@echo off
rem Review Reply Helper - first-time setup: installs components and creates a desktop icon
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is required. Opening the download page...
  echo     Install the LTS version, then run INSTALL-Windows.bat again.
  start "" https://nodejs.org/ko/download
  pause
  exit /b 1
)
node --disable-warning=ExperimentalWarning scripts\launch.js --install
pause
