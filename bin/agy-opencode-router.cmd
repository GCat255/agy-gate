@echo off
rem agy-opencode-router Windows shim
rem ASCII only: cmd.exe parses .cmd files in the OEM codepage.
setlocal
set "IMPL=%~dp0agy-opencode-router.mjs"
set "NODE="
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 set "NODE=node"
if not defined NODE if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE set "NODE=node"
"%NODE%" "%IMPL%" %*
exit /b %ERRORLEVEL%
