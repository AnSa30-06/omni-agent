@echo off
rem Omni Agent - portable launcher.
setlocal
set "HERE=%~dp0"
if not exist "%HERE%node\node.exe" (
  echo Could not find the bundled Node runtime at "%HERE%node\node.exe".
  echo Extract the whole zip, keeping its folder structure, then run start.bat again.
  pause
  exit /b 1
)
set "PATH=%HERE%node;%PATH%"
"%HERE%node\node.exe" "%HERE%app\bin\omni-agent.mjs" %*
if errorlevel 1 pause
endlocal
