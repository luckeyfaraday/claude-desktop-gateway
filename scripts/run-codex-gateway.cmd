@echo off
setlocal
set "ROOT_DIR=%~dp0.."
node "%ROOT_DIR%\scripts\run-codex-gateway.mjs" %*
