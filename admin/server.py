# -*- coding: utf-8 -*-
"""
xiwnn 离线博客 管理后台服务
基于 Python 标准库实现，零第三方依赖（无需 pip install）。
数据库：SQLite（同目录 data/admin.db，自动初始化）
默认账号：
  超级管理员 root / 123456
  管理员     admin / 123456

启动：python admin_server.py [port]   （默认端口 8124）
"""
import json
import os
import re
import sqlite3
import hashlib
import secrets
import threading
import time
import urllib.parse
from http.server import HTTPServer, ThreadingHTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timezone

# ---------- 离线工具页接口（原站动态接口本地化） ----------
# 原站前端（Vue SPA）会请求 /api-v1/*（经 Kv 拦截器改写 /api/* -> /api-v1/*），
# 离线时在 8124 提供本地桩数据，保证工具页无 404 报错。


# ---------- 基础配置 ----------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data", "admin.db")
WEB_DIR = os.path.join(BASE_DIR, "web")
MIRROR_ROOT = os.path.normpath(os.path.join(BASE_DIR, ".."))  # 离线镜像根目录
PORT = 8124
TOKEN_TTL = 8 * 3600  # 会话有效期 8 小时

SALT_PREFIX = "xiwnn_admin_v1"

ROLES = ("super_admin", "admin", "user")
ROLE_NAMES = {"super_admin": "超级管理员", "admin": "管理员", "user": "普通用户"}
# 各角色允许的操作
ROLE_PERMS = {
    "super_admin": {"dashboard", "users", "posts", "categories", "comments", "settings", "tags", "columns", "import_posts"},
    "admin":       {"dashboard", "posts", "categories", "comments", "settings", "tags", "columns", "import_posts"},
    "user":        {"dashboard"},
}


# ---------- 工具函数 ----------
def now_str():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def hash_password(password, salt=None):
    if salt is None:
        salt = secrets.token_hex(8)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), (SALT_PREFIX + salt).encode("utf-8"), 100000)
    return salt + ":" + digest.hex()


def verify_password(password, stored):
    try:
        salt, _ = stored.split(":", 1)
    except ValueError:
        return False
    return hash_password(password, salt) == stored


def safe_text(s, limit=200):
    if not s:
        return ""
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit]


