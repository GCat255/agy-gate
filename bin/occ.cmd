@echo off
rem occ Windows shim -- OpenChamber terminal launcher
rem ASCII only: cmd.exe parses .cmd files in the OEM codepage.
setlocal
set "IMPL=%~dp0occ.mjs"
set "NODE="
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 set "NODE=node"
if not defined NODE if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE set "NODE=node"
"%NODE%" "%IMPL%" %*
exit /b %ERRORLEVEL%
