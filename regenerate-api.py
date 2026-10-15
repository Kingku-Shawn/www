# -*- coding: utf-8 -*-
"""
regenerate-api.py 一键重新生成 GitHub Pages 静态数据

用法：
    python regenerate-api.py

从 admin/data/admin.db 读取最新数据，重新生成 api/ 目录下
posts/columns/tags/comments/tools/about/layout 共 7 个静态 JSON，
前端在纯静态环境（GitHub Pages）下即读取这些文件。
"""
import io
import json
import os
import sqlite3

BLOG = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BLOG, "admin", "data", "admin.db")
API_DIR = os.path.join(BLOG, "api")
PUBLIC_DIR = os.path.join(API_DIR, "public")


def dump(rel_path, obj):
    """写入 JSON（UTF-8，无 BOM，LF 换行）并返回大小"""
    path = os.path.join(API_DIR, rel_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, indent=None)
    io.open(path, "w", encoding="utf-8", newline="").write(text)
    return len(text.encode("utf-8"))


def main():
    if not os.path.exists(DB):
        print("[错误] 数据库不存在:", DB)
        return 1
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    print("数据库已连接:", DB)

    # 1. posts：文章列表（含 tags / columns 数组）
    rows = cur.execute("SELECT * FROM posts ORDER BY created_at DESC").fetchall()
    tag_map = {}
    for r in cur.execute("SELECT pt.post_id, t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id"):
        tag_map.setdefault(r[0], []).append(r[1])
    col_map = {}
    for r in cur.execute("SELECT pc.post_id, c.name FROM post_columns pc JOIN columns c ON c.id = pc.column_id"):
        col_map.setdefault(r[0], []).append(r[1])
    posts = [{
        "id": r["id"],
        "title": r["title"],
        "source_file": r["source_file"],
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
        "views": r["views"],
        "summary": r["summary"] or "",
        "tags": tag_map.get(r["id"], []),
        "columns": col_map.get(r["id"], []),
    } for r in rows]
    size = dump(os.path.join("public", "posts.json"),
                {"ok": True, "data": {"list": posts, "total": len(posts)}})
    print("posts.json:", len(posts), "篇 |", size, "B")

    # 2. columns：分栏（含文章数）
    cols = [{"name": r["name"], "cnt": r["cnt"]} for r in cur.execute(
        "SELECT c.name, (SELECT COUNT(*) FROM post_columns pc WHERE pc.column_id = c.id) cnt FROM columns c")]
    size = dump(os.path.join("public", "columns.json"), {"ok": True, "data": cols})
    print("columns.json:", len(cols), "个分栏 |", size, "B")

    # 3. tags：标签（含颜色与文章数）
    tags = [{"name": r["name"], "color": r["color"], "cnt": r["cnt"]} for r in cur.execute(
        "SELECT t.name, t.color, (SELECT COUNT(*) FROM post_tags pt WHERE pt.tag_id = t.id) cnt FROM tags t")]
    size = dump(os.path.join("public", "tags.json"), {"ok": True, "data": tags})
    print("tags.json:", len(tags), "个标签 |", size, "B")

    # 4. comments：评论列表
    size = dump(os.path.join("public", "comments.json"), {"ok": True, "data": []})
    print("comments.json: 0 条 |", size, "B")

    # 5. tools：工具导航（settings.tools）
    tv = cur.execute("SELECT value FROM settings WHERE key = 'tools'").fetchone()
    tools = json.loads(tv[0]) if tv else []
    size = dump("tools.json", {"ok": True, "data": tools})
    print("tools.json:", len(tools), "个工具 |", size, "B")

    # 6. about：关于我（about_versions 最新版）
    av = cur.execute("SELECT content FROM about_versions ORDER BY id DESC LIMIT 1").fetchone()
    size = dump("about.json", {"ok": True, "data": {"content": av[0] if av else ""}})
    print("about.json:", size, "B")

    # 7. layout：装修配置（未启用时保持默认）
    lv = cur.execute("SELECT value FROM settings WHERE key = 'layout'").fetchone()
    if lv:
        layout_data = json.loads(lv[0])
    else:
        layout_data = {"custom": False, "pages": {}}
    size = dump("layout.json", {"ok": True, "data": layout_data})
    print("layout.json:", size, "B")

    con.close()
    print("完成，api/ 静态数据已全部重新生成。推送 git 后 GitHub Pages 自动更新。")


if __name__ == "__main__":
    raise SystemExit(main())