# ---------- 数据库 ----------
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = get_db()
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        nickname TEXT DEFAULT '',
        email TEXT DEFAULT '',
        status INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        sort INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        category_id INTEGER,
        summary TEXT DEFAULT '',
        content TEXT DEFAULT '',
        status INTEGER DEFAULT 1,
        is_top INTEGER DEFAULT 0,
        views INTEGER DEFAULT 0,
        source_file TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER,
        author TEXT DEFAULT '',
        email TEXT DEFAULT '',
        content TEXT NOT NULL,
        status INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        color TEXT DEFAULT '#58a6ff'
    );
    CREATE TABLE IF NOT EXISTS post_tags (
        post_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        PRIMARY KEY (post_id, tag_id)
    );
    CREATE TABLE IF NOT EXISTS columns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        sort INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS post_columns (
        post_id INTEGER NOT NULL,
        column_id INTEGER NOT NULL,
        PRIMARY KEY (post_id, column_id)
    );
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE TABLE IF NOT EXISTS about_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    """)
    # 兼容旧库：给 posts 补充 source_file 列
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(posts)").fetchall()]
    if "source_file" not in cols:
        conn.execute("ALTER TABLE posts ADD COLUMN source_file TEXT DEFAULT ''")
    # 默认账号
    cur = conn.execute("SELECT COUNT(*) AS c FROM users")
    if cur.fetchone()["c"] == 0:
        conn.execute(
            "INSERT INTO users (username, password, role, nickname, created_at) VALUES (?,?,?,?,?)",
            ("root", hash_password("123456"), "super_admin", "超级管理员", now_str()),
        )
        conn.execute(
            "INSERT INTO users (username, password, role, nickname, created_at) VALUES (?,?,?,?,?)",
            ("admin", hash_password("123456"), "admin", "管理员", now_str()),
        )
    # 默认分类
    cur = conn.execute("SELECT COUNT(*) AS c FROM categories")
    if cur.fetchone()["c"] == 0:
        for i, name in enumerate(["前端", "后端", "设计", "产品", "其它"]):
            conn.execute("INSERT INTO categories (name, sort) VALUES (?,?)", (name, i))
    # 默认工具开关配置（settings.tools）
    cur = conn.execute("SELECT COUNT(*) AS c FROM settings WHERE key='tools'")
    if cur.fetchone()["c"] == 0:
        tools = [
            {"key": "piano", "name": "在线钢琴", "path": "piano/index.html",
             "desc": "支持自定义键盘映射、MIDI 播放与录制", "enabled": True},
            {"key": "music", "name": "在线乐器", "path": "music/index.html",
             "desc": "钢琴、卡林巴、吉他和弦等乐器总览", "enabled": True},
            {"key": "tiaoyin", "name": "调音器", "path": "tiaoyin/index.html",
             "desc": "吉他、小提琴、二胡等乐器的在线调音", "enabled": True},
            {"key": "metronome", "name": "节拍器", "path": "metronome/index.html",
             "desc": "在线节拍器，支持多种拍号与速度", "enabled": True},
            {"key": "kalimba", "name": "卡林巴拇指琴", "path": "music/kalimba/index.html",
             "desc": "17 音拇指琴，触摸滑奏、多调性，附简谱跟弹", "enabled": True},
            {"key": "guitar-chords", "name": "吉他和弦库", "path": "music/guitar-chords/index.html",
             "desc": "96 个和弦指法对照，扫弦/分解在线试听", "enabled": True},
        ]
        conn.execute("INSERT INTO settings (key, value) VALUES ('tools', ?)",
                     (json.dumps(tools, ensure_ascii=False),))
    # 默认关于我内容
    cur = conn.execute("SELECT COUNT(*) AS c FROM about_versions")
    if cur.fetchone()["c"] == 0:
        default_about = ("<h2>关于我</h2>"
                         "<p>你好，我是清逸。这个博客记录我的技术成长与日常思考。</p>"
                         "<p>可以在管理后台的「设置」中编辑本页图文内容，每次编辑会自动在顶部追加时间戳。</p>")
        conn.execute("INSERT INTO about_versions (content, created_at) VALUES (?,?)",
                     (default_about, now_str()))
    conn.commit()
    conn.close()


# ---------- 会话 ----------
_sessions = {}  # token -> {"username": str, "expire": float}
_lock = threading.Lock()


def create_session(username):
    token = secrets.token_hex(24)
    with _lock:
        _sessions[token] = {"username": username, "expire": time.time() + TOKEN_TTL}
    return token


def get_session_user(token):
    if not token:
        return None
    with _lock:
        s = _sessions.get(token)
        if not s:
            return None
        if s["expire"] < time.time():
            del _sessions[token]
            return None
        s["expire"] = time.time() + TOKEN_TTL
        return s["username"]


def delete_session(token):
    with _lock:
        _sessions.pop(token, None)


# ---------- HTTP 服务 ----------
class Handler(BaseHTTPRequestHandler):
    server_version = "xiwnn-admin/1.0"

    def log_message(self, fmt, *args):
        pass  # 静默访问日志

    # ---- 基础方法 ----
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.end_headers()
        self.wfile.write(body)

    def send_static(self, rel_path):
        # 防目录穿越
        full = os.path.normpath(os.path.join(WEB_DIR, rel_path))
        if not full.startswith(os.path.normpath(WEB_DIR)):
            self.send_error(403)
            return
        if not os.path.isfile(full):
            self.send_error(404)
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".png": "image/png",
            ".ico": "image/x-icon",
        }.get(ext, "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > 2 * 1024 * 1024:  # 请求体上限 2MB，防超大 payload
                return {"_too_large": True}
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            return {}

    def current_user(self):
        token = self.headers.get("X-Token", "")
        username = get_session_user(token)
        if not username:
            return None, "未登录或会话已过期"
        conn = get_db()
        row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        conn.close()
        if not row:
            return None, "账号不存在"
        if row["status"] != 1:
            return None, "账号已被禁用"
        return row, None

    def require_perm(self, perm):
        user, err = self.current_user()
        if err:
            return None, err, 401
        perms = ROLE_PERMS.get(user["role"], set())
        if perm not in perms:
            return user, "权限不足，该操作需要 " + ROLE_NAMES.get(user["role"], user["role"]) + " 及以上权限", 403
        return user, None, 0

    # ---- 路由 ----
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path == "/":
            self.send_redirect("/admin/index.html")
            return
        if path == "/admin" or path.startswith("/admin/"):
            rel = path[len("/admin/"):] if path != "/admin" else "index.html"
            self.send_static(rel if rel else "index.html")
            return
        # 站点公开接口（无需登录）
        if path == "/api/tools":
            return self.api_tools_public()
        if path == "/api/about":
            return self.api_about_public()
        if path == "/api/public/tags":
            return self.api_public_tags()
        if path == "/api/public/columns":
            return self.api_public_columns()
        if path == "/api/public/posts":
            return self.api_public_posts(parsed)
        if path == "/api/me":
            return self.api_me()
        if path == "/api/dashboard":
            return self.api_dashboard()
        if path == "/api/users":
            return self.api_users_list()
        if path == "/api/categories":
            return self.api_categories_list()
        if path == "/api/tags":
            return self.api_tags_list()
        if path == "/api/columns":
            return self.api_columns_list()
        if path == "/api/settings/tools":
            return self.api_settings_tools_get()
        if path == "/api/settings/about":
            return self.api_settings_about_get()
        if path == "/api/settings/layout":
            return self.api_settings_layout_get()
        if path == "/api/layout":
            return self.api_layout_public()
        if path == "/api/posts":
            return self.api_posts_list()
        if path == "/api/comments":
            return self.api_comments_list()
        # ---- 离线工具页桩接口（GET）----
        if path.startswith("/api-v1/"):
            return self.api_tool_mock_get(path, parsed)
        self.send_json({"ok": False, "msg": "404 Not Found"}, 404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        ctype = self.headers.get("Content-Type", "") or ""
        # 文件上传（multipart/form-data，需登录）
        if path == "/api/upload" and "multipart/form-data" in ctype:
            return self.api_upload()
        data = self.read_json()
        if data.get("_too_large"):
            return self.send_json({"ok": False, "msg": "请求体过大"}, 413)
        if path == "/api/login":
            return self.api_login(data)
        if path == "/api/logout":
            return self.api_logout()
        if path == "/api/register":
            return self.api_register(data)
        # 离线工具页桩接口（POST，无需登录）
        if path.startswith("/api-v1/"):
            return self.api_tool_mock_post(path, data)
        # 以下均需登录
        user, err, code = self.require_perm("dashboard")
        if err:
            return self.send_json({"ok": False, "msg": err}, code)
        if path == "/api/users/create":
            return self.api_user_create(user, data)
        if path == "/api/users/update":
            return self.api_user_update(user, data)
        if path == "/api/users/delete":
            return self.api_user_delete(user, data)
        if path == "/api/users/resetpwd":
            return self.api_user_resetpwd(user, data)
        if path == "/api/categories/create":
            return self.api_category_create(user, data)
        if path == "/api/categories/update":
            return self.api_category_update(user, data)
        if path == "/api/categories/delete":
            return self.api_category_delete(user, data)
        if path == "/api/tags/create":
            return self.api_tag_create(user, data)
        if path == "/api/tags/update":
            return self.api_tag_update(user, data)
        if path == "/api/tags/delete":
            return self.api_tag_delete(user, data)
        if path == "/api/columns/create":
            return self.api_column_create(user, data)
        if path == "/api/columns/update":
            return self.api_column_update(user, data)
        if path == "/api/columns/delete":
            return self.api_column_delete(user, data)
        if path == "/api/posts/create":
            return self.api_post_create(user, data)
        if path == "/api/posts/update":
            return self.api_post_update(user, data)
        if path == "/api/posts/delete":
            return self.api_post_delete(user, data)
        if path == "/api/comments/update":
            return self.api_comment_update(user, data)
        if path == "/api/comments/delete":
            return self.api_comment_delete(user, data)
        if path == "/api/import_posts":
            return self.api_import_posts(user)
        if path == "/api/settings":
            return self.api_settings_update(user, data)
        if path == "/api/settings/tools":
            return self.api_settings_tools_save(user, data)
        if path == "/api/settings/about":
            return self.api_settings_about_save(user, data)
        if path == "/api/settings/layout":
            return self.api_settings_layout_save(user, data)
        if path == "/api/settings/layout/reset":
            return self.api_settings_layout_reset(user)
        self.send_json({"ok": False, "msg": "404 Not Found"}, 404)

    # ---- 离线工具页桩接口实现 ----
    def api_tool_mock_get(self, path, parsed=None):
        # GET /api-v1/user/info
        if path == "/api-v1/user/info":
            return self.send_json({"success": True, "data": None})
        # GET /api-v1/csrf：返回 token 字符串（前端把响应体直接作为 _csrf 附加到 POST）
        if path == "/api-v1/csrf":
            body = '"offline-token-shawn"'
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body.encode("utf-8"))))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))
            return
        # ---- 文章接口离线化（从离线 HTML 的 PINIA_STATE 提取真实数据）----
        if path in ("/api-v1/article/article", "/api/article/article"):
            return self.api_article_detail(parsed)
        if path in ("/api-v1/article/categorys", "/api/article/categorys"):
            return self.api_article_categorys()
        if path in ("/api-v1/article/list", "/api/article/list"):
            return self.api_article_list(parsed)
        # 其余未识别的 /api-v1 GET 一律返回 success（避免 404 报错）
        return self.send_json({"success": True, "data": None})

    def api_tool_mock_post(self, path, data):
        # ---- 评论接口（离线为空列表，publish 提示成功但不上墙）----
        # POST /api-v1/pinlun/list
        if path == "/api-v1/pinlun/list":
            return self.send_json({"success": True, "data": {"list": [], "total": 0, "pageIndex": 1}})
        # POST /api-v1/pinlun/publish
        if path == "/api-v1/pinlun/publish":
            return self.send_json({"success": True, "data": {"item": None}, "msg": "已发表，站长确认后会展示"})
        # POST /api-v1/pinlun/replies
        if path == "/api-v1/pinlun/replies":
            return self.send_json({"success": True, "data": {"list": []}})
        # POST /api-v1/pinlun/del / vote
        if path in ("/api-v1/pinlun/del", "/api-v1/pinlun/vote"):
            return self.send_json({"success": True})
        # 其余未识别的 /api-v1 POST 一律返回 success
        return self.send_json({"success": True})

    # ---- 文章接口离线化实现（从镜像 HTML 的 PINIA_STATE 提取）----
    _article_index = {"ts": 0, "articles": {}, "list": [], "categorys": []}

    def _extract_pinia(self, html):
        """从文章 HTML 提取 window.__PINIA_STATE__ JSON 对象"""
        m = re.search(r"__PINIA_STATE__\s*=\s*\(\{", html)
        if not m:
            m = re.search(r"__PINIA_STATE__\s*=\s*\{", html)
            if not m:
                return None
            start = m.end() - 1
        else:
            start = m.end() - 1  # 指向 '{'
        depth, in_str, esc = 0, False, False
        for i in range(start, len(html)):
            ch = html[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(html[start:i + 1])
                    except Exception:
                        return None
        return None

    def _rebuild_article_index(self, force=False):
        now = time.time()
        if not force and now - self._article_index["ts"] < 60:
            return
        art_dir = os.path.join(MIRROR_ROOT, "article")
        arts = {}
        try:
            files = [f for f in os.listdir(art_dir) if f.startswith("a_") and f.endswith(".html")]
        except OSError:
            files = []
        for fn in files:
            try:
                with open(os.path.join(art_dir, fn), "r", encoding="utf-8", errors="ignore") as f:
                    html = f.read()
                data = self._extract_pinia(html)
                if not data or "article" not in data:
                    continue
                art = dict(data["article"])
                if data.get("id"):
                    art["id"] = data["id"]
                arts[art.get("id") or fn] = art
            except Exception:
                continue
        items = sorted(arts.values(), key=lambda a: a.get("createTime") or 0, reverse=True)
        cats = []
        seen = set()
        for a in items:
            for cc in (a.get("category") or []):
                if cc not in seen:
                    seen.add(cc)
                    cats.append(cc)
        self._article_index.update({"ts": now, "articles": arts, "list": items, "categorys": cats})

    def _normalize_content(self, content):
        """修复原站文章正文中的坏图片引用，统一为 /o.shawn.com/... 绝对路径"""
        if not content:
            return content

        def _fix_img_tag(m):
            tag = m.group(0)
            sm = re.search(r'src="([^"]*)"', tag)
            if not sm:
                return tag
            src = sm.group(1)
            if "o.shawn.com/uploads" not in src:
                return tag
            um = re.search(r"(o\.shawn\.com/uploads/[^\s\\\"'&]+)", src)
            if not um:
                return tag
            return tag.replace(sm.group(1), "/" + um.group(1))

        # 1) img 标签级修复：src 含 o.shawn.com/uploads 一律重建为绝对路径
        content = re.sub(r"<img[^>]*>", _fix_img_tag, content)
        # 2) markdown 图片形态 ![](../../o.shawn.com/uploads/...)
        content = re.sub(r"\.\./\.\./(o\.shawn\.com/uploads/)", r"/\1", content)
        content = re.sub(r"\.\./(o\.shawn\.com/uploads/)", r"/\1", content)
        # 3) 双斜杠归一（保留协议双斜杠）
        content = re.sub(r"//(?=o\.shawn\.com)", "/", content)
        return content

    def api_article_detail(self, parsed):
        self._rebuild_article_index()
        q = urllib.parse.parse_qs(parsed.query) if parsed else {}
        aid = (q.get("id") or [""])[0].strip()
        if aid.startswith("a_"):
            aid = aid[2:]
        art = self._article_index["articles"].get(aid)
        if not art:
            return self.send_json({"success": False, "msg": "文章不存在或未离线"}, 404)
        art = dict(art)
        if "content" in art:
            art["content"] = self._normalize_content(art["content"])
        return self.send_json({"success": True, "data": {"article": art}})

    def api_article_categorys(self):
        self._rebuild_article_index()
        return self.send_json({"success": True, "data": {"result": self._article_index["categorys"]}})

    def api_article_list(self, parsed):
        self._rebuild_article_index()
        q = urllib.parse.parse_qs(parsed.query) if parsed else {}
        try:
            page = max(1, int((q.get("page") or ["1"])[0]))
        except ValueError:
            page = 1
        size = 30
        cat = (q.get("c") or [""])[0].strip()
        items = self._article_index["list"]
        if cat:
            items = [a for a in items if cat in (a.get("category") or [])]
        total = len(items)
        start = (page - 1) * size
        page_items = [dict(a) for a in items[start:start + size]]
        return self.send_json({"success": True, "data": {
            "list": page_items, "total": total, "page": page, "pageSize": size}})

    # ---- 站点公开接口（无需登录）----
    def _get_tools(self, conn):
        row = conn.execute("SELECT value FROM settings WHERE key='tools'").fetchone()
        try:
            return json.loads(row["value"]) if row and row["value"] else []
        except Exception:
            return []

    def api_tools_public(self):
        conn = get_db()
        tools = self._get_tools(conn)
        conn.close()
        enabled = [t for t in tools if t.get("enabled")]
        return self.send_json({"ok": True, "data": enabled})

    def api_about_public(self):
        conn = get_db()
        row = conn.execute("SELECT content,created_at FROM about_versions ORDER BY id DESC LIMIT 1").fetchone()
        conn.close()
        if not row:
            return self.send_json({"ok": True, "data": {"content": "", "created_at": ""}})
        return self.send_json({"ok": True, "data": {"content": row["content"], "created_at": row["created_at"]}})

    def api_public_tags(self):
        conn = get_db()
        rows = conn.execute(
            "SELECT t.id,t.name,t.color,COUNT(pt.post_id) AS cnt "
            "FROM tags t LEFT JOIN post_tags pt ON pt.tag_id=t.id "
            "GROUP BY t.id ORDER BY cnt DESC, t.id").fetchall()
        conn.close()
        return self.send_json({"ok": True, "data": [dict(r) for r in rows]})

    def api_public_columns(self):
        conn = get_db()
        rows = conn.execute(
            "SELECT c.id,c.name,COUNT(pc.post_id) AS cnt "
            "FROM columns c LEFT JOIN post_columns pc ON pc.column_id=c.id "
            "GROUP BY c.id ORDER BY c.sort, c.id").fetchall()
        conn.close()
        return self.send_json({"ok": True, "data": [dict(r) for r in rows]})

    def api_public_posts(self, parsed):
        """公开文章列表：?tag=标签名&column=分栏名&search=关键词&page=1&size=10"""
        q = urllib.parse.parse_qs(parsed.query)
        tag = (q.get("tag") or [""])[0].strip()
        column = (q.get("column") or [""])[0].strip()
        search = (q.get("search") or [""])[0].strip()
        try:
            page = max(1, int((q.get("page") or ["1"])[0]))
        except ValueError:
            page = 1
        try:
            size = min(50, max(1, int((q.get("size") or ["10"])[0])))
        except ValueError:
            size = 10
        where = ["p.status=1"]
        params = []
        if tag:
            where.append("p.id IN (SELECT pt.post_id FROM post_tags pt JOIN tags t ON t.id=pt.tag_id WHERE t.name=?)")
            params.append(tag)
        if column:
            where.append("p.id IN (SELECT pc.post_id FROM post_columns pc JOIN columns c ON c.id=pc.column_id WHERE c.name=?)")
            params.append(column)
        if search:
            where.append("(p.title LIKE ? OR p.summary LIKE ?)")
            kw = "%" + search + "%"
            params.extend([kw, kw])
        where_sql = " AND ".join(where)
        conn = get_db()
        total = conn.execute("SELECT COUNT(*) AS c FROM posts p WHERE " + where_sql, params).fetchone()["c"]
        rows = conn.execute(
            "SELECT p.id,p.title,p.summary,p.views,p.created_at,p.source_file "
            "FROM posts p WHERE " + where_sql +
            " ORDER BY p.is_top DESC, p.id DESC LIMIT ? OFFSET ?",
            params + [size, (page - 1) * size]).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["tags"] = [x["name"] for x in conn.execute(
                "SELECT t.name FROM post_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.post_id=? ORDER BY t.id", (r["id"],))]
            d["columns"] = [x["name"] for x in conn.execute(
                "SELECT c.name FROM post_columns pc JOIN columns c ON c.id=pc.column_id WHERE pc.post_id=? ORDER BY c.id", (r["id"],))]
            result.append(d)
        conn.close()
        return self.send_json({"ok": True, "data": {
            "total": total, "page": page, "size": size, "list": result}})

    # ---- 标签管理 ----
    def _sanitize_name(self, s, limit=30):
        """标签/分栏名清洗：去 HTML、控制字符，限制长度"""
        if not s:
            return ""
        s = re.sub(r"<[^>]+>", "", s)
        s = re.sub(r"[\x00-\x1f\x7f]", "", s)
        return s.strip()[:limit]

    def api_tags_list(self):
        user, err = self.current_user()
        if err:
            return self.send_json({"ok": False, "msg": err}, 401)
        conn = get_db()
        rows = conn.execute(
            "SELECT t.id,t.name,t.color,COUNT(pt.post_id) AS cnt "
            "FROM tags t LEFT JOIN post_tags pt ON pt.tag_id=t.id "
            "GROUP BY t.id ORDER BY cnt DESC, t.id").fetchall()
        conn.close()
        return self.send_json({"ok": True, "data": [dict(r) for r in rows]})

    def api_tag_create(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"}, 403)
        name = self._sanitize_name(data.get("name"))
        if not name:
            return self.send_json({"ok": False, "msg": "请输入标签名称"})
        color = (data.get("color") or "#58a6ff").strip()
        if not re.match(r"^#[0-9a-fA-F]{6}$", color):
            color = "#58a6ff"
        conn = get_db()
        if conn.execute("SELECT 1 FROM tags WHERE name=?", (name,)).fetchone():
            conn.close()
            return self.send_json({"ok": False, "msg": "标签已存在"})
        conn.execute("INSERT INTO tags (name, color) VALUES (?,?)", (name, color))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "标签「" + name + "」已创建"})

    def api_tag_update(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"}, 403)
        tid = int(data.get("id") or 0)
        name = self._sanitize_name(data.get("name"))
        if not name:
            return self.send_json({"ok": False, "msg": "请输入标签名称"})
        color = (data.get("color") or "#58a6ff").strip()
        if not re.match(r"^#[0-9a-fA-F]{6}$", color):
            color = "#58a6ff"
        conn = get_db()
        if conn.execute("SELECT 1 FROM tags WHERE name=? AND id<>?", (name, tid)).fetchone():
            conn.close()
            return self.send_json({"ok": False, "msg": "标签已存在"})
        conn.execute("UPDATE tags SET name=?, color=? WHERE id=?", (name, color, tid))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "标签已更新"})

    def api_tag_delete(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"}, 403)
        tid = int(data.get("id") or 0)
        conn = get_db()
        conn.execute("DELETE FROM post_tags WHERE tag_id=?", (tid,))
        conn.execute("DELETE FROM tags WHERE id=?", (tid,))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "标签已删除，相关文章关联已解除"})

    # ---- 分栏管理 ----
    def api_columns_list(self):
        user, err = self.current_user()
        if err:
            return self.send_json({"ok": False, "msg": err}, 401)
        conn = get_db()
        rows = conn.execute(
            "SELECT c.id,c.name,c.sort,COUNT(pc.post_id) AS cnt "
            "FROM columns c LEFT JOIN post_columns pc ON pc.column_id=c.id "
            "GROUP BY c.id ORDER BY c.sort, c.id").fetchall()
        conn.close()
        return self.send_json({"ok": True, "data": [dict(r) for r in rows]})

    def api_column_create(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"}, 403)
        name = self._sanitize_name(data.get("name"))
        if not name:
            return self.send_json({"ok": False, "msg": "请输入分栏名称"})
        conn = get_db()
        if conn.execute("SELECT 1 FROM columns WHERE name=?", (name,)).fetchone():
            conn.close()
            return self.send_json({"ok": False, "msg": "分栏已存在"})
        conn.execute("INSERT INTO columns (name, sort) VALUES (?,?)",
                     (name, int(data.get("sort") or 0)))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "分栏「" + name + "」已创建"})

    def api_column_update(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"}, 403)
        cid = int(data.get("id") or 0)
        name = self._sanitize_name(data.get("name"))
        if not name:
            return self.send_json({"ok": False, "msg": "请输入分栏名称"})
        conn = get_db()
        if conn.execute("SELECT 1 FROM columns WHERE name=? AND id<>?", (name, cid)).fetchone():
            conn.close()
            return self.send_json({"ok": False, "msg": "分栏已存在"})
        conn.execute("UPDATE columns SET name=?, sort=? WHERE id=?",
                     (name, int(data.get("sort") or 0), cid))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "分栏已更新"})

    def api_column_delete(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"}, 403)
        cid = int(data.get("id") or 0)
        conn = get_db()
        conn.execute("DELETE FROM post_columns WHERE column_id=?", (cid,))
        conn.execute("DELETE FROM columns WHERE id=?", (cid,))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "分栏已删除，相关文章关联已解除"})

    # ---- 设置：工具开关 / 关于我 ----
    def api_settings_tools_get(self):
        user, err = self.current_user()
        if err:
            return self.send_json({"ok": False, "msg": err}, 401)
        conn = get_db()
        tools = self._get_tools(conn)
        conn.close()
        return self.send_json({"ok": True, "data": tools})

    def api_settings_tools_save(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"}, 403)
        tools = data.get("tools")
        if not isinstance(tools, list):
            return self.send_json({"ok": False, "msg": "参数不合法"})
        cleaned = []
        for t in tools:
            if not isinstance(t, dict):
                continue
            key = re.sub(r"[^a-z0-9\-]", "", (t.get("key") or "").lower())[:40]
            if not key:
                continue
            cleaned.append({
                "key": key,
                "name": self._sanitize_name(t.get("name"), 30),
                "path": re.sub(r"[^a-z0-9_\-/\.]", "", (t.get("path") or ""))[:100],
                "desc": self._sanitize_name(t.get("desc"), 100),
                "enabled": bool(t.get("enabled")),
            })
        conn = get_db()
        conn.execute("UPDATE settings SET value=? WHERE key='tools'", (json.dumps(cleaned, ensure_ascii=False),))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "工具展示设置已保存"})

    def api_settings_about_get(self):
        user, err = self.current_user()
        if err:
            return self.send_json({"ok": False, "msg": err}, 401)
        conn = get_db()
        rows = conn.execute("SELECT id,content,created_at FROM about_versions ORDER BY id DESC LIMIT 20").fetchall()
        conn.close()
        return self.send_json({"ok": True, "data": [dict(r) for r in rows]})

    # ---- 页面装修布局（可视化装修系统） ----
    _LAYOUT_PAGES = ("home", "about", "articles")
    _LAYOUT_TYPES = {"hero", "sidebar", "article_list", "tools_grid",
                     "text", "image", "card", "divider", "spacer",
                     "video", "link_list", "stats", "notice", "quote",
                     "button", "code", "custom_html", "about_content"}

    def _default_layout(self):
        hero = {"id": "hero-1", "type": "hero", "x": 0, "y": 0, "w": 100, "h": 300, "z": 10,
                "props": {"title": "清逸的博客",
                          "subtitle": "记录技术成长与日常思考，分享前端、机器学习与硬件折腾路上的点滴。",
                          "tags": ["前端开发", "机器学习", "硬件折腾", "在线工具集"]}}
        side = {"id": "side-1", "type": "sidebar", "x": 0, "y": 320, "w": 26, "h": 600, "z": 10, "props": {}}
        lst = {"id": "list-1", "type": "article_list", "x": 28, "y": 320, "w": 72, "h": 600, "z": 10,
               "props": {"mode": "latest", "limit": 6}}
        tools = {"id": "tools-1", "type": "tools_grid", "x": 0, "y": 940, "w": 100, "h": 280, "z": 10, "props": {}}
        pc = [hero, side, lst, tools]
        m_hero = dict(hero); m_hero["h"] = 240
        m_lst = dict(lst); m_lst.update({"x": 0, "y": 260, "w": 100, "h": 640})
        m_side = dict(side); m_side.update({"x": 0, "y": 920, "w": 100, "h": 430})
        m_tools = dict(tools); m_tools.update({"x": 0, "y": 1370, "w": 100, "h": 270})
        home = {"pc": pc, "mobile": [m_hero, m_lst, m_side, m_tools]}

        about_pc = [{"id": "about-1", "type": "about_content", "x": 0, "y": 0, "w": 100, "h": 520, "z": 10, "props": {}},
                    {"id": "side-1", "type": "sidebar", "x": 0, "y": 540, "w": 26, "h": 420, "z": 10, "props": {}}]
        about_mobile = [{"id": "about-1", "type": "about_content", "x": 0, "y": 0, "w": 100, "h": 560, "z": 10, "props": {}},
                        {"id": "side-1", "type": "sidebar", "x": 0, "y": 580, "w": 100, "h": 400, "z": 10, "props": {}}]
        about = {"pc": about_pc, "mobile": about_mobile}

        arts_side = dict(side); arts_side.update({"y": 0, "h": 700})
        arts_lst = dict(lst); arts_lst.update({"x": 28, "y": 0, "w": 72, "h": 700, "props": {"mode": "latest", "limit": 9}})
        arts_m_lst = dict(lst); arts_m_lst.update({"x": 0, "y": 0, "w": 100, "h": 760, "props": {"mode": "latest", "limit": 9}})
        articles = {"pc": [arts_side, arts_lst],
                    "mobile": [arts_m_lst,
                               {"id": "side-1", "type": "sidebar", "x": 0, "y": 780, "w": 100, "h": 400, "z": 10, "props": {}}]}
        return {"version": 1, "custom": False, "pages": {"home": home, "about": about, "articles": articles}}

    def _clean_layout(self, data):
        if not isinstance(data, dict):
            return None
        pages_in = data.get("pages")
        if not isinstance(pages_in, dict):
            # 兼容旧结构：顶层 pc/mobile 视为 home
            pages_in = {"home": {"pc": data.get("pc"), "mobile": data.get("mobile")}}
        out = {}
        for key in self._LAYOUT_PAGES:
            entry = pages_in.get(key)
            if not isinstance(entry, dict):
                entry = {}
            items = entry.get("pc")
            if not isinstance(items, list):
                items = []
            cleaned_pc = self._clean_items(items)
            items2 = entry.get("mobile")
            if not isinstance(items2, list):
                items2 = []
            out[key] = {"pc": cleaned_pc, "mobile": self._clean_items(items2)}
        return out

    def _clean_items(self, items):
        cleaned = []
        for it in items:
            if not isinstance(it, dict):
                continue
            t = it.get("type")
            if t not in self._LAYOUT_TYPES:
                continue
            cid = re.sub(r"[^a-zA-Z0-9\-_]", "", (it.get("id") or "")[:32]) or ("c" + str(len(cleaned) + 1))
            def num(v, lo, hi, dft):
                try:
                    v = float(v)
                except (TypeError, ValueError):
                    return dft
                return max(lo, min(hi, v))
            props = it.get("props") if isinstance(it.get("props"), dict) else {}
            p = {}
            for f in ("title", "subtitle", "desc", "name", "button_text", "align", "size", "style",
                      "text", "author", "theme", "bg", "label"):
                if f in props:
                    p[f] = self._sanitize_name(props.get(f), 200)
            if "content" in props:
                if t == "code":
                    s = props.get("content")
                    if not isinstance(s, str):
                        s = ""
                    p["content"] = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", s)[:5000]
                else:
                    p["content"] = self._sanitize_html(props.get("content"))
            for f in ("url", "link", "src"):
                if f in props and isinstance(props.get(f), str):
                    u = props[f].strip()
                    if re.match(r"^(https?:)?//|^/|^\./|^#", u) and "javascript:" not in u.lower():
                        p[f] = re.sub(r"[\"']", "", u)[:500]
            if "tags" in props and isinstance(props.get("tags"), list):
                p["tags"] = [self._sanitize_name(x, 30) for x in props.get("tags")[:12] if isinstance(x, str) and x.strip()]
            if "links" in props and isinstance(props.get("links"), list):
                links = []
                for x in props.get("links")[:20]:
                    if not isinstance(x, dict):
                        continue
                    lt = self._sanitize_name(x.get("text"), 60)
                    lu = x.get("url")
                    if isinstance(lu, str) and re.match(r"^(https?:)?//|^/|^\./|^#", lu.strip()) and "javascript:" not in lu.lower():
                        links.append({"text": lt, "url": re.sub(r"[\"']", "", lu.strip())[:500]})
                p["links"] = links
            if "stats" in props and isinstance(props.get("stats"), list):
                st = []
                for x in props.get("stats")[:12]:
                    if not isinstance(x, dict):
                        continue
                    st.append({"label": self._sanitize_name(x.get("label"), 30),
                               "value": self._sanitize_name(x.get("value"), 30)})
                p["stats"] = st
            for f in ("limit", "mode", "interval"):
                if f in props:
                    if f == "limit":
                        p[f] = int(num(props.get(f), 1, 20, 6))
                    elif f == "mode":
                        p[f] = "hot" if props.get(f) == "hot" else "latest"
                    else:
                        p[f] = int(num(props.get(f), 0, 9999, 0))
            if "autoplay" in props:
                p["autoplay"] = bool(props.get("autoplay"))
            cleaned.append({"id": cid, "type": t,
                            "x": num(it.get("x"), 0, 100, 0),
                            "y": num(it.get("y"), 0, 99999, 0),
                            "w": num(it.get("w"), 5, 100, 100),
                            "h": num(it.get("h"), 10, 9999, 120),
                            "z": int(num(it.get("z"), 0, 999, 1)),
                            "props": p})
        return cleaned

    def _get_layout(self):
        conn = get_db()
        row = conn.execute("SELECT value FROM settings WHERE key='layout'").fetchone()
        conn.close()
        if not row:
            return self._default_layout()
        try:
            v = json.loads(row["value"])
        except (ValueError, TypeError):
            return self._default_layout()
        if not isinstance(v, dict) or "pages" not in v:
            # 旧数据升级：顶层 pc/mobile 归入 home
            d = self._default_layout()
            if isinstance(v.get("pc"), list):
                d["pages"]["home"]["pc"] = self._clean_items(v.get("pc"))
            if isinstance(v.get("mobile"), list):
                d["pages"]["home"]["mobile"] = self._clean_items(v.get("mobile"))
            d["version"] = int(v.get("version") or 1)
            d["custom"] = bool(v.get("custom"))
            return d
        return v

    def api_settings_layout_get(self):
        user, err = self.current_user()
        if err:
            return self.send_json({"ok": False, "msg": err}, 401)
        v = self._get_layout()
        if not isinstance(v.get("version"), int):
            v["version"] = 1
        return self.send_json({"ok": True, "data": v})

    def api_settings_layout_save(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"}, 403)
        cleaned = self._clean_layout(data)
        if cleaned is None:
            return self.send_json({"ok": False, "msg": "参数不合法"})
        cur = self._get_layout()
        version = int(cur.get("version") or 1) + 1
        payload = {"version": version, "custom": True, "pages": cleaned}
        conn = get_db()
        conn.execute("INSERT INTO settings (key, value) VALUES ('layout', ?) "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                     (json.dumps(payload, ensure_ascii=False),))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "装修布局已保存", "data": {"version": version}})

    def api_layout_public(self):
        return self.send_json({"ok": True, "data": self._get_layout()})

    def api_settings_layout_reset(self, user):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"}, 403)
        conn = get_db()
        conn.execute("DELETE FROM settings WHERE key='layout'")
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "已恢复默认布局", "data": self._default_layout()})

    _SAFE_HTML_TAGS = {"p", "h1", "h2", "h3", "h4", "strong", "b", "em", "i", "u",
                       "ul", "ol", "li", "blockquote", "code", "pre", "br", "hr",
                       "a", "img", "audio", "video", "span", "div", "table", "thead", "tbody", "tr", "th", "td"}
    _SAFE_ATTRS = {"href", "src", "alt", "title", "target", "style", "width", "height", "controls", "autoplay", "loop", "muted"}

    def _sanitize_html(self, html):
        """白名单过滤富文本，防 XSS：只保留安全标签与属性，去掉 script/iframe/on*"""
        if not html:
            return ""
        # 去掉危险标签
        html = re.sub(r"<\s*(script|iframe|object|embed|link|meta|form|input|button|svg|math|style)\b[^>]*>.*?</\s*\1\s*>", "", html, flags=re.I | re.S)
        html = re.sub(r"<\s*(script|iframe|object|embed|link|meta|form|input|button|svg|math|style)\b[^>]*/?>", "", html, flags=re.I)
        html = re.sub(r"javascript\s*:", "", html, flags=re.I)
        html = re.sub(r"on\w+\s*=\s*[\"'][^\"']*[\"']", "", html, flags=re.I)
        html = re.sub(r"on\w+\s*=\s*\S+", "", html, flags=re.I)
        # 白名单标签，其余剥离标签保留文本
        def fix(m):
            tag = m.group(0)
            m2 = re.match(r"<\s*(/?)\s*([a-zA-Z0-9]+)([^>]*)>", tag)
            if not m2:
                return ""
            close, name, attrs = m2.group(1), m2.group(2).lower(), m2.group(3)
            if close:
                return "</" + name + ">" if name in self._SAFE_HTML_TAGS else ""
            if name not in self._SAFE_HTML_TAGS:
                return ""
            out = "<" + name
            for am in re.finditer(r'([a-zA-Z\-]+)\s*=\s*["\']([^"\']*)["\']', attrs):
                an, av = am.group(1).lower(), am.group(2)
                if an in self._SAFE_ATTRS and not re.match(r"^https?://", av) or an in ("href", "src") and re.match(r"^(https?:)?//", av):
                    if an in ("href", "src") and re.match(r"^(#|https?:|//|\.|/)", av):
                        av = av.replace('"', "")
                        out += ' ' + an + '="' + av + '"'
                    elif an not in ("href", "src"):
                        av = av.replace('"', "")
                        out += ' ' + an + '="' + av + '"'
            # 布尔属性（无值）保留
            for b in ("controls", "autoplay", "loop", "muted"):
                if re.search(r"\b" + b + r"\b", attrs, re.I) and b not in out:
                    out += " " + b
            return out + ">"
        html = re.sub(r"<[^>]*>", fix, html)
        return html

    def api_settings_about_save(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"}, 403)
        content = data.get("content") or ""
        content = self._sanitize_html(content)
        if len(content) > 100000:
            return self.send_json({"ok": False, "msg": "内容过长"})
        if not content.strip():
            return self.send_json({"ok": False, "msg": "内容不能为空"})
        ts = now_str()
        # 每次编辑自动在最上方添加时间戳
        stamp = "<p class=\"about-stamp\">更新于 " + ts + "</p>"
        if content.lstrip().lower().startswith("<p class=\"about-stamp\">"):
            content = re.sub(r"^\s*<p class=\"about-stamp\">.*?</p>", stamp, content, count=1, flags=re.S)
        else:
            content = stamp + content
        conn = get_db()
        conn.execute("INSERT INTO about_versions (content, created_at) VALUES (?,?)", (content, ts))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "已保存，并在顶部追加时间戳：" + ts})

    # ---- 文章标签/分栏关联 ----
    _TAG_PALETTE = ["#2563eb", "#06b6d4", "#f59e0b", "#ef4444", "#8b5cf6", "#10b981", "#ec4899", "#f97316", "#14b8a6", "#6366f1"]

    def _set_post_links(self, conn, pid, tags, columns):
        conn.execute("DELETE FROM post_tags WHERE post_id=?", (pid,))
        conn.execute("DELETE FROM post_columns WHERE post_id=?", (pid,))
        for tag in tags or []:
            tid = None
            try:
                tid = int(tag)
            except (TypeError, ValueError):
                name = str(tag).strip().lstrip("#")
                if not name:
                    continue
                row = conn.execute("SELECT id FROM tags WHERE name=?", (name,)).fetchone()
                if row:
                    tid = row[0]
                else:
                    n = conn.execute("SELECT COUNT(*) FROM tags").fetchone()[0]
                    color = self._TAG_PALETTE[n % len(self._TAG_PALETTE)]
                    cur = conn.execute("INSERT INTO tags (name, color) VALUES (?,?)", (name, color))
                    tid = cur.lastrowid
            if tid:
                conn.execute("INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?,?)", (pid, tid))
        for cid in columns or []:
            try:
                conn.execute("INSERT OR IGNORE INTO post_columns (post_id, column_id) VALUES (?,?)", (pid, int(cid)))
            except (TypeError, ValueError):
                pass

    def api_upload(self):
        """本地文件上传：图片/音频/视频，保存到 o.shawn.com/uploads/，返回可访问 URL"""
        user, err, code = self.require_perm("dashboard")
        if err:
            return self.send_json({"ok": False, "msg": err}, code)
        import re
        import time as _t
        import uuid
        ctype = self.headers.get("Content-Type", "") or ""
        m = re.search(r"boundary=(.+)", ctype)
        if not m:
            return self.send_json({"ok": False, "msg": "缺少 boundary"}, 400)
        boundary = m.group(1).strip().strip('"')
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 110 * 1024 * 1024:
            return self.send_json({"ok": False, "msg": "请求体大小无效"}, 413)
        body = self.rfile.read(length)
        filename, filedata = None, None
        for part in body.split(("--" + boundary).encode()):
            if not part or part.strip() in (b"--", b""):
                continue
            header_end = part.find(b"\r\n\r\n")
            if header_end < 0:
                continue
            head = part[:header_end].decode("latin-1", "ignore")
            fd = part[header_end + 4:]
            if fd.endswith(b"\r\n"):
                fd = fd[:-2]
            nm = re.search(r'name="([^"]+)"', head)
            if not nm or nm.group(1) != "file":
                continue
            fm = re.search(r'filename="([^"]*)"', head)
            filename = fm.group(1) if fm else "upload.bin"
            filedata = fd
        if not filedata or not filename:
            return self.send_json({"ok": False, "msg": "未收到文件"}, 400)
        ext = os.path.splitext(filename)[1].lower()
        allowed = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
                   ".mp3", ".wav", ".ogg", ".m4a", ".aac", ".mid", ".midi",
                   ".mp4", ".webm", ".mov"}
        if ext not in allowed:
            return self.send_json({"ok": False, "msg": "不支持的文件类型，仅允许图片/音频/视频"}, 400)
        if len(filedata) > 100 * 1024 * 1024:
            return self.send_json({"ok": False, "msg": "文件超过 100MB 限制"}, 413)
        upload_dir = os.path.join(MIRROR_ROOT, "o.shawn.com", "uploads")
        os.makedirs(upload_dir, exist_ok=True)
        name = _t.strftime("%Y%m%d") + "-" + uuid.uuid4().hex[:8] + ext
        with open(os.path.join(upload_dir, name), "wb") as f:
            f.write(filedata)
        return self.send_json({"ok": True, "data": {"url": "/o.shawn.com/uploads/" + name, "name": name}})

    def _post_extra(self, conn, pid):
        return {
            "tags": [dict(x) for x in conn.execute(
                "SELECT t.id,t.name,t.color FROM post_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.post_id=? ORDER BY t.id", (pid,))],
            "columns": [dict(x) for x in conn.execute(
                "SELECT c.id,c.name FROM post_columns pc JOIN columns c ON c.id=pc.column_id WHERE pc.post_id=? ORDER BY c.id", (pid,))],
        }

    # ---- 登录限流（防暴力破解）----
    _login_attempts = {}  # ip -> [失败时间戳]

    def _check_login_limit(self, ip):
        now = time.time()
        with _lock:
            ts = self._login_attempts.setdefault(ip, [])
            ts = [t for t in ts if now - t < 3600]
            self._login_attempts[ip] = ts
            if len(ts) >= 10:
                return True
        return False

    def _record_login_fail(self, ip):
        with _lock:
            self._login_attempts.setdefault(ip, []).append(time.time())

    # ---- API 实现 ----
    def api_login(self, data):
        ip = self.client_address[0]
        if self._check_login_limit(ip):
            return self.send_json({"ok": False, "msg": "登录尝试过于频繁，请 1 小时后再试"}, 429)
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        if not username or not password:
            return self.send_json({"ok": False, "msg": "请输入用户名和密码"})
        conn = get_db()
        row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        conn.close()
        if not row or not verify_password(password, row["password"]):
            self._record_login_fail(ip)
            return self.send_json({"ok": False, "msg": "用户名或密码错误"}, 401)
        if row["status"] != 1:
            return self.send_json({"ok": False, "msg": "该账号已被禁用"}, 403)
        token = create_session(username)
        return self.send_json({"ok": True, "token": token, "user": {
            "username": row["username"], "role": row["role"],
            "role_name": ROLE_NAMES.get(row["role"], row["role"]),
            "nickname": row["nickname"], "email": row["email"],
        }})

    # 站点访客公开注册（角色固定为普通用户）
    # 限流只统计"注册成功"的次数，失败的格式/密码请求不计数，避免误伤正常用户
    _reg_attempts = {}  # ip -> [timestamps]

    def api_register(self, data):
        ip = self.client_address[0]
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        nickname = self._sanitize_name(data.get("nickname"), 30)
        email = self._sanitize_name(data.get("email"), 80)
        if not re.match(r"^[A-Za-z0-9_\-\.]{3,32}$", username):
            return self.send_json({"ok": False, "msg": "用户名需为 3-32 位字母、数字、下划线"})
        if len(password) < 6:
            return self.send_json({"ok": False, "msg": "密码至少 6 位"})
        if nickname and re.search(r"[<>\"'`]|script", nickname, re.I):
            return self.send_json({"ok": False, "msg": "昵称包含非法字符"})
        now = time.time()
        with _lock:
            ts = self._reg_attempts.setdefault(ip, [])
            ts = [t for t in ts if now - t < 3600]
            if len(ts) >= 5:
                self._reg_attempts[ip] = ts
                return self.send_json({"ok": False, "msg": "注册过于频繁，请 1 小时后再试"}, 429)
        conn = get_db()
        if conn.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            conn.close()
            return self.send_json({"ok": False, "msg": "用户名已存在"})
        conn.execute(
            "INSERT INTO users (username,password,role,nickname,email,status,created_at) VALUES (?,?,?,?,?,1,?)",
            (username, hash_password(password), "user", nickname, email, now_str()))
        conn.commit()
        conn.close()
        with _lock:
            self._reg_attempts.setdefault(ip, []).append(now)
        return self.send_json({"ok": True, "msg": "注册成功"})

    def api_logout(self):
        token = self.headers.get("X-Token", "")
        delete_session(token)
        return self.send_json({"ok": True})

    def api_me(self):
        user, err = self.current_user()
        if err:
            return self.send_json({"ok": False, "msg": err}, 401)
        perms = ROLE_PERMS.get(user["role"], set())
        return self.send_json({"ok": True, "user": {
            "username": user["username"], "role": user["role"],
            "role_name": ROLE_NAMES.get(user["role"], user["role"]),
            "nickname": user["nickname"], "email": user["email"],
        }, "perms": sorted(perms)})

    def api_dashboard(self):
        user, err = self.current_user()
        if err:
            return self.send_json({"ok": False, "msg": err}, 401)
        conn = get_db()
        n_users = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
        n_posts = conn.execute("SELECT COUNT(*) AS c FROM posts").fetchone()["c"]
        n_pending = conn.execute("SELECT COUNT(*) AS c FROM posts WHERE status=0").fetchone()["c"]
        n_cats = conn.execute("SELECT COUNT(*) AS c FROM categories").fetchone()["c"]
        n_comments = conn.execute("SELECT COUNT(*) AS c FROM comments").fetchone()["c"]
        n_cmts_pending = conn.execute("SELECT COUNT(*) AS c FROM comments WHERE status=0").fetchone()["c"]
        recent = conn.execute(
            "SELECT id,title,status,is_top,views,created_at FROM posts ORDER BY id DESC LIMIT 8").fetchall()
        conn.close()
        return self.send_json({"ok": True, "data": {
            "users": n_users, "posts": n_posts, "pending_posts": n_pending,
            "categories": n_cats, "comments": n_comments, "pending_comments": n_cmts_pending,
            "recent_posts": [dict(r) for r in recent],
            "role": user["role"], "role_name": ROLE_NAMES.get(user["role"]),
        }})

    def api_users_list(self):
        user, err = self.current_user()
        if err:
            return self.send_json({"ok": False, "msg": err}, 401)
        if user["role"] != "super_admin":
            return self.send_json({"ok": False, "msg": "仅超级管理员可查看用户列表"}, 403)
        conn = get_db()
        rows = conn.execute(
            "SELECT id,username,role,nickname,email,status,created_at FROM users ORDER BY id").fetchall()
        conn.close()
        return self.send_json({"ok": True, "data": [dict(r) for r in rows]})

    def api_user_create(self, me, data):
        if me["role"] != "super_admin":
            return self.send_json({"ok": False, "msg": "仅超级管理员可管理用户"}, 403)
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        role = data.get("role") or "user"
        nickname = self._sanitize_name(data.get("nickname"), 30)
        email = self._sanitize_name(data.get("email"), 80)
        if not re.match(r"^[A-Za-z0-9_\-\.]{3,32}$", username):
            return self.send_json({"ok": False, "msg": "用户名需为 3-32 位字母、数字、下划线"})
        if len(password) < 6:
            return self.send_json({"ok": False, "msg": "密码至少 6 位"})
        if role not in ROLES:
            return self.send_json({"ok": False, "msg": "角色不合法"})
        if nickname and re.search(r"[<>\"'`]|script", nickname, re.I):
            return self.send_json({"ok": False, "msg": "昵称包含非法字符"})
        conn = get_db()
        if conn.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            conn.close()
            return self.send_json({"ok": False, "msg": "用户名已存在"})
        conn.execute("INSERT INTO users (username,password,role,nickname,email,created_at) VALUES (?,?,?,?,?,?)",
                     (username, hash_password(password), role, nickname, email, now_str()))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "用户 " + username + " 创建成功（角色：" + ROLE_NAMES.get(role, role) + "）"})

    def api_user_update(self, me, data):
        if me["role"] != "super_admin":
            return self.send_json({"ok": False, "msg": "仅超级管理员可管理用户"}, 403)
        uid = int(data.get("id") or 0)
        nickname = (data.get("nickname") or "").strip()
        email = (data.get("email") or "").strip()
        role = data.get("role") or ""
        status = 1 if data.get("status") in (1, "1", True) else 0
        if role and role not in ROLES:
            return self.send_json({"ok": False, "msg": "角色不合法"})
        conn = get_db()
        row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not row:
            conn.close()
            return self.send_json({"ok": False, "msg": "用户不存在"})
        if row["username"] == "root" and role not in ("", "super_admin"):
            conn.close()
            return self.send_json({"ok": False, "msg": "root 账号角色不可修改"})
        if row["username"] == "root" and status == 0:
            conn.close()
            return self.send_json({"ok": False, "msg": "root 账号不可禁用"})
        sets, params = ["nickname=?", "email=?", "status=?"], [nickname, email, status]
        if role:
            sets.append("role=?")
            params.append(role)
        params.append(uid)
        conn.execute("UPDATE users SET " + ", ".join(sets) + " WHERE id=?", params)
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "用户信息已更新"})

    def api_user_delete(self, me, data):
        if me["role"] != "super_admin":
            return self.send_json({"ok": False, "msg": "仅超级管理员可管理用户"}, 403)
        uid = int(data.get("id") or 0)
        conn = get_db()
        row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not row:
            conn.close()
            return self.send_json({"ok": False, "msg": "用户不存在"})
        if row["username"] == "root":
            conn.close()
            return self.send_json({"ok": False, "msg": "root 账号不可删除"})
        if row["username"] == me["username"]:
            conn.close()
            return self.send_json({"ok": False, "msg": "不能删除当前登录账号"})
        conn.execute("DELETE FROM users WHERE id=?", (uid,))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "用户已删除"})

    def api_user_resetpwd(self, me, data):
        if me["role"] != "super_admin":
            return self.send_json({"ok": False, "msg": "仅超级管理员可管理用户"}, 403)
        uid = int(data.get("id") or 0)
        password = data.get("password") or ""
        if len(password) < 6:
            return self.send_json({"ok": False, "msg": "新密码至少 6 位"})
        conn = get_db()
        if not conn.execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone():
            conn.close()
            return self.send_json({"ok": False, "msg": "用户不存在"})
        conn.execute("UPDATE users SET password=? WHERE id=?", (hash_password(password), uid))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "密码已重置"})

    def api_categories_list(self):
        user, err = self.current_user()
        if err:
            return self.send_json({"ok": False, "msg": err}, 401)
        conn = get_db()
        rows = conn.execute(
            "SELECT c.id,c.name,c.sort,(SELECT COUNT(*) FROM posts p WHERE p.category_id=c.id) AS cnt "
            "FROM categories c ORDER BY c.sort, c.id").fetchall()
        conn.close()
        return self.send_json({"ok": True, "data": [dict(r) for r in rows]})

    def api_category_create(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"})
        name = (data.get("name") or "").strip()
        if not name:
            return self.send_json({"ok": False, "msg": "请输入分类名称"})
        conn = get_db()
        if conn.execute("SELECT 1 FROM categories WHERE name=?", (name,)).fetchone():
            conn.close()
            return self.send_json({"ok": False, "msg": "分类已存在"})
        conn.execute("INSERT INTO categories (name, sort) VALUES (?,?)",
                     (name, int(data.get("sort") or 0)))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "分类已创建"})

    def api_category_update(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"})
        cid = int(data.get("id") or 0)
        name = (data.get("name") or "").strip()
        conn = get_db()
        if not name:
            conn.close()
            return self.send_json({"ok": False, "msg": "请输入分类名称"})
        conn.execute("UPDATE categories SET name=?, sort=? WHERE id=?", (name, int(data.get("sort") or 0), cid))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "分类已更新"})

    def api_category_delete(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"})
        cid = int(data.get("id") or 0)
        conn = get_db()
        conn.execute("UPDATE posts SET category_id=NULL WHERE category_id=?", (cid,))
        conn.execute("DELETE FROM categories WHERE id=?", (cid,))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "分类已删除，该分类下文章已移至未分类"})

    def api_posts_list(self):
        user, err = self.current_user()
        if err:
            return self.send_json({"ok": False, "msg": err}, 401)
        conn = get_db()
        rows = conn.execute(
            "SELECT p.id,p.title,p.status,p.is_top,p.views,p.created_at,p.updated_at,p.source_file,c.name AS category "
            "FROM posts p LEFT JOIN categories c ON p.category_id=c.id ORDER BY p.is_top DESC, p.id DESC").fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["tags"] = [x["name"] for x in conn.execute(
                "SELECT t.name FROM post_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.post_id=? ORDER BY t.id", (r["id"],))]
            d["columns"] = [x["name"] for x in conn.execute(
                "SELECT c.name FROM post_columns pc JOIN columns c ON c.id=pc.column_id WHERE pc.post_id=? ORDER BY c.id", (r["id"],))]
            result.append(d)
        conn.close()
        return self.send_json({"ok": True, "data": result})

    def api_post_create(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"}, 403)
        title = self._sanitize_name(data.get("title"), 200)
        if not title:
            return self.send_json({"ok": False, "msg": "请输入标题"})
        summary = self._sanitize_html((data.get("summary") or "").strip())[:500]
        content = self._sanitize_html(data.get("content") or "")
        conn = get_db()
        cur = conn.execute(
            "INSERT INTO posts (title,category_id,summary,content,status,is_top,views,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,0,?,?)",
            (title, data.get("category_id") or None, summary,
             content, 1 if data.get("status") in (1, "1", True) else 0,
             1 if data.get("is_top") in (1, "1", True) else 0, now_str(), now_str()))
        self._set_post_links(conn, cur.lastrowid, data.get("tags"), data.get("columns"))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "文章《" + title + "》已创建", "id": cur.lastrowid})

    def api_post_update(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"}, 403)
        pid = int(data.get("id") or 0)
        title = self._sanitize_name(data.get("title"), 200)
        if not title:
            return self.send_json({"ok": False, "msg": "请输入标题"})
        summary = self._sanitize_html((data.get("summary") or "").strip())[:500]
        content = self._sanitize_html(data.get("content") or "")
        conn = get_db()
        conn.execute(
            "UPDATE posts SET title=?,category_id=?,summary=?,content=?,status=?,is_top=?,updated_at=? WHERE id=?",
            (title, data.get("category_id") or None, summary,
             content, 1 if data.get("status") in (1, "1", True) else 0,
             1 if data.get("is_top") in (1, "1", True) else 0, now_str(), pid))
        self._set_post_links(conn, pid, data.get("tags"), data.get("columns"))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "文章已更新"})

    def api_post_delete(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"})
        pid = int(data.get("id") or 0)
        conn = get_db()
        conn.execute("DELETE FROM posts WHERE id=?", (pid,))
        conn.execute("DELETE FROM comments WHERE post_id=?", (pid,))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "文章已删除"})

    def api_comments_list(self):
        user, err = self.current_user()
        if err:
            return self.send_json({"ok": False, "msg": err}, 401)
        conn = get_db()
        rows = conn.execute(
            "SELECT m.id,m.post_id,m.author,m.email,m.content,m.status,m.created_at,p.title AS post_title "
            "FROM comments m LEFT JOIN posts p ON m.post_id=p.id ORDER BY m.id DESC").fetchall()
        conn.close()
        return self.send_json({"ok": True, "data": [dict(r) for r in rows]})

    def api_comment_update(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"})
        cid = int(data.get("id") or 0)
        status = 1 if data.get("status") in (1, "1", True) else 0
        conn = get_db()
        conn.execute("UPDATE comments SET status=? WHERE id=?", (status, cid))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "评论状态已更新"})

    def api_comment_delete(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"})
        cid = int(data.get("id") or 0)
        conn = get_db()
        conn.execute("DELETE FROM comments WHERE id=?", (cid,))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "评论已删除"})

    def api_import_posts(self, user):
        """从离线镜像扫描文章 HTML 文件，提取标题与 #标签 导入文章表"""
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"}, 403)
        article_dir = os.path.join(MIRROR_ROOT, "article")
        if not os.path.isdir(article_dir):
            return self.send_json({"ok": False, "msg": "未找到离线镜像文章目录：article"})
        files = [f for f in os.listdir(article_dir)
                 if f.startswith("a_") and f.endswith(".html")]
        conn = get_db()
        imported, skipped, updated, tag_count = 0, 0, 0, 0
        for fn in sorted(files):
            try:
                with open(os.path.join(article_dir, fn), "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
                m = re.search(r"<title>(.*?)</title>", content, re.S)
                title = safe_text(m.group(1), 120) if m else fn
                title = title.replace(" - 清逸的博客", "").replace(" - 原 茜文的博客", "").strip()
                if not title:
                    title = fn
                # 提取 #标签（详情页 <div class="tags"> 区块，格式 "# 标签名"）
                tags_found = []
                m_tags = re.search(r'class="tags"[^>]*>(.*?)</div>', content, re.S)
                if m_tags:
                    tags_found = re.findall(r"#\s*([^<#]{1,40}?)\s*</span>", m_tags.group(1))
                    tags_found = [t.strip() for t in tags_found if t.strip()]
                # 详情页正文摘录作为摘要
                summary = "从离线镜像导入"
                m_sum = re.search(r'class="detail-content"[^>]*>(.*?)</div>', content, re.S)
                if m_sum:
                    txt = re.sub(r"<[^>]+>", "", m_sum.group(1))
                    txt = re.sub(r"\s+", " ", txt).strip()
                    if txt:
                        summary = txt[:200]
                # 提取原发布时间（<time class="detail-date" datetime="2016-1-3 13:54:00">）
                pub_at = None
                m_time = re.search(r'class="detail-date"\s+datetime="([^"]+)"', content)
                if m_time:
                    m_dt = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?", m_time.group(1).strip())
                    if m_dt:
                        try:
                            y, mo, d, h, mi, s = int(m_dt.group(1)), int(m_dt.group(2)), int(m_dt.group(3)), int(m_dt.group(4)), int(m_dt.group(5)), int(m_dt.group(6) or 0)
                            pub_at = "%04d-%02d-%02d %02d:%02d:%02d" % (y, mo, d, h, mi, s)
                        except (ValueError, OverflowError):
                            pub_at = None
                existing = conn.execute("SELECT id,source_file FROM posts WHERE title=?", (title,)).fetchone()
                if existing:
                    # 已存在：补 source_file、摘要、标签与原发布时间（幂等）
                    if pub_at:
                        conn.execute("UPDATE posts SET source_file=?, summary=?, created_at=? WHERE id=?",
                                     (fn, summary, pub_at, existing["id"]))
                    else:
                        conn.execute("UPDATE posts SET source_file=?, summary=? WHERE id=?",
                                     (fn, summary, existing["id"]))
                    pid = existing["id"]
                    updated += 1
                else:
                    cur = conn.execute(
                        "INSERT INTO posts (title,category_id,summary,content,status,is_top,views,source_file,created_at,updated_at) "
                        "VALUES (?,NULL,?,?,1,0,0,?,?,?)",
                        (title, summary, "[" + fn + "]", fn, pub_at or now_str(), now_str()))
                    pid = cur.lastrowid
                    imported += 1
                for tname in tags_found[:8]:
                    row = conn.execute("SELECT id FROM tags WHERE name=?", (tname,)).fetchone()
                    if not row:
                        conn.execute("INSERT INTO tags (name, color) VALUES (?,?)", (tname, "#58a6ff"))
                        tag_id = conn.execute("SELECT id FROM tags WHERE name=?", (tname,)).fetchone()["id"]
                    else:
                        tag_id = row["id"]
                    conn.execute("INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?,?)", (pid, tag_id))
                    tag_count += 1
            except Exception:
                skipped += 1
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "导入完成：新增 " + str(imported) + " 篇，补全 " + str(updated) + " 篇，提取标签 " + str(tag_count) + " 个，跳过 " + str(skipped) + " 篇（已存在或读取失败）"})

    def api_settings_update(self, user, data):
        if user["role"] not in ("super_admin", "admin"):
            return self.send_json({"ok": False, "msg": "权限不足"})
        nickname = (data.get("nickname") or "").strip()
        email = (data.get("email") or "").strip()
        old_pwd = data.get("old_password") or ""
        new_pwd = data.get("new_password") or ""
        conn = get_db()
        row = conn.execute("SELECT * FROM users WHERE username=?", (user["username"],)).fetchone()
        if not row:
            conn.close()
            return self.send_json({"ok": False, "msg": "账号不存在"})
        if nickname or email or (old_pwd and new_pwd):
            conn.execute("UPDATE users SET nickname=?,email=? WHERE id=?", (nickname, email, row["id"]))
        if old_pwd and new_pwd:
            if not verify_password(old_pwd, row["password"]):
                conn.close()
                return self.send_json({"ok": False, "msg": "原密码错误"})
            if len(new_pwd) < 6:
                conn.close()
                return self.send_json({"ok": False, "msg": "新密码至少 6 位"})
            conn.execute("UPDATE users SET password=? WHERE id=?", (hash_password(new_pwd), row["id"]))
        conn.commit()
        conn.close()
        return self.send_json({"ok": True, "msg": "个人资料已更新"})


# ---------- 启动 ----------
def main():
    init_db()
    port = PORT
    host = "127.0.0.1"
    args = [a for a in sys.argv[1:]]
    for i, a in enumerate(args):
        if a == "--port" and i + 1 < len(args):
            port = int(args[i + 1])
        elif a == "--host" and i + 1 < len(args):
            host = args[i + 1]
    server = ThreadingHTTPServer((host, port), Handler)
    print("=" * 52)
    print("  shawn 离线博客 · 管理后台")
    print("  地址: http://{}:{}/admin/".format(host, port))
    print("  超级管理员: root / 123456")
    print("  管理员:     admin / 123456")
    print("  数据库:     data/admin.db")
    print("  按 Ctrl+C 停止服务")
    print("=" * 52)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    import sys
    main()
