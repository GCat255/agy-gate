@echo off
rem agy-opencode-router Windows shim
rem ASCII only: cmd.exe parses .cmd files in the OEM codepage.
setlocal
set "IMPL=%~dp0agy-opencode-router.mjs"
set "NODE=node"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%IMPL%" %*
exit /b %ERRORLEVEL%
