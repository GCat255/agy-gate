#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> agy-gate + occ 一键安装与配置"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未检测到 Node.js (>= 24.0.0)，请先安装 Node.js 24+ 后重试。" >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "错误：当前 Node.js 主版本为 $NODE_MAJOR，需要 >= 24。" >&2
  exit 1
fi

chmod +x \
  "$REPO_ROOT/bin/occ" \
  "$REPO_ROOT/bin/occ.mjs" \
  "$REPO_ROOT/bin/agy-gate" \
  "$REPO_ROOT/bin/agy-gate.mjs" \
  "$REPO_ROOT/scripts/install.sh"

cd "$REPO_ROOT"

echo "[1/3] 链接全局命令 occ 与 agy-gate..."
if ! npm link; then
  echo "npm link 未成功，改用 npm install -g . ..."
  npm install -g .
fi

echo "[2/3] 检测并补齐 @openchamber/web / @opencode/cli，绑定网关、agy-quota 扩展与 MCP..."
node ./bin/agy-gate.mjs setup --install-deps

echo "[3/3] 环境诊断 (doctor)..."
node ./bin/agy-gate.mjs doctor

echo ""
echo "完成！现在可在任意新终端运行 \`occ\` 启动服务与管理授权。"
