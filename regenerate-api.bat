@echo off
chcp 65001 >nul
title 重新生成 GitHub Pages 静态数据
echo ========================================
echo   清逸的博客 - 静态数据一键重新生成
echo ========================================
echo.

set PY="C:\Users\shaoj\AppData\Local\Programs\Python\Python310\python.exe"
if not exist %PY% (
  where python >nul 2>nul
  if errorlevel 1 (
    echo [错误] 未找到 Python，请安装 Python 3 后重试
    pause
    exit /b 1
  )
  set PY=python
)

%PY% "%~dp0regenerate-api.py"
if errorlevel 1 (
  echo.
  echo [失败] 静态数据生成失败，请检查 admin/data/admin.db 是否存在
  pause
  exit /b 1
)

echo.
echo [完成] api/ 静态数据已更新，执行 git add/commit/push 后 GitHub Pages 自动生效
pause
