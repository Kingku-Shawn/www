/* ============ 装修渲染引擎（共享，支持多页面维度） ============
 * 用法：<script src="js/layout-engine.js"></script>
 *      initLayoutEngine('home' | 'about' | 'articles')
 * 行为：拉取 /api/layout，custom=true 且当前页面有布局时才接管渲染；
 *      未装修保持原生渲染（零影响）。PC/移动端自动选择对应布局。
 * 安全：组件文本全部转义；custom_html 依赖后端白名单清洗；URL 已在后端过滤。 */
(function () {
  "use strict";
  var API = function () { return window.API_BASE || "/api"; };
  var lState = { tag: "", col: "", page: 1, size: 6, sort: "latest", total: 0, box: null };
  var lRoot = null;
  var lTimer = null;
  var lPageKey = "home";

  function lEsc(s) { return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) { return { '&': "&amp;", '<': "&lt;", '>': "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function lDate(s) { return s ? String(s).slice(0, 10) : ""; }
  function isMobile() { return window.innerWidth <= 900; }
  /* 读取 URL 筛选参数（文章详情页/列表页跳转携带 ?col= 分栏 或 ?tag= 标签） */
  function lReadUrlFilter() {
    var m = location.search.match(/[?&]col=([^&]+)/);
    if (m) { try { lState.col = decodeURIComponent(m[1].replace(/\+/g, " ")); } catch (e) { lState.col = m[1]; } }
    m = location.search.match(/[?&]tag=([^&]+)/);
    if (m) { try { lState.tag = decodeURIComponent(m[1].replace(/\+/g, " ")); } catch (e) { lState.tag = m[1]; } }
    if (lState.col) lState.tag = "";
  }
  /* 当前筛选参数拼接到详情链接 */
  function lFilterQuery() {
    if (lState.col) return "?col=" + encodeURIComponent(lState.col);
    if (lState.tag) return "?tag=" + encodeURIComponent(lState.tag);
    return "";
  }

  /* 组件正文渲染 */
  function compBody(c) {
    var p = c.props || {};
    switch (c.type) {
      case "hero":
        return '<section class="hero" style="position:static;height:100%"><div class="hero-card" style="height:100%;box-sizing:border-box">' +
          '<h1>' + lEsc(p.title || "清逸的博客") + '</h1>' +
          '<p>' + lEsc(p.subtitle || "") + '</p>' +
          '<div class="hero-badges">' + (p.tags || []).map(function (t) { return '<span>' + lEsc(t) + '</span>'; }).join("") + '</div></div></section>';
      case "sidebar":
        return '<aside class="side" style="width:100%;height:100%"><div class="sticky" data-lr="sidebar"></div></aside>';
      case "article_list":
        return '<section class="content" style="width:100%;height:100%">' +
          '<div class="sort-tabs">' +
          '<span class="tab ' + (lState.sort === "latest" ? "on" : "") + '" data-lr-sort="latest">最新文章</span>' +
          '<span class="tab ' + (lState.sort === "hot" ? "on" : "") + '" data-lr-sort="hot">热门文章</span>' +
          '</div><div data-lr="posts"></div><div class="pager" data-lr="pager"></div></section>';
      case "tools_grid":
        return '<section class="tools-sec" style="position:static;margin:0;padding:0"><h2 style="margin-bottom:16px">在线工具</h2><div class="tools-grid" data-lr="tools"></div></section>';
      case "text":
        return '<div class="lr-text" style="padding:10px 4px;text-align:' + lEsc(p.align || "left") + '"><h3>' + lEsc(p.title || "") + '</h3><p>' + lEsc(p.content || "") + '</p></div>';
      case "image":
        return p.src ? '<img class="lr-image" src="' + lEsc(p.src) + '" alt="' + lEsc(p.alt || "") + '" loading="lazy">' : '<div style="display:flex;align-items:center;justify-content:center;height:100%;background:#eef2f8;color:#94a3b8;border-radius:14px;font-size:13px">图片</div>';
      case "card":
        return '<a class="lr-card" href="' + (p.url ? lEsc(p.url) : "#") + '" style="text-decoration:none"><h4>' + lEsc(p.title || "卡片") + '</h4><p>' + lEsc(p.desc || "") + '</p></a>';
      case "divider":
        return '<div class="lr-divider"><div class="ln" style="border-top-style:' + lEsc(p.style || "solid") + '"></div></div>';
      case "spacer":
        return '<div class="lr-spacer"></div>';
      case "video":
        return p.src ? '<video class="lr-video" src="' + lEsc(p.src) + '" controls' + (p.autoplay ? ' autoplay muted playsinline' : '') + ' preload="metadata" style="width:100%;height:100%;background:#0b1220;border-radius:14px;object-fit:contain"></video>' :
          '<div style="display:flex;align-items:center;justify-content:center;height:100%;background:#eef2f8;color:#94a3b8;border-radius:14px;font-size:13px">视频</div>';
      case "link_list":
        return '<div class="lr-links"><h3>' + lEsc(p.title || "链接") + '</h3><div class="links-box">' +
          (p.links || []).map(function (x) { return '<a class="link-item" href="' + lEsc(x.url) + '" target="_blank" rel="noopener">' + lEsc(x.text) + '</a>'; }).join("") +
          '</div></div>';
      case "stats":
        return '<div class="lr-stats"><h3>' + lEsc(p.title || "数据统计") + '</h3><div class="stats-box">' +
          (p.stats || []).map(function (x) { return '<div class="stat-item"><b>' + lEsc(x.value) + '</b><span>' + lEsc(x.label) + '</span></div>'; }).join("") +
          '</div></div>';
      case "notice":
        return '<div class="lr-notice" style="' + (p.bg ? 'background:' + lEsc(p.bg) + ';' : '') + '"><span class="nt-badge">公告</span>' + lEsc(p.text || "") + '</div>';
      case "quote":
        return '<blockquote class="lr-quote"><p>' + lEsc(p.text || "") + '</p>' + (p.author ? '' : '') + '</blockquote>';
      case "button":
        return '<a class="lr-btn ' + lEsc(p.theme || "primary") + '" href="' + (p.url ? lEsc(p.url) : "#") + '" style="text-decoration:none">' + lEsc(p.text || "按钮") + '</a>';
      case "code":
        return '<div class="lr-code"><pre><code>' + lEsc(p.content || "") + '</code></pre></div>';
      case "custom_html":
        return '<div class="lr-html">' + (p.content || "") + '</div>';
      case "about_content":
        return '<div class="about-card-wrap" data-lr="about"><div class="about-card"><span class="about-stamp">加载中</span><div class="about-body">加载中…</div></div></div>';
      default:
        return '<div style="padding:20px;color:#94a3b8">' + lEsc(c.type) + '</div>';
    }
  }

  /* 异步组件填充 */
  function fillAsync(el, c) {
    if (c.type === "sidebar") {
      var box = el.querySelector('[data-lr="sidebar"]');
      box.innerHTML = '' +
        '<div class="card profile"><h3>博主</h3><div class="p-name">清逸</div><p class="p-desc">热爱代码与乐器的开发者，偶尔写写文章，折腾硬件与 Web 小工具。</p>' +
        '<div class="p-meta"><span>前端</span><span>机器学习</span><span>开源爱好者</span></div></div>' +
        '<div class="card"><h3>分栏</h3><div class="col-list" data-lr="cols"><span class="loading">加载中</span></div></div>' +
        '<div class="card"><h3>标签</h3><div class="tag-cloud" data-lr="tags"><span class="loading">加载中</span></div></div>' +
        '';
      fetch(API() + "/public/columns.json").then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok) return;
        var cnt = j.data.reduce(function (a, c) { return a + c.cnt; }, 0);
        var html = '<span class="col-item on" data-col="">全部<span class="cnt">' + cnt + '</span></span>';
        j.data.forEach(function (c) { html += '<span class="col-item" data-col="' + lEsc(c.name) + '">' + lEsc(c.name) + '<span class="cnt">' + c.cnt + '</span></span>'; });
        var cols = box.querySelector('[data-lr="cols"]');
        cols.innerHTML = html;
        /* URL 带入的分栏选中态同步 */
        cols.querySelectorAll(".col-item").forEach(function (i) { i.classList.toggle("on", i.getAttribute("data-col") === lState.col); });
      var tags = box.querySelector('[data-lr="tags"]');
      if (tags) fetch(API() + "/public/tags.json").then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok || !j.data.length) { tags.innerHTML = '<span class="tag">暂无标签</span>'; return; }
        var th = "";
        j.data.forEach(function (t) { th += '<span class="tag" data-tag="' + lEsc(t.name) + '"><span class="dot" style="background:' + lEsc(t.color) + '"></span>' + lEsc(t.name) + '</span>'; });
        tags.innerHTML = th;
        tags.querySelectorAll(".tag").forEach(function (i) { i.classList.toggle("on", i.getAttribute("data-tag") === lState.tag); });
        tags.querySelectorAll(".tag").forEach(function (x) { x.onclick = function () { lPickTag(x); }; });
      }).catch(function () {});
        cols.querySelectorAll(".col-item").forEach(function (x) {
          x.onclick = function () {
            lState.col = x.getAttribute("data-col"); lState.tag = ""; lState.page = 1;
            box.querySelectorAll(".col-item").forEach(function (i) { i.classList.toggle("on", i === x); });
            box.querySelectorAll(".tag-cloud .tag").forEach(function (t) { t.classList.remove("on"); });
            lLoadPosts();
          };
        });
      }).catch(function () {});
    }
    if (c.type === "article_list") {
      var tabs = el.querySelectorAll("[data-lr-sort]");
      tabs.forEach(function (t) {
        t.onclick = function () {
          lState.sort = t.getAttribute("data-lr-sort"); lState.page = 1;
          tabs.forEach(function (x) { x.classList.toggle("on", x === t); });
          lLoadPosts();
        };
      });
      lState.box = el.querySelector('[data-lr="posts"]');
      lLoadPosts();
    }
    if (c.type === "tools_grid") {
      var box = el.querySelector('[data-lr="tools"]');
      fetch(API() + "/tools.json").then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok || !j.data.length) { box.innerHTML = '<div class="empty"><b>暂无工具</b></div>'; return; }
        var html = "";
        j.data.forEach(function (t) {
          html += '<a class="tool-card" href="' + lEsc(t.path) + '"><div class="t-ico">' + lEsc((t.name || "").slice(0, 1)) + '</div><div><b>' + lEsc(t.name) + '</b><p>' + lEsc(t.desc || "") + '</p></div></a>';
        });
        box.innerHTML = html;
      }).catch(function () {});
    }
    if (c.type === "about_content") {
      var box = el.querySelector('[data-lr="about"]');
      fetch(API() + "/about.json").then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok || !j.data) { box.innerHTML = '<div class="about-card">内容加载失败</div>'; return; }
        var d = j.data;
        box.innerHTML = '<div class="about-card"><span class="about-stamp">最后更新：' + lEsc(d.created_at || "") + '</span>' +
          '<div class="about-body">' + (d.content || "") + '</div></div>';
      }).catch(function () { box.innerHTML = '<div class="about-card">内容加载失败，请确认离线服务已启动</div>'; });
    }
  }

  function lRenderPager(box) {
    var totalPages = Math.max(1, Math.ceil(lState.total / lState.size));
    if (totalPages <= 1) { box.innerHTML = ""; return; }
    box.innerHTML = '<button data-p="prev" ' + (lState.page <= 1 ? "disabled" : "") + '>上一页</button>' +
      '<button class="pg-cur">' + lState.page + ' / ' + totalPages + '</button>' +
      '<button data-p="next" ' + (lState.page >= totalPages ? "disabled" : "") + '>下一页</button>';
    box.querySelectorAll("button[data-p]").forEach(function (b) {
      b.onclick = function () {
        if (b.disabled) return;
        lState.page += b.getAttribute("data-p") === "next" ? 1 : -1;
        lLoadPosts();
      };
    });
  }

  function lLoadPosts() {
    if (!lState.box) return;
    var box = lState.box;
    box.innerHTML = '<div class="loading"><div class="spin"></div></div>';
    var q = API() + "/public/posts.json";
    fetch(q).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) { box.innerHTML = '<div class="empty"><b>加载失败</b>接口暂不可用</div>'; return; }
      var all = j.data.list.slice();
      if (lState.tag) all = all.filter(function (p) { return (p.tags || []).indexOf(lState.tag) >= 0; });
      if (lState.col) all = all.filter(function (p) { return (p.columns || []).indexOf(lState.col) >= 0; });
      lState.total = all.length;
      var list = all.slice((lState.page - 1) * lState.size, lState.page * lState.size);
      j.data.list = list;
      var list = j.data.list.slice();
      if (lState.sort === "hot") list.sort(function (a, b) { return b.views - a.views; });
      if (!list.length) { box.innerHTML = '<div class="empty"><b>没有匹配的文章</b>换个标签或分栏试试</div>'; }
      else {
        var html = "";
        list.forEach(function (p) {
          var tags = (p.tags || []).map(function (t) { return '<span class="chip">#' + lEsc(t) + '</span>'; }).join("");
          var cols = (p.columns || []).map(function (c) { return '<span class="chip col-chip">' + lEsc(c) + '</span>'; }).join("");
          var href = (p.source_file && p.source_file.indexOf("a_") === 0) ? "article/" + p.source_file + lFilterQuery() : "#";
          html += '<a class="post-card" href="' + href + '"><h2>' + lEsc(p.title) + '</h2>' +
            '<div class="post-meta">' + cols + tags + '<span>发布于 ' + lDate(p.created_at) + '</span><span>阅读 ' + p.views + '</span></div>' +
            '<p>' + lEsc(p.summary || "") + '</p></a>';
        });
        box.innerHTML = html;
      }
      var pg = document.querySelector('[data-lr="pager"]');
      if (pg) lRenderPager(pg);
    }).catch(function () { box.innerHTML = '<div class="empty"><b>加载失败</b>请确认离线服务已启动</div>'; });
  }

  /* 按页面隐藏原生区块 */
  function hideNative(pageKey) {
    var q = null;
    if (pageKey === "home") {
      q = [".hero", "main.layout", ".tools-sec"];
    } else if (pageKey === "about") {
      q = [".wrap"];
    } else if (pageKey === "articles") {
      q = ["main.layout"];
    }
    if (!q) return;
    q.forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el) el.style.display = "none";
    });
  }

  function renderLayout() {
    fetch(API() + "/layout.json").then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok || !j.data || !j.data.custom) return;   // 默认布局保持原生渲染
      var pages = j.data.pages || {};
      var layout = pages[lPageKey];
      if (!layout) return;
      var items = isMobile() ? layout.mobile : layout.pc;
      if (!items || !items.length) return;
      hideNative(lPageKey);
      if (!lRoot) {
        lRoot = document.createElement("div");
        lRoot.id = "layoutRoot";
        lRoot.className = "layout-root";
        var footer = document.querySelector("footer");
        if (footer) { document.body.insertBefore(lRoot, footer); }
        else { document.body.appendChild(lRoot); }
      }
      var maxH = 0;
      items.forEach(function (c) { maxH = Math.max(maxH, c.y + c.h); });
      lRoot.style.height = (maxH + 40) + "px";
      lRoot.innerHTML = "";
      items.slice().sort(function (a, b) { return a.z - b.z; }).forEach(function (c) {
        var el = document.createElement("div");
        el.className = "lr-comp";
        el.style.left = c.x + "%"; el.style.top = c.y + "px";
        el.style.width = c.w + "%"; el.style.height = c.h + "px";
        el.style.zIndex = c.z;
        el.innerHTML = compBody(c);
        lRoot.appendChild(el);
        fillAsync(el, c);
      });
    }).catch(function () {});
  }

  function start() {
    setTimeout(renderLayout, 600);
    window.addEventListener("resize", function () {
      clearTimeout(lTimer);
      lTimer = setTimeout(renderLayout, 300);
    });
  }

  window.initLayoutEngine = function (pageKey) {
    lPageKey = pageKey || "home";
    lReadUrlFilter();
    if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", start); }
    else { start(); }
  };
})();
