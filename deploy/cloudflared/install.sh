#!/usr/bin/env bash
# 安装 cloudflared 并注册为 systemd 服务（Debian 13）
set -euo pipefail

echo "==> 安装 cloudflared"
# 下载官方二进制（x86_64）
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  CF_ARCH="amd64" ;;
  aarch64) CF_ARCH="arm64" ;;
  *) echo "不支持的架构: $ARCH"; exit 1 ;;
esac
CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}"
wget -O /usr/local/bin/cloudflared "$CF_URL"
chmod +x /usr/local/bin/cloudflared
/usr/local/bin/cloudflared --version

echo "==> 注册为 systemd 服务"
cat > /etc/systemd/system/cloudflared.service <<'EOF'
[Unit]
Description=Cloudflare Tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/local/bin/cloudflared tunnel --config /etc/cloudflared/config.yml run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

mkdir -p /etc/cloudflared
cp "$(dirname "$0")/config.yml" /etc/cloudflared/config.yml

systemctl daemon-reload
systemctl enable cloudflared
echo "==> 完成。若用本地配置模式，先执行："
echo "    cloudflared tunnel create qingyi   # 生成 credentials + UUID"
echo "    把 UUID 填进 /etc/cloudflared/config.yml 的 tunnel 字段"
echo "    再 systemctl start cloudflared"
echo "==> 若用远程管理模式（Token），改用："
echo "    cloudflared service install <TOKEN>"
