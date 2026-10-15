/* ============ 清逸的博客 · 文章详情页增强 ============
 * PC 端：正文 + 右侧 sticky 悬浮窗（最新更新 / 分栏文章）双列布局
 *   顶部栏
 *   ┌──────────────────────┐┌──────────┐
 *   │ 正文居中显示（图文）  ││ 最新更新  │ ← sticky 滚动跟随
 *   │ 上一篇 | 下一篇（并排）││ 分栏文章  │
 *   │ 评论区（等宽）        │└──────────┘
 *   └──────────────────────┘
 * 移动端（≤960px）：正文 → 上一篇/下一篇（竖排）→ 最近更新 → 评论区
 * 数据源：
 *   - article/meta.json         → 最新更新列表 + 上/下篇（含 date，可排序）
 *   - /api/public/posts.json    → 后台分栏体系（columns 字段）归类
 * 可选 ?col=分栏 / ?tag=标签 筛选
 */
(function () {
  "use strict";

  var CURRENT_FILE = location.pathname.split("/").pop();

  /* 阅读量打点：详情页打开时 +1（幂等：同一会话同一文章只计一次，交给 Worker /api/view） */
  function trackView() {
    try {
      if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return;
      var art = readState();
      var id = (art && art.id) || (window.__PINIA_STATE__ && window.__PINIA_STATE__.id) || CURRENT_FILE;
      if (!id) return;
      var seenKey = "blog_viewed_" + String(id);
      var seen = null;
      try { seen = sessionStorage.getItem(seenKey); } catch (e) {}
      if (seen) return;
      try { sessionStorage.setItem(seenKey, "1"); } catch (e) {}
      fetch("/api/view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_file: CURRENT_FILE, id: id })
      }).catch(function () {});
    } catch (e) {}
  }

  function readState() {
    try {
      var st = window.__PINIA_STATE__;
      return (st && st.article) ? st.article : null;
    } catch (e) { return null; }
  }

  function qs(name) {
    var m = location.search.match(new RegExp("[?&]" + name + "=([^&]+)"));
    if (m) { try { return decodeURIComponent(m[1].replace(/\+/g, " ")); } catch (e) { return m[1]; } }
    return "";
  }

  function fmtDate(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var ENH_CSS =
    /* ---- 页面骨架：双列 Grid ---- */
    ".page-container{width:100%!important;max-width:1200px!important;margin:0 auto!important;padding:0 24px;box-sizing:border-box;display:block!important}" +
    ".content-container{display:grid!important;grid-template-columns:minmax(0,1fr) 240px;gap:28px;width:100%!important;max-width:none!important;box-sizing:border-box;align-items:start}" +
    /* ---- 正文列（grid-column:1）---- */
    ".detail-wrapper{max-width:820px;margin:0 auto;width:100%;min-width:0;box-sizing:border-box;grid-column:1}" +
    ".article-pager{max-width:820px;margin:0 auto;width:100%;box-sizing:border-box;padding:20px 0 6px;display:flex;gap:14px;grid-column:1}" +
    ".xw-pinlun2,.article-pinlun{max-width:820px!important;margin:0 auto!important;width:100%!important;box-sizing:border-box;grid-column:1}" +
    /* ---- 右侧 sticky 悬浮窗 ---- */
    ".recent-container{position:sticky!important;top:74px;margin:0!important;padding:0!important;box-sizing:border-box;grid-column:2;grid-row:1;display:flex;flex-direction:column;gap:16px}" +
    ".recent-container .recent-block{width:100%!important;max-width:100%!important;box-sizing:border-box;background:#fff;border:1px solid #e4e9f0;border-radius:12px;padding:16px;box-shadow:0 6px 20px rgba(15,23,42,.08)}" +
    ".category-list-head{font-size:14px;font-weight:700;color:#2563eb;margin-bottom:12px}" +
    ".recent-list{list-style:none;margin:0;padding:0}" +
    ".recent-list li{border-bottom:1px dashed #edf0f4;padding:9px 0}" +
    ".recent-list li:last-child{border-bottom:0}" +
    ".recent-list a{display:block;color:#334155;font-size:13px;line-height:1.5;text-decoration:none;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}" +
    ".recent-list a:hover{color:#2563eb}" +
    ".recent-list time{display:block;color:#94a3b8;font-size:11px;margin-top:3px}" +
    ".col-group-name{font-size:12px;color:#64748b;font-weight:600;margin:12px 0 4px;padding-top:8px;border-top:1px solid #f1f5f9}" +
    ".col-group-name:first-child{margin-top:0;padding-top:0;border-top:0}" +
    /* ---- 上一篇 / 下一篇 ---- */
    ".article-pager a{flex:1 1 0;min-width:0;display:block;background:#fff;border:1px solid #e4e9f0;border-radius:12px;padding:12px 16px;text-decoration:none;transition:all .15s ease;box-shadow:0 6px 20px rgba(15,23,42,.04)}" +
    ".article-pager a:hover{border-color:#2563eb;transform:translateY(-1px)}" +
    ".article-pager .ap-label{display:block;font-size:11px;color:#94a3b8;margin-bottom:4px}" +
    ".article-pager .ap-title{display:block;color:#1e293b;font-size:14px;font-weight:600;line-height:1.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}" +
    ".article-pager .ap-date{display:block;color:#94a3b8;font-size:12px;margin-top:5px}" +
    ".article-pager a.disabled{opacity:.45;pointer-events:none}" +
    ".article-pager a.ap-next{text-align:right}" +
    /* ---- 清理多余框架 / 底部残留 ---- */
    "footer.xw-footer{display:none!important}" +
    "#app,#main,.page-container{min-height:auto!important;padding-bottom:0!important;margin-bottom:0!important}" +
    "body{background:#f5f7fb!important}",
    /* ---- 详情页正文风格（参考 soulsoft/blog：白卡 + 蓝标题 + 元信息胶囊）---- */
    ".detail-wrapper{background:#fff!important;border:1px solid #e4e9f0!important;border-radius:18px!important;padding:36px 40px!important;box-shadow:0 10px 30px rgba(15,23,42,.05)!important}" +
    ".detail-header .detail-title{font-size:28px!important;font-weight:800!important;line-height:1.4!important;color:#0f172a!important;text-align:left!important;margin:0 0 18px!important}" +
    ".detail-section{display:flex!important;align-items:center!important;gap:16px!important;padding:14px 16px!important;margin:0 0 22px!important;background:#f8fafc!important;border:1px solid #eef2f7!important;border-radius:12px!important}" +
    ".detail-section .detail-headimg{float:none!important;flex:none!important;width:44px!important;height:44px!important;border-radius:50%!important;overflow:hidden!important;border:2px solid #fff!important;box-shadow:0 2px 8px rgba(15,23,42,.12)!important}" +
    ".detail-section .detail-headimg img{width:44px!important;height:44px!important;max-height:none!important;object-fit:cover!important}" +
    ".detail-section .detail-headinfo{float:none!important;margin:0!important;font-size:13px!important;color:#64748b!important}" +
    ".detail-section .tags span{display:inline-block!important;margin-right:8px!important;padding:2px 10px!important;background:#eef2ff!important;color:#4f46e5!important;border-radius:999px!important;font-size:12px!important}" +
    ".detail-content{font-size:16px!important;line-height:1.9!important;color:#1e293b!important}" +
    ".detail-content h2{font-size:22px!important;margin:28px 0 14px!important;padding-left:12px!important;border-left:4px solid #2563eb!important}" +
    ".detail-content h3{font-size:18px!important;margin:22px 0 12px!important}" +
    ".detail-content p{margin:12px 0!important}" +
    ".detail-content img{border-radius:12px!important;margin:16px 0!important;box-shadow:0 6px 20px rgba(15,23,42,.08)!important}" +
    ".detail-content pre{background:#0f172a!important;color:#e2e8f0!important;border-radius:12px!important;padding:18px!important;overflow-x:auto!important;font-size:13.5px!important;line-height:1.7!important}" +
    ".detail-content code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace!important}" +
    ".detail-content p code,.detail-content li code{background:#eef2ff!important;color:#4f46e5!important;padding:2px 7px!important;border-radius:6px!important;font-size:13.5px!important}" +
    ".detail-content blockquote{border-left:4px solid #0ea5e9!important;background:#f0f9ff!important;padding:14px 18px!important;border-radius:0 12px 12px 0!important;margin:16px 0!important;color:#475569!important}" +
    ".detail-content table{border-collapse:collapse!important;width:100%!important;margin:16px 0!important;font-size:14px!important}" +
    ".detail-content th{background:#f8fafc!important;font-weight:700!important;padding:10px 14px!important;border:1px solid #e2e8f0!important;text-align:left!important}" +
    ".detail-content td{padding:10px 14px!important;border:1px solid #e2e8f0!important}" +
    ".detail-content a{color:#2563eb!important;text-decoration:underline!important;text-underline-offset:3px!important}",
    /* ---- 移动端（≤960px）：单列竖排 ---- */
    "@media(max-width:960px){" +
    ".page-container{padding:0 12px!important}" +
    ".content-container{display:block!important}" +
    ".detail-wrapper{max-width:100%!important;padding:24px 18px!important;border-radius:14px!important}" +
    ".detail-header .detail-title{font-size:22px!important}" +
    ".article-pager{max-width:100%!important;flex-direction:column;gap:10px}" +
    ".article-pager a{width:100%}" +
    ".article-pager a.ap-next{text-align:left}" +
    ".xw-pinlun2,.article-pinlun{max-width:100%!important}" +
    ".recent-container{position:static!important;top:auto;width:100%!important;max-width:100%!important;margin:14px 0 0!important}" +
    ".detail-wrapper img,.detail-content img,.article-detail img{max-width:100%!important;height:auto!important}" +
    ".detail-content,.article-detail{overflow-wrap:break-word;word-break:break-word}" +
    ".detail-content pre,.detail-content code{max-width:100%;overflow-x:auto;white-space:pre-wrap}" +
    ".detail-content table{max-width:100%;display:block;overflow-x:auto}" +
    ".detail-content iframe,.detail-content video{max-width:100%}" +
    "}";

  function injectStyle() {
    if (document.getElementById("article-enh-css")) return;
    var s = document.createElement("style");
    s.id = "article-enh-css";
    s.textContent = ENH_CSS;
    document.head.appendChild(s);
  }

  var mqMobile = window.matchMedia("(max-width:960px)");

  /* 把悬浮窗安置到正确位置：PC 放 content-container 网格右列；移动端放评论区之前 */
  function placeRecent(recent) {
    if (!recent) return;
    var container = document.querySelector(".content-container");
    var pinlun = document.querySelector(".xw-pinlun2, .article-pinlun");
    if (mqMobile.matches) {
      var target = pinlun || container || document.body;
      if (target && target.parentNode && recent.parentNode !== target.parentNode) {
        target.parentNode.insertBefore(recent, target);
      }
    } else {
      if (container && recent.parentNode !== container) {
        container.appendChild(recent);
      }
    }
  }

  /* 构建右侧悬浮窗：最新更新（meta.json）+ 分栏文章（posts.json 的 columns） */
  function buildRecentSidebar(metaPosts, colPosts, col, tag) {
    document.querySelectorAll(".recent-container").forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    var recent = document.createElement("div");
    recent.className = "recent-container";

    /* 块1：最新更新（按 meta.json 的 date 降序） */
    var block1 = document.createElement("div");
    block1.className = "recent-block";
    var head1 = document.createElement("div");
    head1.className = "category-list-head";
    head1.textContent = col || tag ? "最新更新（" + (col || tag) + "）" : "最新更新";
    var ul1 = document.createElement("ul");
    ul1.className = "recent-list";
    var n = Math.min(8, metaPosts.length);
    for (var i = 0; i < n; i++) {
      var p = metaPosts[i];
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = p.file + (col ? "?col=" + encodeURIComponent(col) : "") + (tag ? "?tag=" + encodeURIComponent(tag) : "");
      a.textContent = p.title;
      var tm = document.createElement("time");
      tm.textContent = fmtDate(p.date);
      li.appendChild(a);
      li.appendChild(tm);
      ul1.appendChild(li);
    }
    block1.appendChild(head1);
    block1.appendChild(ul1);
    recent.appendChild(block1);

    /* 块2：分栏文章（后台 columns 体系） */
    var colMap = {};
    (colPosts || []).forEach(function (p) {
      var cols = p.columns || p.column || [];
      if (typeof cols === "string") cols = [cols];
      cols.forEach(function (c) {
        if (!c) return;
        if (!colMap[c]) colMap[c] = [];
        colMap[c].push(p);
      });
    });
    var colNames = Object.keys(colMap);
    if (colNames.length) {
      var block2 = document.createElement("div");
      block2.className = "recent-block";
      var head2 = document.createElement("div");
      head2.className = "category-list-head";
      head2.textContent = "分栏文章";
      block2.appendChild(head2);
      colNames.forEach(function (cname) {
        var h = document.createElement("div");
        h.className = "col-group-name";
        h.textContent = cname;
        block2.appendChild(h);
        var ul = document.createElement("ul");
        ul.className = "recent-list";
        colMap[cname].slice(0, 6).forEach(function (p) {
          var li = document.createElement("li");
          var a = document.createElement("a");
          a.href = p.source_file || p.file;
          a.textContent = p.title;
          li.appendChild(a);
          ul.appendChild(li);
        });
        block2.appendChild(ul);
      });
      recent.appendChild(block2);
    }

    document.body.appendChild(recent);
    placeRecent(recent);
  }

  function buildPager(list, idx, col, tag) {
    var detail = document.querySelector(".detail-wrapper");
    if (!detail) return;
    var nav = document.createElement("nav");
    nav.className = "article-pager";
    var q = (col ? "?col=" + encodeURIComponent(col) : "") + (tag ? "?tag=" + encodeURIComponent(tag) : "");
    var prev = list[idx - 1];
    var next = list[idx + 1];
    function mk(p, label, cls) {
      var a = document.createElement("a");
      a.className = cls;
      if (p) {
        a.href = p.file + q;
        var l = document.createElement("span");
        l.className = "ap-label";
        l.textContent = label;
        var t = document.createElement("span");
        t.className = "ap-title";
        t.textContent = p.title;
        var d = document.createElement("span");
        d.className = "ap-date";
        d.textContent = fmtDate(p.date);
        a.appendChild(l); a.appendChild(t); a.appendChild(d);
      } else {
        a.classList.add("disabled");
        var l2 = document.createElement("span");
        l2.className = "ap-label";
        l2.textContent = label;
        var t2 = document.createElement("span");
        t2.className = "ap-title";
        t2.textContent = "没有更新的一篇";
        a.appendChild(l2); a.appendChild(t2);
      }
      return a;
    }
    nav.appendChild(mk(prev, "上一篇", "ap-prev"));
    nav.appendChild(mk(next, "下一篇", "ap-next"));
    if (detail.nextSibling) detail.parentNode.insertBefore(nav, detail.nextSibling);
    else detail.parentNode.appendChild(nav);
  }

  function run() {
    injectStyle();
    var art = readState();
    if (!art) return;
    document.querySelectorAll(".recent-container, .article-pager").forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    document.querySelectorAll(".side-container").forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });

    var col = qs("col");
    var tag = qs("tag");
    var colFiles = null;
    var needCol = col && !tag;

    function inScope(p) {
      if (tag) return (p.tags || []).concat(p.category || []).indexOf(tag) >= 0;
      if (col) {
        if (colFiles && colFiles.length) return colFiles.indexOf(p.file) >= 0;
        return (p.category || []).concat(p.tags || []).indexOf(col) >= 0;
      }
      return true;
    }

    /* 分栏体系（columns）数据源：posts.json 每条 {source_file, title, columns} */
    function fetchColumnPosts() {
      return fetch("/api/public/posts.json")
        .then(function (r) { return r.json(); })
        .then(function (j) {
          return (j && j.data && j.data.list) || [];
        })
        .catch(function () { return []; });
    }

    function render(meta) {
      var all = (meta && meta.posts) || [];
      var scoped = all.filter(inScope);
      var idx = -1;
      for (var i = 0; i < scoped.length; i++) {
        if (scoped[i].file === CURRENT_FILE) { idx = i; break; }
      }
      /* 最新更新 + 上/下篇用 meta.json；分栏文章用 posts.json 的 columns */
      fetchColumnPosts().then(function (colPosts) {
        buildRecentSidebar(scoped, colPosts, col, tag);
      });
      buildPager(scoped, idx, col, tag);
    }

    if (needCol) {
      fetchColumnPosts().then(function (list) {
        if (list && list.length) {
          colFiles = list.filter(function (p) {
            var cols = p.columns || p.column || [];
            return (typeof cols === "string" ? [cols] : cols).indexOf(col) >= 0;
          }).map(function (p) { return p.file || p.source_file; });
        }
        fetch("meta.json").then(function (r) { return r.json(); }).then(render).catch(function () { render(null); });
      });
      return;
    }
    fetch("meta.json").then(function (r) { return r.json(); }).then(render).catch(function () { render(null); });
  }

  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", run); }
  else { run(); }
  trackView();
  setTimeout(run, 600);
  setTimeout(run, 1800);

  var _lastMq = mqMobile.matches;
  window.addEventListener("resize", function () {
    var now = mqMobile.matches;
    if (now !== _lastMq) {
      _lastMq = now;
      placeRecent(document.querySelector(".recent-container"));
    }
  });
})();
