/* ============ 清逸的博客 · 搜索页脚本（/search/index.html 专用，避免页面内联大段脚本）============
 * 接口：GET /api/public/search?q=&page=&pageSize=（Worker 的 handleSearch，{ok} 契约）
 *
 * ⚠ 数据安全约定（务必照此渲染，否则会双重转义）：
 *   接口返回的 title / summary / source_file / created_at 都是**服务端已做过 HTML 转义**的文本，
 *   title_html 更是在转义基础上插入了 <mark>。所以这些字段直接写进 innerHTML 即可，
 *   千万不要再 esc() 一次 —— 否则 & 会变成 &amp;amp;，页面上显示成 &amp; 这类乱码。
 *   本文件里的 esc() 只用于接口**未转义**的文本（如 ok:false 时的 msg）。
 *   href 取 url 字段并做白名单校验（只允许 /article/<文件名>.html 形态），避免属性注入。
 */
(function () {
  "use strict";

  var API = "/api/public/search";
  var PAGE_SIZE = 10;                 // 与后端默认值一致；后端上限 50
  var MAX_Q_LEN = 100;                // 与后端 q 截断长度一致
  var state = { q: "", page: 1, total: 0, hasMore: false, engine: "like", loading: false };

  var form = document.getElementById("searchForm");
  var input = document.getElementById("searchInput");
  var btn = document.getElementById("searchBtn");
  var meta = document.getElementById("searchMeta");
  var listBox = document.getElementById("resultList");
  var moreBtn = document.getElementById("moreBtn");

  /** 仅用于未转义文本（j.msg 之类）；搜索结果字段是服务端已转义的，不能再用它 */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /** 详情页链接白名单：只认 /article/<文件名>.html（与 Worker 的 normSourceFile 口径一致） */
  function safeUrl(u) {
    u = String(u == null ? "" : u);
    return /^\/article\/[A-Za-z0-9_.\-]+\.html$/.test(u) ? u : "";
  }

  /** 同步地址栏（不新增历史记录）：/search/index.html?q=xxx */
  function syncUrl(q) {
    var next = q ? "/search/index.html?q=" + encodeURIComponent(q) : "/search/index.html";
    try { history.replaceState(null, "", next); } catch (e) { /* 个别环境禁止 replaceState，忽略 */ }
  }

  function readUrlQ() {
    try {
      var q = String(new URLSearchParams(location.search).get("q") || "");
      return q.trim().slice(0, MAX_Q_LEN);
    } catch (e) {
      return "";
    }
  }

  function renderMeta() {
    if (!state.q || !state.total) { meta.innerHTML = ""; return; }
    // 这里的值全是 number / 内部枚举，直接拼接是安全的
    var tip = state.engine === "fts5" ? "全文索引" : "关键词匹配";
    meta.innerHTML = "共 <b>" + state.total + "</b> 条结果 · 第 " + state.page + " 页 · " + tip;
  }

  /** 单个结果卡片。title_html 为服务端成品（已转义 + <mark>），summary/created_at 同为已转义文本 */
  function cardHtml(it) {
    var href = safeUrl(it.url);
    var titleHtml = it.title_html || it.title || "";
    var date = String(it.created_at || "").slice(0, 10);
    var views = Number(it.views || 0) || 0;
    var inner =
      "<h2>" + titleHtml + "</h2>" +
      (it.summary ? "<p>" + it.summary + "</p>" : "") +
      "<div class=\"pc-meta\">" +
        "<span class=\"pc-meta-item\">阅读 " + views + "</span>" +
        (date ? "<span class=\"pc-meta-item\">" + date + "</span>" : "") +
      "</div>";
    // source_file 为空（url 为空串）时退化成不可点的卡片
    if (!href) return "<div class=\"post-card\">" + inner + "</div>";
    return "<a class=\"post-card\" href=\"" + href + "\">" + inner + "</a>";
  }

  function setBusy(busy) {
    state.loading = busy;
    btn.disabled = busy;
    moreBtn.disabled = busy;
  }

  /** 请求第 page 页；append=true 时把结果追加到列表末尾（「加载更多」） */
  function load(append) {
    if (state.loading) return;
    var q = state.q;

    // 空关键词：不请求接口，直接给引导态
    if (!q) {
      listBox.innerHTML = "<div class=\"empty\"><b>输入关键词开始搜索</b>标题、摘要、正文里的中文子串都能搜到</div>";
      meta.innerHTML = "";
      moreBtn.hidden = true;
      return;
    }

    var page = append ? state.page + 1 : 1;
    if (!append) listBox.innerHTML = "<div class=\"loading\"><div class=\"spin\"></div></div>";
    setBusy(true);

    fetch(API + "?q=" + encodeURIComponent(q) + "&page=" + page + "&pageSize=" + PAGE_SIZE, {
      headers: { "accept": "application/json" }
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        setBusy(false);
        if (!j || !j.ok) {
          // ok:false 是「搜索服务暂时不可用」，msg 未转义，这里要 esc
          if (!append) {
            listBox.innerHTML = "<div class=\"empty\"><b>搜索失败</b>" + esc(j && j.msg ? j.msg : "请稍后再试") + "</div>";
          } else {
            alert("加载失败，请稍后再试");
          }
          return;
        }
        var d = j.data || {};
        var list = d.list || [];
        state.page = Number(d.page) || page;
        state.total = Number(d.total) || 0;
        state.hasMore = !!d.has_more;
        state.engine = j.engine === "fts5" ? "fts5" : "like";

        if (!append) listBox.innerHTML = "";
        if (!list.length) {
          if (!append) listBox.innerHTML = "<div class=\"empty\"><b>没有找到相关文章</b>换个更短或更常见的关键词试试</div>";
        } else {
          listBox.insertAdjacentHTML("beforeend", list.map(cardHtml).join(""));
        }
        renderMeta();
        moreBtn.hidden = !state.hasMore;
      })
      .catch(function () {
        setBusy(false);
        if (!append) listBox.innerHTML = "<div class=\"empty\"><b>加载失败</b>请检查网络后重试</div>";
        else alert("加载失败，请稍后再试");
      });
  }

  /* 表单提交：回车与「搜索」按钮共用这条路径（preventDefault 后走 fetch，不整页刷新）。
     没有 JS 时表单仍会 GET 到 /search/index.html?q=…，本脚本初始化时能读回来 —— 渐进增强。 */
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = String(input.value || "").trim().slice(0, MAX_Q_LEN);
    input.value = q;
    state.q = q;
    state.page = 1;
    state.hasMore = false;
    syncUrl(q);
    load(false);
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e2) { window.scrollTo(0, 0); }
  });

  moreBtn.addEventListener("click", function () {
    if (!state.hasMore || state.loading) return;
    load(true);
  });

  /* 初始化：从 ?q= 回填输入框并直接搜一次 */
  (function init() {
    var q = readUrlQ();
    input.value = q;
    state.q = q;
    load(false);
  })();
})();
