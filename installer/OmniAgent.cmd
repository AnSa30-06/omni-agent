@echo off
rem Launch Omni Agent using the bundled Node runtime.
setlocal
set "HERE=%~dp0"
set "PATH=%HERE%node;%PATH%"
"%HERE%node\node.exe" "%HERE%app\bin\omni-agent.mjs" %*
if errorlevel 1 (
  echo.
  echo Omni Agent exited with an error.
  echo Run "Check Omni Agent health" from the Start Menu to diagnose it.
  echo.
  pause
)
endlocal
