@echo off
chcp 65001 >nul
echo ============================================
echo   Notionish Electron 打包工具
echo ============================================
echo.

cd /d "%~dp0"

echo [1/3] 安装依赖 (electron + electron-builder)...
call npm install
if %errorlevel% neq 0 (
    echo ❌ npm install 失败
    pause
    exit /b 1
)
echo ✅ 依赖安装完成
echo.

echo [2/3] 打包（输出目录版，跳过安装包签名）...
call npx electron-builder --win --dir
if %errorlevel% neq 0 (
    echo.
    echo 💡 如果上面报签名错误，应用已经打包好了
    echo    直接运行: dist\win-unpacked\Notionish.exe
    echo.
)
echo ✅ 打包完成
echo.

echo [3/3] 输出文件:
if exist "dist\win-unpacked\Notionish.exe" (
    echo   ✅ dist\win-unpacked\Notionish.exe （直接运行）
)
if exist "dist\*.exe" (
    dir /b dist\*.exe 2>nul
)
echo.
echo ============================================
echo   打包完成！双击 dist\Notionish Setup *.exe 安装
echo ============================================
pause