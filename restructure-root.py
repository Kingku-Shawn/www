# -*- coding: utf-8 -*-
import os, re, io
ROOT = r"D:\Code library\shareit\blog"
EXTS = (".html", ".js", ".css", ".json")
LOG = r"D:\Code library\shareit\blog\restructure-root.log"
logs = []
def log(s): logs.append(str(s))
files = []
for dp, dn, fn in os.walk(ROOT):
    if "\\backup" in dp or "\\.git" in dp or "\\admin\\data" in dp:
        continue
    for f in fn:
        if f.lower().endswith(EXTS):
            files.append(os.path.join(dp, f))
log("待处理文件数: %d" % len(files))
footer_re = re.compile(r"<footer[^>]*>.*?</footer>", re.S | re.I)
copyright_re = re.compile(r"<p[^>]*>.*?(粤ICP备|离线镜像|由 Doubao|ICP备案).*?</p>", re.S | re.I)
def fix_rel(m):
    prefix = m.group(1)
    return (prefix[3:] if prefix.startswith("../") else prefix) + "o"
def fix_cdn(m):
    prefix = m.group(1)
    return (prefix[3:] if prefix.startswith("../") else prefix) + "cdn.jsdelivr.net"
n_www = n_oshawn = n_cdn = n_footer = changed = 0
for path in files:
    try:
        c = io.open(path, encoding="utf-8", errors="ignore").read()
    except Exception as e:
        log("读取失败: %s %r" % (path, e)); continue
    orig = c
    c, k = re.subn(r"/www\.shawn\.com/", "/", c); n_www += k
    c, k = re.subn(r"((?:\.\./)+)o\.shawn\.com", fix_rel, c); n_oshawn += k
    c, k = re.subn(r"(?<![\w.])o\.shawn\.com", "o", c); n_oshawn += k
    c, k = re.subn(r"((?:\.\./)+)cdn\.jsdelivr\.net", fix_cdn, c); n_cdn += k
    c, k = footer_re.subn("", c); n_footer += k
    c, k = copyright_re.subn("", c); n_footer += k
    if c != orig:
        try:
            io.open(path, "w", encoding="utf-8", newline="").write(c)
            changed += 1
        except Exception as e:
            log("写入失败: %s %r" % (path, e))
log("www替换: %d | o.shawn替换: %d | cdn替换: %d | 版权块: %d | 变更文件: %d" % (n_www, n_oshawn, n_cdn, n_footer, changed))
io.open(LOG, "w", encoding="utf-8", newline="").write("\n".join(logs))
print("done")