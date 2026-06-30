@echo off
setlocal
node "%~dp0run-openrouter-gateway.mjs" %*
exit /b %ERRORLEVEL%
