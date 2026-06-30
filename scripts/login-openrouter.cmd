@echo off
setlocal
node "%~dp0..\src\openrouter-oauth-login.mjs" %*
exit /b %ERRORLEVEL%
