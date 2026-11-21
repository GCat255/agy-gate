$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

Write-Host "==> agy-opencode-router + occ 一键安装与配置" -ForegroundColor Cyan

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Error "未检测到 Node.js (>= 24.0.0)。请先安装 Node.js 24+ (例如: winget install OpenJS.NodeJS.LTS) 后重试。"
  exit 1
}

$nodeMajor = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 24) {
  Write-Error "当前 Node.js 主版本为 $nodeMajor，需要 >= 24。请升级 Node.js 后重试。"
  exit 1
}

$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) {
  Write-Error "未检测到 npm，请确认 Node.js 安装完整。"
  exit 1
}

Push-Location $RepoRoot
try {
  Write-Host "[1/3] 链接全局命令 occ 与 agy-opencode-router..."
  & npm link
  if ($LASTEXITCODE -ne 0) {
    Write-Host "npm link 未成功，改用 npm install -g . ..." -ForegroundColor Yellow
    & npm install -g .
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }

  Write-Host "[2/3] 检测并补齐 @openchamber/web / @opencode/cli，绑定网关、agy-quota 扩展与 MCP..."
  & node .\bin\agy-opencode-router.mjs setup --install-deps
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Write-Host "[3/3] 环境诊断 (doctor)..."
  & node .\bin\agy-opencode-router.mjs doctor
} finally {
  Pop-Location
}

Write-Host "`n完成！现在可在任意新终端运行 occ 启动服务与管理授权。" -ForegroundColor Green
