@echo off
setlocal
node "%~dp0configure-openrouter.mjs" %*
exit /b %ERRORLEVEL%
