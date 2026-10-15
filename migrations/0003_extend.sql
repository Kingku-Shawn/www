-- 清逸的博客 · D1 扩展表迁移（《追加补充.md》第三节落地脚本）
-- 内容与 worker/src/extend-schema.js 的 EXTEND_STATEMENTS 完全等价（逐条一致，仅注释形式不同）。
-- 通过 `npx wrangler d1 execute t_blog_qingyi --remote --file=migrations/0003_extend.sql` 执行。
--
-- 说明：
--   1) migrations/0001_init.sql 已废弃，勿参考其结构。
--   2) migrations/0002_admin_full.sql 是现有 14 张业务表的权威脚本
--      （users, sessions, categories, posts, tags, post_tags, columns, post_columns,
--        comments, votes, settings, about_versions, views, uploads）。
--   3) 本文件只负责「新增」内容：27 张扩展表 + 现有表字段增补 + 索引增补。
--   4) 本文件可重复执行：CREATE TABLE / CREATE INDEX 均为 IF NOT EXISTS；
--      ALTER TABLE 重复执行会报 `duplicate column name: xxx`，属预期，可忽略。
--   5) 不使用 CREATE TRIGGER（现有 Worker 执行器按语句逐条 prepare().run()，触发器易写坏；FTS 同步后续由代码维护）。
--   6) 顺序：27 张 CREATE TABLE -> 33 条 ALTER TABLE -> 24 条索引（ALTER 必须在索引之前，
--      因为 idx_posts_published 依赖 posts.published_at 列）。

-- ============ 一、扩展表（TABLE-X1..X27） ============

-- TABLE-X1 文章修订（文章真源在 posts，这里存历史快照，供版本对比/回滚）
CREATE TABLE IF NOT EXISTS article_revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL,
  title       TEXT    NOT NULL DEFAULT '',
  summary     TEXT    NOT NULL DEFAULT '',
  content     TEXT    NOT NULL DEFAULT '',
  source_file TEXT    NOT NULL DEFAULT '',
  editor_id   INTEGER NOT NULL DEFAULT 0,
  note        TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- TABLE-X2 文章点赞（与评论赞踩 votes 分开，主键 (post_id, client_key) 做指纹去重）
CREATE TABLE IF NOT EXISTS article_likes (
  post_id    INTEGER NOT NULL,
  client_key TEXT    NOT NULL,
  ip_hash    TEXT    NOT NULL DEFAULT '',
  ua         TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, client_key)
);

