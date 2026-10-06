@echo off
rem Review Reply Helper - stop background server (Windows)
cd /d "%~dp0.."
node scripts\launch.js --stop
timeout /t 2 >nul
