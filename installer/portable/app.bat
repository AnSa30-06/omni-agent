@echo off
rem Omni Agent - open the desktop app (portable).
rem
rem Same as start.bat but opens the window instead of the terminal interface.
rem Keep this console window open: closing it stops the agent.
setlocal
set "HERE=%~dp0"
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
