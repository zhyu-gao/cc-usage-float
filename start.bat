@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo 首次运行，先安装依赖...
  call npm install --no-audit --no-fund
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
