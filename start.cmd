@echo off
setlocal
cd /d "%~dp0"
set "READER_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%READER_NODE%" (
  "%READER_NODE%" scripts\launch.mjs
) else (
  node scripts\launch.mjs
)
if errorlevel 1 pause
