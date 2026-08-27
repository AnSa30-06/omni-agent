@echo off
rem Open the Omni Agent desktop app.
rem
rem This is what the Desktop and Start Menu shortcuts point at. It starts the
rem gateway, the agent server and the interface, then opens a window. The
rem console it runs in is minimised rather than hidden: closing it stops the
rem agent, so the user needs to be able to find it again.
setlocal
set "HERE=%~dp0"
set "PATH=%HERE%node;%PATH%"
title Omni Agent - keep this window open
"%HERE%node\node.exe" "%HERE%app\bin\omni-agent.mjs" ui
if errorlevel 1 (
  echo.
  echo Omni Agent could not start.
  echo Run "Check Omni Agent health" from the Start Menu to diagnose it.
  echo.
  pause
)
endlocal
