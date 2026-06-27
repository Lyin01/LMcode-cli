# LMCODE 桌面端一键发布脚本
# 作用：把安装包 + 更新清单发布到 GitHub Releases（Lyin01/LMcode-desktop）。
# 你的 token 只在本次运行中临时使用，不会写入任何文件、也不会显示在屏幕上。

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8

# 切到桌面端项目目录（本脚本在 scripts\ 下，上一级就是项目根）
Set-Location (Split-Path $PSScriptRoot -Parent)

Write-Host ''
Write-Host '========== LMCODE 桌面端 · 一键发布 ==========' -ForegroundColor Cyan
Write-Host '提示：请使用一个【全新】的 GitHub Token。' -ForegroundColor Yellow
Write-Host '      之前贴到聊天里的那个请务必先去 GitHub 撤销！' -ForegroundColor Yellow
Write-Host '      https://github.com/settings/tokens' -ForegroundColor DarkYellow
Write-Host ''

# 安全读取 token：输入时屏幕不显示，也不会留在历史里
$secure = Read-Host -AsSecureString '请粘贴你的新 GitHub Token，然后按回车（输入不可见）'
$token = [System.Net.NetworkCredential]::new('', $secure).Password

if ([string]::IsNullOrWhiteSpace($token)) {
  Write-Host '没有检测到 token，已取消发布。' -ForegroundColor Red
  exit 1
}

$env:GH_TOKEN = $token
try {
  Write-Host ''
  Write-Host '正在打包并发布到 GitHub Releases……（首次会下载 Electron，请耐心等待几分钟）' -ForegroundColor Cyan
  pnpm run release
  Write-Host ''
  Write-Host '✅ 发布完成！去这里看看你的安装包：' -ForegroundColor Green
  Write-Host '   https://github.com/Lyin01/LMcode-desktop/releases' -ForegroundColor Green
}
finally {
  # 用完立刻清掉，token 不留痕
  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
  $token = $null
  $secure = $null
}
