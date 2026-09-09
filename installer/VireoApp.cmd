@echo off
rem Open the Vireo desktop app.
rem
rem The Desktop and Start Menu shortcuts point at Vireo.exe; this is the
rem same app started in a VISIBLE console, which is what "Vireo in a
rem terminal" runs. It exists so a failure the exe swallows can be read on
rem screen. It starts the gateway, the agent server and the interface, then
rem opens a window. Closing this console stops the agent.
setlocal
set "HERE=%~dp0"
set "PATH=%HERE%node;%PATH%"
title Vireo - keep this window open
"%HERE%node\node.exe" "%HERE%app\bin\vireo.mjs" ui
if errorlevel 1 (
  echo.
  echo Vireo could not start.
  echo Run "Check Vireo health" from the Start Menu to diagnose it.
  echo.
  pause
)
endlocal
