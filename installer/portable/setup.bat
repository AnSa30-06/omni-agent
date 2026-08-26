@echo off
rem Omni Agent - portable first-run setup.
setlocal
set "HERE=%~dp0"
set "PATH=%HERE%node;%PATH%"
echo.
echo Downloading the model gateway, agent and browser engine (about 4 GB).
echo.
"%HERE%node\node.exe" "%HERE%app\scripts\bootstrap.mjs" || (pause & exit /b 1)
"%HERE%node\node.exe" "%HERE%app\bin\omni-agent.mjs" setup
pause
endlocal
