@echo off
rem Open the Omni Agent desktop app.
rem
rem The Desktop and Start Menu shortcuts point at OmniAgent.exe; this is the
rem same app started in a VISIBLE console, which is what "Omni Agent in a
rem terminal" runs. It exists so a failure the exe swallows can be read on
rem screen. It starts the gateway, the agent server and the interface, then
rem opens a window. Closing this console stops the agent.
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
