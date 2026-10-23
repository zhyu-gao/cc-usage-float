@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 启动即退出（GPU process isn't usable）时用这个：绕开 Chromium GPU 沙箱
set CCUF_NO_SANDBOX=1
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --no-sandbox --disable-gpu
