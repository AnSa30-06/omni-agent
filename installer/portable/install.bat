@echo off
rem Convenience wrapper so a double-click works without touching ExecutionPolicy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause
