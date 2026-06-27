@echo off
cd /d E:\project for cc\lmcode

echo ========================================
echo  LMCODE Desktop - 一键启动
echo ========================================
echo.

echo [1/4] 安装依赖...
call pnpm install >nul 2>&1
echo 完成 ✓

echo [2/4] 编译 workspace 包...
call pnpm run build:packages >nul 2>&1
echo 完成 ✓

echo [3/4] 构建 desktop...
cd apps\lmcode-desktop
call pnpm run build >nul 2>&1
echo 完成 ✓

echo [4/4] 启动 LMCODE...
echo.
echo 窗口即将打开...
start /B npx electron . --no-sandbox

echo.
echo LMCODE 已启动！托盘图标在系统栏。
echo 快捷键: Ctrl+Shift+L 显示窗口
echo.
pause
