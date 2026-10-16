#!/usr/bin/env bash
# 安装 ollaguard（Ollama Bearer-Token 鉴权代理）+ 生成普通 API Key
set -euo pipefail

MASTER_KEY="${1:-}"
if [ -z "$MASTER_KEY" ]; then
  echo "用法: $0 <MASTER_KEY>"
  echo "  MASTER_KEY 是代理的管理密钥（强随机值），用于生成/管理普通 key。"
  exit 1
fi

echo "==> 安装 uv"
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

echo "==> 克隆并安装 ollaguard"
if [ -d /opt/ollaguard ]; then
  echo "  /opt/ollaguard 已存在，跳过 clone"
else
  git clone https://gitcode.com/Neila/ollaguard.git /opt/ollaguard
fi
cd /opt/ollaguard
uv sync

echo "==> 写 systemd 服务（含 master key）"
sed "s#REPLACE_WITH_STRONG_MASTER_KEY#${MASTER_KEY}#g" \
  "$(dirname "$0")/../systemd/ollaguard.service" > /etc/systemd/system/ollaguard.service
systemctl daemon-reload
systemctl enable --now ollaguard

echo "==> 等待服务就绪"
sleep 3

echo "==> 生成普通 API Key（前端用它，不要用 master key）"
curl -s -X POST http://localhost:4000/key/generate \
  -H "Authorization: Bearer ${MASTER_KEY}"
echo ""

echo "==> 完成。请把上面返回的普通 key 配置到 deploy/worker/ollama-proxy 的 secret："
echo "    cd deploy/worker/ollama-proxy && wrangler secret put OLLAMA_API_KEY"
