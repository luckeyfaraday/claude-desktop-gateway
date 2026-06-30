@echo off
setlocal
node "%~dp0restore-claude.mjs" %*
exit /b %ERRORLEVEL%
