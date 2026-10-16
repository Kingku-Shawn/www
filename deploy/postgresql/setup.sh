#!/usr/bin/env bash
# 安装 PostgreSQL + 初始化业务库（Debian 13）
set -euo pipefail

DB_PASSWORD="${1:-}"
if [ -z "$DB_PASSWORD" ]; then
  echo "用法: $0 <DB_PASSWORD>"
  echo "  DB_PASSWORD 是业务库用户 qingyi 的强密码。"
  exit 1
fi

echo "==> 安装 PostgreSQL"
apt update
apt install -y postgresql postgresql-contrib

echo "==> 启动并开机自启"
systemctl enable --now postgresql

echo "==> 写入初始化 SQL 并执行"
SQL_DIR="$(dirname "$0")"
sed "s/REPLACE_WITH_DB_PASSWORD/${DB_PASSWORD}/g" "$SQL_DIR/init.sql" > /tmp/qingyi-init.sql
sudo -u postgres psql -f /tmp/qingyi-init.sql
rm -f /tmp/qingyi-init.sql

echo "==> 校验（本地连接，不对外）"
PGPASSWORD="$DB_PASSWORD" psql -h 127.0.0.1 -U qingyi -d qingyi_db -c "SELECT current_database(), current_user;"

echo "==> 完成。PostgreSQL 只监听 localhost:5432，勿对公网放行。"
echo "    如需远程管理，请通过 Cloudflare Tunnel 的 TCP 类型暴露 db.qingyi.dpdns.org 并配 Access。"
