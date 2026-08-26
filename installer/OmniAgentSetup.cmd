@echo off
rem First-run setup: installs the model gateway, OpenCode and the browser engine.
setlocal
set "HERE=%~dp0"
set "PATH=%HERE%node;%PATH%"
title Omni Agent Setup
echo.
echo ==================================================================
echo   Omni Agent - first-time setup
echo ==================================================================
echo.
echo   This downloads the model gateway, the agent and a browser engine.
echo   It is a few gigabytes and can take 10-30 minutes on a slow line.
echo   You can close this window and re-run "Set up Omni Agent" later.
echo.
"%HERE%node\node.exe" "%HERE%app\scripts\bootstrap.mjs"
if errorlevel 1 (
  echo.
  echo   Setup did not finish. See the messages above.
  echo.
  pause
  exit /b 1
)
"%HERE%node\node.exe" "%HERE%app\bin\omni-agent.mjs" setup
echo.
pause
endlocal
