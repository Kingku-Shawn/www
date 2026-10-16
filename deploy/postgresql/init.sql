-- 本地 PostgreSQL 初始化（qingyi_db / 用户 qingyi）
-- 用法（在服务器上以 postgres 超级用户执行）：
--   sudo -u postgres psql -f /path/to/init.sql
-- 或由 deploy/postgresql/setup.sh 自动执行。
-- ⚠ 上线前把密码 'REPLACE_WITH_DB_PASSWORD' 换成强随机值。

-- 幂等：若用户已存在则忽略（DO 块判断）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qingyi') THEN
    CREATE USER qingyi WITH PASSWORD 'REPLACE_WITH_DB_PASSWORD';
  END IF;
END
$$;

-- 建库（仅当不存在；CREATE DATABASE 不能放在事务/DO 内，用 \gexec 判断）
SELECT 'CREATE DATABASE qingyi_db OWNER qingyi'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'qingyi_db')
\gexec

-- 授权
GRANT ALL PRIVILEGES ON DATABASE qingyi_db TO qingyi;

-- 连接库内授权 schema（psql 默认 public schema）
\connect qingyi_db
GRANT ALL ON SCHEMA public TO qingyi;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO qingyi;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO qingyi;
