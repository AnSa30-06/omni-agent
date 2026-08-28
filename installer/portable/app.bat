@echo off
rem Omni Agent - open the desktop app (portable).
rem
rem Same as start.bat but opens the window instead of the terminal interface.
rem
rem OmniAgent.exe next to this file is the real application and needs no console
rem at all, so prefer it. This script stays as the visible-console fallback for
rem a zip that predates the exe, or for reading an error the exe swallows.
setlocal
set "HERE=%~dp0"
if exist "%HERE%OmniAgent.exe" (
  start "" "%HERE%OmniAgent.exe"
  exit /b 0
)
if not exist "%HERE%node\node.exe" (
  echo Could not find the bundled Node runtime at "%HERE%node\node.exe".
  echo Extract the whole zip, keeping its folder structure, then run app.bat again.
  pause
  exit /b 1
)
set "PATH=%HERE%node;%PATH%"
title Omni Agent - keep this window open
"%HERE%node\node.exe" "%HERE%app\bin\omni-agent.mjs" ui
if errorlevel 1 pause
endlocal
