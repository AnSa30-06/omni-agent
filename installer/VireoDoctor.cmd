@echo off
rem The health check, in a console that STAYS OPEN.
rem
rem The Start Menu entry used to run node.exe directly, so the window
rem closed on the same millisecond the report was printed and nobody could
rem read it. Every error message in this product points at this shortcut,
rem so it has to be readable.
setlocal
set "HERE=%~dp0"
set "PATH=%HERE%node;%PATH%"
title Vireo - health check
echo.
echo   Checking Vireo. This takes about a minute - it really does
echo   start the browser and ask a model a question.
echo.
"%HERE%node\node.exe" "%HERE%app\bin\vireo.mjs" doctor
echo.
pause
endlocal
