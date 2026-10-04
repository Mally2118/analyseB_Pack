@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Для запуска установите Node.js: https://nodejs.org/
  pause
  exit /b 1
)
echo Откройте http://127.0.0.1:4173 в браузере.
echo Для остановки сервера нажмите Ctrl+C.
node server.mjs
pause