-- TABLE-X3 文章收藏（登录用户收藏，主键 (post_id, user_id) 天然去重）
CREATE TABLE IF NOT EXISTS article_bookmarks (
  post_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

-- TABLE-X4 访问明细（隐私友好统计；client_key 为指纹哈希，不存原始 IP）
CREATE TABLE IF NOT EXISTS visits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT    NOT NULL DEFAULT '',
  source_file TEXT    NOT NULL DEFAULT '',
  client_key  TEXT    NOT NULL DEFAULT '',
  ip_hash     TEXT    NOT NULL DEFAULT '',
  ua          TEXT    NOT NULL DEFAULT '',
  referer     TEXT    NOT NULL DEFAULT '',
  country     TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- TABLE-X5 日聚合（date 形如 "2026-02-14"，与聚合任务的日期口径一致）
CREATE TABLE IF NOT EXISTS daily_stats (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT    NOT NULL DEFAULT '',
  pv         INTEGER NOT NULL DEFAULT 0,
  uv         INTEGER NOT NULL DEFAULT 0,
  posts      INTEGER NOT NULL DEFAULT 0,
  comments   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- TABLE-X6 搜索词（q 唯一，cnt 累计次数，last_at 最近一次搜索时间）
CREATE TABLE IF NOT EXISTS search_queries (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  q       TEXT    NOT NULL DEFAULT '',
  cnt     INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL DEFAULT 0
);

-- TABLE-X7 审计（登录、改密、删除、上传、设置变更留痕）
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL DEFAULT 0,
  action     TEXT    NOT NULL DEFAULT '',
  target     TEXT    NOT NULL DEFAULT '',
  method     TEXT    NOT NULL DEFAULT '',
  path       TEXT    NOT NULL DEFAULT '',
  ip         TEXT    NOT NULL DEFAULT '',
  ua         TEXT    NOT NULL DEFAULT '',
  detail     TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- TABLE-X8 登录日志（含失败记录，供异常登录提醒）
CREATE TABLE IF NOT EXISTS login_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL DEFAULT 0,
  username   TEXT    NOT NULL DEFAULT '',
  ip         TEXT    NOT NULL DEFAULT '',
  ua         TEXT    NOT NULL DEFAULT '',
  success    INTEGER NOT NULL DEFAULT 1,
  reason     TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- TABLE-X9 限流（key = 维度拼接串，主键 (key, window_start)；window_start 为毫秒时间戳）
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT    NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  expire_at    INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

-- TABLE-X10 站内信（read_at = 0 表示未读，避免 NULL 判断）
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL DEFAULT 0,
  type       TEXT    NOT NULL DEFAULT 'system',
  title      TEXT    NOT NULL DEFAULT '',
  body       TEXT    NOT NULL DEFAULT '',
  link       TEXT    NOT NULL DEFAULT '',
  read_at    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- TABLE-X11 订阅（token 用于退订链接，status 1 生效 / 0 退订）
CREATE TABLE IF NOT EXISTS subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    NOT NULL DEFAULT '',
  token      TEXT    NOT NULL DEFAULT '',
  status     INTEGER NOT NULL DEFAULT 1,
  source     TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- TABLE-X12 邮件列表（可与 subscriptions 并行使用，email 唯一）
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    UNIQUE NOT NULL,
  status     INTEGER NOT NULL DEFAULT 1,
  tag        TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- TABLE-X13 友情链接（status 1 展示 / 0 隐藏；sort 越小越靠前）
CREATE TABLE IF NOT EXISTS links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL DEFAULT '',
  url         TEXT    NOT NULL DEFAULT '',
  logo        TEXT    NOT NULL DEFAULT '',
  description TEXT    NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  status      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL DEFAULT 0
);

-- TABLE-X14 公告（start_at/end_at 为毫秒时间戳，0 表示不限）
CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL DEFAULT '',
  content    TEXT    NOT NULL DEFAULT '',
  type       TEXT    NOT NULL DEFAULT 'info',
  status     INTEGER NOT NULL DEFAULT 1,
  start_at   INTEGER NOT NULL DEFAULT 0,
  end_at     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- TABLE-X15 重定向（code 301/302/307/308）
CREATE TABLE IF NOT EXISTS redirects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_path  TEXT    NOT NULL DEFAULT '',
  to_path    TEXT    NOT NULL DEFAULT '',
  code       INTEGER NOT NULL DEFAULT 301,
  status     INTEGER NOT NULL DEFAULT 1,
  hits       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- TABLE-X16 SEO 元信息（page_key 为页面唯一键，如 "site" / "post:123" / "tag:js"）
CREATE TABLE IF NOT EXISTS seo_meta (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  page_key    TEXT    NOT NULL DEFAULT '',
  title       TEXT    NOT NULL DEFAULT '',
  description TEXT    NOT NULL DEFAULT '',
  keywords    TEXT    NOT NULL DEFAULT '',
  og_image    TEXT    NOT NULL DEFAULT '',
  canonical   TEXT    NOT NULL DEFAULT '',
  robots      TEXT    NOT NULL DEFAULT '',
  json_ld     TEXT    NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL DEFAULT 0
);

-- TABLE-X17 单页（隐私政策/服务条款/关于/免责声明等，slug 唯一）
CREATE TABLE IF NOT EXISTS pages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT    UNIQUE NOT NULL,
  title      TEXT    NOT NULL DEFAULT '',
  content    TEXT    NOT NULL DEFAULT '',
  status     INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- TABLE-X18 导航（location 如 header/footer/sidebar，items_json 存菜单项数组 JSON）
CREATE TABLE IF NOT EXISTS menus (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  location   TEXT    NOT NULL DEFAULT '',
  name       TEXT    NOT NULL DEFAULT '',
  items_json TEXT    NOT NULL DEFAULT '[]',
  status     INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- TABLE-X19 媒体库（upload_id 关联 uploads.id；storage 为 d1 / r2）
CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_id  INTEGER NOT NULL DEFAULT 0,
  filename   TEXT    NOT NULL DEFAULT '',
  alt        TEXT    NOT NULL DEFAULT '',
  width      INTEGER NOT NULL DEFAULT 0,
  height     INTEGER NOT NULL DEFAULT 0,
  hash       TEXT    NOT NULL DEFAULT '',
  storage    TEXT    NOT NULL DEFAULT 'd1',
  url        TEXT    NOT NULL DEFAULT '',
  thumb_url  TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- TABLE-X20 用户资料（user_id 唯一，一人一份；social_json 存社交链接 JSON）
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id     INTEGER PRIMARY KEY,
  avatar      TEXT    NOT NULL DEFAULT '',
  bio         TEXT    NOT NULL DEFAULT '',
  website     TEXT    NOT NULL DEFAULT '',
  location    TEXT    NOT NULL DEFAULT '',
  social_json TEXT    NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL DEFAULT 0
);

-- TABLE-X21 第三方登录（provider + open_id 唯一，可绑定已有账号）
CREATE TABLE IF NOT EXISTS oauth_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL DEFAULT 0,
  provider    TEXT    NOT NULL DEFAULT '',
  open_id     TEXT    NOT NULL DEFAULT '',
  union_id    TEXT    NOT NULL DEFAULT '',
  nickname    TEXT    NOT NULL DEFAULT '',
  avatar      TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- TABLE-X22 密码重置（token 即主键，一次性、短过期）
CREATE TABLE IF NOT EXISTS password_resets (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL DEFAULT 0,
  email      TEXT    NOT NULL DEFAULT '',
  expire_at  INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);

-- TABLE-X23 邮箱验证（token 即主键，一次性）
CREATE TABLE IF NOT EXISTS email_verifications (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL DEFAULT 0,
  email      TEXT    NOT NULL DEFAULT '',
  expire_at  INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);

-- TABLE-X24 评论举报（status 0 待处理 / 1 已处理 / 2 已忽略）
CREATE TABLE IF NOT EXISTS comment_reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL DEFAULT 0,
  post_id    INTEGER NOT NULL DEFAULT 0,
  reason     TEXT    NOT NULL DEFAULT '',
  detail     TEXT    NOT NULL DEFAULT '',
  client_key TEXT    NOT NULL DEFAULT '',
  ip_hash    TEXT    NOT NULL DEFAULT '',
  status     INTEGER NOT NULL DEFAULT 0,
  handled_by INTEGER NOT NULL DEFAULT 0,
  handled_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- TABLE-X25 评论黑名单（type：ip / ua / word / email / client）
CREATE TABLE IF NOT EXISTS comment_blacklist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT    NOT NULL DEFAULT 'word',
  value      TEXT    NOT NULL DEFAULT '',
  reason     TEXT    NOT NULL DEFAULT '',
  status     INTEGER NOT NULL DEFAULT 1,
  expire_at  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- TABLE-X26 Webhook（events 存逗号分隔或 JSON 的事件名列表，secret 用于签名）
CREATE TABLE IF NOT EXISTS webhooks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL DEFAULT '',
  url        TEXT    NOT NULL DEFAULT '',
  secret     TEXT    NOT NULL DEFAULT '',
  events     TEXT    NOT NULL DEFAULT '',
  status     INTEGER NOT NULL DEFAULT 1,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_at    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- TABLE-X27 投递记录（response 存响应体片段/错误信息，供重试与排查）
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id    INTEGER NOT NULL DEFAULT 0,
  event         TEXT    NOT NULL DEFAULT '',
  payload       TEXT    NOT NULL DEFAULT '',
  status        INTEGER NOT NULL DEFAULT 0,
  status_code   INTEGER NOT NULL DEFAULT 0,
  response      TEXT    NOT NULL DEFAULT '',
  attempt       INTEGER NOT NULL DEFAULT 1,
  next_retry_at INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- ============ 二、现有表字段增补（SQLite 每条 ALTER 只能加一列） ============

-- users 增补 9 列
ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_login_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_login_ip TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN two_factor_secret TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN website TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN social_json TEXT NOT NULL DEFAULT '{}';

-- posts 增补 11 列（published_at / deleted_at 为毫秒时间戳，与全库新增列口径一致）
ALTER TABLE posts ADD COLUMN cover_image TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN author_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN word_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN reading_time INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN license TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN canonical_url TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN og_image TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN seo_title TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN seo_description TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN published_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN deleted_at INTEGER NOT NULL DEFAULT 0;

-- comments 增补 6 列
ALTER TABLE comments ADD COLUMN ip_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE comments ADD COLUMN ua TEXT NOT NULL DEFAULT '';
ALTER TABLE comments ADD COLUMN reply_to_user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN is_author INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN edited_at INTEGER NOT NULL DEFAULT 0;

-- article_likes 增补 user_id（登录点赞时记录，供「我的点赞」按账号查询；历史数据为 0）
ALTER TABLE article_likes ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;

-- uploads 增补 6 列
ALTER TABLE uploads ADD COLUMN alt TEXT NOT NULL DEFAULT '';
ALTER TABLE uploads ADD COLUMN width INTEGER NOT NULL DEFAULT 0;
ALTER TABLE uploads ADD COLUMN height INTEGER NOT NULL DEFAULT 0;
ALTER TABLE uploads ADD COLUMN hash TEXT NOT NULL DEFAULT '';
ALTER TABLE uploads ADD COLUMN storage TEXT NOT NULL DEFAULT 'd1';
ALTER TABLE uploads ADD COLUMN thumb_url TEXT NOT NULL DEFAULT '';

-- ============ 三、索引增补（《追加补充.md》第三节第 3 条，9 条，顺序逐字一致） ============
-- 依赖 posts.published_at，所以必须排在上面的 ALTER 之后
CREATE INDEX IF NOT EXISTS idx_posts_published ON posts (status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_article_likes_post ON article_likes (post_id);
CREATE INDEX IF NOT EXISTS idx_article_bookmarks_user ON article_bookmarks (user_id);
CREATE INDEX IF NOT EXISTS idx_visits_created ON visits (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_search_queries_q ON search_queries (q);
CREATE INDEX IF NOT EXISTS idx_comments_page_status_created ON comments (page_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications (user_id, read_at);

-- ============ 四、扩展表配套索引（补充包之外，供后台/前台常用查询） ============
CREATE INDEX IF NOT EXISTS idx_posts_deleted ON posts (deleted_at, status);
CREATE INDEX IF NOT EXISTS idx_article_revisions_post ON article_revisions (post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_article_likes_client ON article_likes (client_key);
CREATE INDEX IF NOT EXISTS idx_visits_source ON visits (source_file, created_at);
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats (date);
CREATE INDEX IF NOT EXISTS idx_login_logs_user ON login_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);
CREATE INDEX IF NOT EXISTS idx_subscriptions_email ON subscriptions (email);
CREATE INDEX IF NOT EXISTS idx_redirects_from ON redirects (from_path);
CREATE INDEX IF NOT EXISTS idx_seo_meta_key ON seo_meta (page_key);
CREATE INDEX IF NOT EXISTS idx_pages_slug ON pages (slug);
CREATE INDEX IF NOT EXISTS idx_media_hash ON media (hash);
CREATE INDEX IF NOT EXISTS idx_oauth_provider ON oauth_accounts (provider, open_id);
CREATE INDEX IF NOT EXISTS idx_comment_reports_status ON comment_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_hook ON webhook_deliveries (webhook_id, created_at DESC);
