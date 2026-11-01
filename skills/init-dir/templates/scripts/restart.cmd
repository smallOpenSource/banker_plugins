@echo off
rem scripts\restart.cmd: Windows form of ./scripts/restart.sh (banker init-dir)
rem Exit: 0 done, 1 failed, 2 no settings, 3 Node 18 or later not found
setlocal
set "NODE_BIN=%NODE%"
if "%NODE_BIN%"=="" set "NODE_BIN=node"
"%NODE_BIN%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
  echo Node 18 or later is required: %NODE_BIN% 1>&2
  exit /b 3
)
"%NODE_BIN%" "%~dp0lib\service.mjs" restart %*
exit /b %ERRORLEVEL%
