@echo off
setlocal
cd /d "%~dp0"

title SpaceHolder balance tool
echo Starting the balance tool...
echo Open http://127.0.0.1:8766 in your browser.
echo Close this window to stop the server.
echo.

rem Free port 8766 if a previous instance is still listening
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":8766 .*LISTENING"') do (
  echo Port 8766 is busy ^(PID %%P^). Stopping old process...
  taskkill /F /PID %%P >nul 2>&1
)

node server.mjs --open

echo.
echo Server stopped.
pause
