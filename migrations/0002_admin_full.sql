-- 清逸的博客 · D1 表结构（完整版：前台 + 后台管理）
-- 覆盖本地 admin/server.py 的全部数据模型，文章真源迁到 D1。
-- 通过 `wrangler d1 execute t_blog_qingyi --remote --file=migrations/0002_admin_full.sql` 执行

-- ============ 账号 ============
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT UNIQUE NOT NULL,
  nickname   TEXT    NOT NULL DEFAULT '',
  email      TEXT    NOT NULL DEFAULT '',
  pass_salt  TEXT    NOT NULL DEFAULT '',
  pass_hash  TEXT    NOT NULL DEFAULT '',
  role       TEXT    NOT NULL DEFAULT 'user',   -- super_admin / admin / user
  status     INTEGER NOT NULL DEFAULT 1,        -- 1 正常 / 0 禁用
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expire_at  INTEGER NOT NULL
);

-- ============ 分类（category_id 单分类） ============
CREATE TABLE IF NOT EXISTS categories (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

-- ============ 文章 ============
CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  category_id INTEGER,
  summary     TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  status      INTEGER NOT NULL DEFAULT 1,       -- 1 发布 / 0 草稿
  is_top      INTEGER NOT NULL DEFAULT 0,
  views       INTEGER NOT NULL DEFAULT 0,
  source_file TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,                    -- 兼容旧格式 "YYYY-MM-DD HH:MM:SS" 字符串
  updated_at  TEXT NOT NULL
);

-- ============ 标签 ============
CREATE TABLE IF NOT EXISTS tags (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT UNIQUE NOT NULL,
  color TEXT NOT NULL DEFAULT '#58a6ff'
);
CREATE TABLE IF NOT EXISTS post_tags (
  post_id INTEGER NOT NULL,
  tag_id  INTEGER NOT NULL,
  PRIMARY KEY (post_id, tag_id)
);

-- ============ 分栏 ============
CREATE TABLE IF NOT EXISTS columns (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS post_columns (
  post_id   INTEGER NOT NULL,
  column_id INTEGER NOT NULL,
  PRIMARY KEY (post_id, column_id)
);

-- ============ 评论（后台管理用 post_id；前台评论用 page_id 存 source_file）============
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER,                            -- 关联 posts.id（后台）
  page_id    TEXT    NOT NULL DEFAULT '',        -- 关联 source_file / "site"（前台）
  root_id    INTEGER NOT NULL DEFAULT 0,
  parent_id  INTEGER NOT NULL DEFAULT 0,
  author     TEXT    NOT NULL DEFAULT '匿名用户',
  email      TEXT    NOT NULL DEFAULT '',
  avatar     TEXT    NOT NULL DEFAULT '',
  role       TEXT    NOT NULL DEFAULT 'user',
  content    TEXT    NOT NULL,
  status     INTEGER NOT NULL DEFAULT 1,         -- 1 展示 / 0 隐藏
  zan        INTEGER NOT NULL DEFAULT 0,
  cai        INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_page ON comments (page_id, root_id, status);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id, status);

-- ============ 点赞 ============
CREATE TABLE IF NOT EXISTS votes (
  comment_id INTEGER NOT NULL,
  client_key TEXT    NOT NULL,
  type       INTEGER NOT NULL,                   -- 1 赞 / -1 踩
  PRIMARY KEY (comment_id, client_key)
);

-- ============ 设置（键值） ============
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ============ 关于我版本 ============
CREATE TABLE IF NOT EXISTS about_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ============ 阅读量（前台 posts.json 动态 views 用，兼容旧表）============
CREATE TABLE IF NOT EXISTS views (
  source_file TEXT PRIMARY KEY,
  count       INTEGER NOT NULL DEFAULT 0
);

-- ============ 上传的图片（base64 存 D1，供后台编辑器/关于我引用）============
CREATE TABLE IF NOT EXISTS uploads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL DEFAULT 'image/png',
  size       INTEGER NOT NULL DEFAULT 0,
  data_b64   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
