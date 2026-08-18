@echo off
chcp 65001 >nul
title Notionish 桌面版（开发模式）
echo ============================================
echo   Notionish 桌面版启动器
echo   （使用 Electron 开发模式，无需打包）
echo ============================================
echo.
cd /d "%~dp0electron"

REM 检查 electron 二进制是否就绪
if not exist "node_modules\electron\dist\electron.exe" (
    echo [1/3] 首次运行：安装依赖（需联网下载 Electron ~110MB）...
    call npm install --registry=https://registry.npmmirror.com
    if errorlevel 1 (
        echo ❌ 依赖安装失败，请检查网络后重试
        pause
        exit /b 1
    )
    echo ✅ 依赖安装完成
)

echo [2/3] 启动 Notionish...
echo 提示：窗口打开前请保持本窗口开启（服务器由本窗口托管）
echo 关闭本窗口 = 退出应用
echo.
call npm start

echo.
echo 应用已退出。
pause
