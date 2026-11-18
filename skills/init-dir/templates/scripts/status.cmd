@echo off
rem scripts\status.cmd: Windows form of ./scripts/status.sh (banker init-dir)
rem Exit: 0 done, 1 failed, 2 no settings, 3 Node 18 or later not found
setlocal
set "NODE_BIN=%NODE%"
rem node.exe from PATH only: cmd.exe looks for a bare name in the current folder (the project) first
rem quoted PATH entries ("C:\Program Files\nodejs") are not searched by %%~$PATH:, so search a copy without quotes
set "NODE_SEARCH=%PATH:"=%"
if "%NODE_BIN%"=="" for %%I in (node.exe) do set "NODE_BIN=%%~$NODE_SEARCH:I"
if "%NODE_BIN%"=="" (
  echo Node 18 or later is required: node.exe is not on PATH 1>&2
  exit /b 3
)
"%NODE_BIN%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
  echo Node 18 or later is required: "%NODE_BIN%" 1>&2
  exit /b 3
)
"%NODE_BIN%" "%~dp0lib\service.mjs" status %*
exit /b %ERRORLEVEL%
