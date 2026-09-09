@echo off
rem Launch Vireo using the bundled Node runtime.
setlocal
set "HERE=%~dp0"
set "PATH=%HERE%node;%PATH%"
"%HERE%node\node.exe" "%HERE%app\bin\vireo.mjs" %*
if errorlevel 1 (
  echo.
  echo Vireo exited with an error.
  echo Run "Check Vireo health" from the Start Menu to diagnose it.
  echo.
  pause
)
endlocal
