@echo off
REM Tracker Studio 启动器（Windows）
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo 没有找到 python，请先安装 Python 3.9+ 并勾选 "Add to PATH"
  pause
  exit /b 1
)
python tracker_studio.py --open %*
if errorlevel 1 pause
