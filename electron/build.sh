#!/bin/bash
set -e
echo "============================================"
echo "  Notionish Electron 打包工具"
echo "============================================"
echo ""

cd "$(dirname "$0")"

echo "[1/3] 安装依赖..."
npm install
echo "✅ 依赖安装完成"
echo ""

echo "[2/3] 打包..."
case "$(uname -s)" in
    Darwin)  npm run dist:mac ;;
    Linux)   npm run dist:linux ;;
    *)       echo "未知系统"; exit 1 ;;
esac
echo "✅ 打包完成"
echo ""

echo "[3/3] 输出文件在 electron/dist 目录下"
ls -la dist/*.dmg dist/*.AppImage 2>/dev/null || ls -la dist/
echo ""
echo "============================================"
echo "  打包完成！"
echo "============================================"