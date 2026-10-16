#!/usr/bin/env bash
# 安装 Ollama + 拉取两个图文分析模型（Debian 13，16GB 内存）
set -euo pipefail

echo "==> 安装 Ollama"
curl -fsSL https://ollama.com/install.sh | sh

echo "==> 启动 Ollama 服务（默认监听 127.0.0.1:11434，不对外暴露）"
systemctl enable --now ollama

echo "==> 拉取图文模型（约 2.4GB + 2GB，视网络耗时较长）"
ollama pull granite3.2-vision:2b
ollama pull qwen3-vl:2b

echo "==> 校验"
ollama list

echo "==> 完成。原生 11434 只监听本机，请勿改成 0.0.0.0。"
echo "    公网调用请走 ollaguard 鉴权代理（见 setup-ollaguard.sh）。"
