-- 清逸的博客 · D1 表结构（阅读量 + 评论 + 点赞）
-- 通过 `wrangler d1 execute t_blog_qingyi --remote --file=migrations/0001_init.sql` 执行

-- 阅读量（键 = 文章 source_file，形如 a_6a65e04d207e69fec45c0a88.html）
CREATE TABLE IF NOT EXISTS views (
  source_file TEXT PRIMARY KEY,
  count       INTEGER NOT NULL DEFAULT 0
);

-- 评论
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id    TEXT    NOT NULL,               -- 评论目标：文章 id 或 "site"/"piano" 等
  root_id    INTEGER NOT NULL DEFAULT 0,     -- 顶层为 0；回复时指向顶层评论 id
  parent_id  INTEGER NOT NULL DEFAULT 0,     -- 被回复的评论 id（楼中楼）
  content    TEXT    NOT NULL,
  author     TEXT    NOT NULL DEFAULT '匿名用户',
  email      TEXT    NOT NULL DEFAULT '',
  avatar     TEXT    NOT NULL DEFAULT '',
  role       TEXT    NOT NULL DEFAULT 'user',
  status     INTEGER NOT NULL DEFAULT 1,     -- 1 展示 / 0 隐藏
  zan        INTEGER NOT NULL DEFAULT 0,
  cai        INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_page ON comments (page_id, root_id, status);
CREATE INDEX IF NOT EXISTS idx_comments_root ON comments (root_id, status);

-- 点赞（按客户端指纹，保证“我的赞”状态可判）
CREATE TABLE IF NOT EXISTS votes (
  comment_id INTEGER NOT NULL,
  client_key TEXT    NOT NULL,
  type       INTEGER NOT NULL,               -- 1 = 赞，-1 = 踩
  PRIMARY KEY (comment_id, client_key)
);

-- 账号（登录/注册）
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT UNIQUE NOT NULL,
  nickname   TEXT    NOT NULL DEFAULT '',
  pass_salt  TEXT    NOT NULL,               -- hex salt
  pass_hash  TEXT    NOT NULL,               -- PBKDF2-SHA256(password, salt, 100000) hex
  role       TEXT    NOT NULL DEFAULT 'user', -- user / admin
  status     INTEGER NOT NULL DEFAULT 1,     -- 1 正常 / 0 禁用
  created_at INTEGER NOT NULL
);
-- 兼容已建表：补 role 列
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';

-- 登录会话（token → user_id）
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expire_at  INTEGER NOT NULL
);
