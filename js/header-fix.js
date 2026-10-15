/* ============ 清逸的博客 · 全站统一顶栏（与主页完全同构，源码级重写版） ============
 * 1. 所有页面 HTML 中旧 Vue 顶栏 header.xw-header 已整体替换为主页同构顶栏
 *    （header.nav > .nav-in > .logo/.nav-links/.nav-user，位于 #app 之外、body 开头）
 * 2. 本脚本只负责运行期统一管理：规格兜底（NAV_CSS）、选中高亮、登录态、工具开关、
 *    导航文案、移动端汉堡、Vue 页内容留白；对仍有 xw-header 的页面做兜底移除
 * 3. 首页/关于我/文章列表（原生 .nav）、登录页（.site-header）不重复注入
 * 依赖：soulsoft-tools.css（未加载时动态加载）
 */
(function () {
  "use strict";

  function loadCss(href) {
    if (document.querySelector('link[href$="' + href.split("/").pop() + '"]')) return;
    var l = document.createElement("link");
    l.rel = "stylesheet"; l.href = href;
    document.head.appendChild(l);
  }

  /* 相对根路径前缀（按页面目录深度） */
  function depthPrefix() {
    var segs = location.pathname.replace(/^\/+/, "").split("/");
    segs.pop(); // 去掉文件名
    if (!segs.length) return "";
    return segs.map(function () { return ".."; }).join("/") + "/";
  }
  var P = depthPrefix();

  function injectStyle(css) {
    if (document.getElementById("shawn-nav-css")) return;
    var s = document.createElement("style");
    s.id = "shawn-nav-css";
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* 主页顶栏统一样式（与主页 index.html 实际渲染完全一致：fixed z50、58px 白玻璃、渐变 LOGO、胶囊导航、蓝字浅蓝底选中、右侧胶囊登录按钮）
   * 显式 box-sizing:border-box，避免不同页面全局盒模型规则导致细微视觉差异 */
  var NAV_CSS =
    "header.nav,header.nav *,header.site-header,header.site-header *{box-sizing:border-box!important}" +
    "header.nav,header.site-header{position:fixed!important;top:0!important;left:0!important;right:0!important;z-index:50!important;background:var(--gh-card,rgba(255,255,255,.92))!important;backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4);border-bottom:1px solid var(--gh-border,#e4e9f0)!important;box-shadow:0 8px 28px rgba(15,23,42,.05)!important;height:58px!important;padding:0 20px;font-size:16px;line-height:1.6}" +
    "header.xw-header,header.xw-header *{display:none!important;visibility:hidden!important;height:0!important;overflow:hidden!important;pointer-events:none!important}" +
    ".nav-in,.site-header .inner{max-width:1200px!important;margin:0 auto!important;height:100%;display:flex;align-items:center;gap:26px!important;padding:0 24px;width:100%}" +
    ".nav .logo,.site-header .logo{font-size:19px!important;font-weight:800!important;letter-spacing:.5px;white-space:nowrap;text-decoration:none!important;background:linear-gradient(135deg,#2563eb,#0ea5e9)!important;-webkit-background-clip:text!important;background-clip:text!important;-webkit-text-fill-color:transparent!important;color:#2563eb!important}" +
    ".nav-links,.site-nav{display:flex;gap:4px;flex:1;flex-wrap:wrap;font-size:14px}" +
    ".nav-links a,.site-nav a{font-size:14px!important;font-weight:600!important;line-height:1.6!important;color:var(--gh-muted,#5a6a7a)!important;padding:7px 12px!important;border-radius:999px!important;text-decoration:none!important;transition:all .15s ease;white-space:nowrap}" +
    ".nav-links a:hover,.nav-links a.on,.site-nav a:hover,.site-nav a.on{color:#2563eb!important;background:rgba(37,99,235,.08)!important}" +
    ".nav-user{font-size:14px;white-space:nowrap}" +
    ".nav-user a,.header-user a{display:inline-flex!important;align-items:center;gap:6px;color:var(--gh-blue,#2563eb)!important;background:var(--gh-btn,#f4f8ff)!important;border:1px solid var(--gh-border,#e4e9f0)!important;padding:7px 16px!important;border-radius:999px!important;font-size:13px!important;font-weight:600!important;text-decoration:none!important;box-shadow:0 6px 16px rgba(15,23,42,.05);transition:all .15s ease}" +
    ".nav-user a:hover,.header-user a:hover{background:var(--gh-btn-hover,#e9f2ff)!important;transform:translateY(-1px)}" +
    ".nav-user .btn-exit{color:#64748b;margin-left:10px;cursor:pointer;border:0;background:none;font-size:13px;font-weight:600}" +
    /* 下拉菜单项：覆盖上面 .nav-user a 的 inline-flex 胶囊样式，恢复纵向列表 + 深浅色适配 */
    ".nav-user .nav-user-dropdown a{display:block!important;width:100%;align-items:initial;gap:0;color:var(--gh-text,#0f172a)!important;background:transparent!important;border:0!important;padding:9px 14px!important;border-radius:8px!important;font-weight:400!important;box-shadow:none!important;text-align:left}" +
    ".nav-user .nav-user-dropdown a:hover{background:var(--gh-btn,#f3f7fc)!important;transform:none}" +
    ".nav-user .nav-user-dropdown{background:var(--gh-card,#fff)!important;border:1px solid var(--gh-border,#e6edf5)!important}" +
    "@media(max-width:900px){.nav-links,.site-nav{display:none}}";

  function injectNavCss() { injectStyle(NAV_CSS); }

  /* 兜底清理：仍有 Vue 原顶栏的页面（如未替换的旧页面）直接从 DOM 移除 */
  function removeLegacyHeader() {
    document.querySelectorAll("header.xw-header").forEach(function (h) {
      if (h.parentNode) h.parentNode.removeChild(h);
    });
  }

  /* 持续清理旧 Vue 顶栏：Vue 可能在 header-fix 首次运行之后才挂载出 xw-header，
   * 光靠 runDom 的两次移除不够，这里用 MutationObserver 守着，一出现就移除。
   * （NAV_CSS 里已有 display:none 兜底，这里是彻底移出 DOM，释放布局占位。） */
  function watchLegacyHeader() {
    if (!window.MutationObserver) return;
    new MutationObserver(function () {
      var olds = document.querySelectorAll("header.xw-header");
      if (olds.length) {
        olds.forEach(function (h) { if (h.parentNode) h.parentNode.removeChild(h); });
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* 兜底注入：仅当页面完全没有顶栏时注入主页同构顶栏（如部分后台页面） */
  function injectHeader() {
    if (document.querySelector("header.nav, .site-header")) return;
    var navItems = [
      [P + "index.html", "首页", ""],
      [P + "article/index.html", "文章", ""],
      [P + "aboutme/index.html", "关于我", ""]
    ];
    var h = document.createElement("header");
    h.className = "nav injected-nav";
    var inner = document.createElement("div");
    inner.className = "nav-in";
    inner.style.boxSizing = "border-box";
    inner.style.width = "min(1200px, 100%)";
    inner.style.maxWidth = "none";
    inner.style.margin = "0 auto";
    inner.style.padding = "0 24px";
    var logo = document.createElement("a");
    logo.className = "logo";
    logo.href = P + "index.html";
    logo.textContent = "清逸的博客";
    var nav = document.createElement("nav");
    nav.className = "nav-links";
    navItems.forEach(function (it) {
      var a = document.createElement("a");
      a.href = it[0];
      a.textContent = it[1];
      if (it[2]) a.setAttribute("data-tool", it[2]);
      nav.appendChild(a);
    });
    var user = document.createElement("div");
    user.className = "nav-user";
    user.id = "navUser";
    var ua = document.createElement("a");
    ua.href = P + "user/login.html";
    ua.textContent = "登录";
    user.appendChild(ua);
    inner.appendChild(logo);
    inner.appendChild(nav);
    inner.appendChild(user);
    h.appendChild(inner);
    document.body.insertBefore(h, document.body.firstChild);
  }

  /* 登录态渲染（统一读 xw_username；登录页会同时写 xw_username/xw_token/shawn_admin_token）
   * 仅登录/注册页（/user/login）自身负责 navUser 渲染；其余 /user/*（profile/forgot/reset/verify）
   * 仍由本脚本渲染，否则个人页会一直停在静态「登录」。 */
  function renderNavUser() {
    if (/\/user\/login/.test(location.pathname)) return;
    var box = document.getElementById("navUser");
    if (!box) return;
    // 页面已内联渲染过登录态（data-nav-user="ready"），跳过避免重复/覆盖
    if (box.getAttribute("data-nav-user") === "ready") return;
    var u = null;
    var isAdmin = false;
    try {
      u = localStorage.getItem("xw_username");
      var adminToken = localStorage.getItem("shawn_admin_token");
      isAdmin = !!adminToken;
    } catch (e) {}
    box.innerHTML = "";
    if (u) {
      /* 已登录：用户名按钮 + 下拉菜单（个人页 / 后台 / 退出），不再在导航栏直接放「退出」 */
      var wrap = document.createElement("div");
      wrap.className = "nav-user-menu";
      wrap.style.cssText = "position:relative;display:inline-block";

      var uname = document.createElement("button");
      uname.type = "button";
      uname.className = "nav-uname";
      uname.textContent = u;
      uname.setAttribute("aria-haspopup", "true");
      uname.style.cssText = "border:1px solid rgba(148,163,184,.45);background:rgba(148,163,184,.12);color:var(--gh-muted,#475569);cursor:pointer;font-size:13px;font-weight:600;padding:5px 14px;border-radius:999px;line-height:1.4;white-space:nowrap";
      wrap.appendChild(uname);

      var menu = document.createElement("div");
      menu.className = "nav-user-dropdown";
      menu.style.cssText = "position:absolute;top:calc(100% + 6px);right:0;min-width:140px;background:var(--gh-card,#fff);border:1px solid var(--gh-border,#e6edf5);border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.12);padding:6px;z-index:100;display:none";
      menu.innerHTML =
        '<a href="' + P + 'user/profile.html" style="display:block;padding:9px 14px;border-radius:8px;color:var(--gh-text,#0f172a);text-decoration:none;font-size:13.5px">👤 个人中心</a>' +
        '<a href="#" id="navLogoutBtn" style="display:block;padding:9px 14px;border-radius:8px;color:#dc2626;text-decoration:none;font-size:13.5px">退出</a>';
      wrap.appendChild(menu);
      box.appendChild(wrap);

      uname.onclick = function (ev) {
        ev.stopPropagation();
        var open = menu.style.display !== "none";
        menu.style.display = open ? "none" : "block";
      };
      document.addEventListener("click", function (ev) {
        if (!wrap.contains(ev.target)) menu.style.display = "none";
      });
      var logoutLink = menu.querySelector("#navLogoutBtn");
      if (logoutLink) logoutLink.onclick = function (ev) {
        ev.preventDefault();
        try {
          localStorage.removeItem("xw_token");
          localStorage.removeItem("xw_username");
          localStorage.removeItem("shawn_site_token");
          localStorage.removeItem("shawn_site_user");
          localStorage.removeItem("shawn_admin_token");
          localStorage.removeItem("shawn_admin_role");
        } catch (e) {}
        /* 同步清除后端 Cookie 会话 */
        try { fetch(P + "api/user/logout", { method: "POST", credentials: "include" }); } catch (e) {}
        location.reload();
      };
    } else {
      /* 未登录：显示「登录 + 注册」两个按键 */
      var a = document.createElement("a");
      a.href = P + "user/login.html";
      a.textContent = "登录";
      box.appendChild(a);
      var reg = document.createElement("a");
      reg.href = P + "user/login.html#register";
      reg.textContent = "注册";
      reg.style.cssText = "color:#2563eb;font-weight:600;margin-left:12px;";
      box.appendChild(reg);
    }
  }

  /* 当前导航目录 */
  function currentDir() {
    var p = location.pathname;
    if (/\/piano\//.test(p)) return "piano";
    if (/\/music\//.test(p)) return "music";
    if (/\/tiaoyin\//.test(p)) return "tiaoyin";
    if (/\/metronome\//.test(p)) return "metronome";
    if (/\/article\//.test(p)) return "article";
    if (/\/aboutme\//.test(p)) return "aboutme";
    if (/\/user\//.test(p) || /\/auth\//.test(p)) return "";
    return "home";
  }
  function hrefDir(href) {
    if (!href) return "";
    var m = href.match(/([a-z0-9_-]+)\/index\.html$/);
    if (m) return m[1];
    if (href === "/" || href === "../" || href === "..") return "home";
    m = href.match(/^\/([a-z0-9_-]+)\/?$/);
    if (m) return m[1];
    return "";
  }
  /* 选中高亮：与主页一致（.on 类，蓝字浅蓝底） */
  function highlightNav() {
    var cur = currentDir();
    if (!cur) return;
    document.querySelectorAll(".nav-links a, .site-nav a, .header-nav a").forEach(function (a) {
      var href = a.getAttribute("href") || "";
      var target = hrefDir(href);
      if (!target) {
        if (href === "index.html" || href === "./index.html" || href === "" || href === ".") {
          target = cur;
        } else if (/\.\.\/index\.html$/.test(href)) {
          target = "home";
        } else {
          return;
        }
      }
      if (target !== cur) return;
      a.classList.add("on");
      var li = a.closest("li");
      if (li) li.classList.add("active");
    });
  }

  /* 导航文案统一（旧文案 Html5钢琴 等统一为 在线钢琴） */
  function normalizeNavText() {
    document.querySelectorAll(".nav-links a, .site-nav a, .header-nav a").forEach(function (a) {
      var t = a.textContent.trim();
      if (t === "Html5钢琴" || t === "H5钢琴" || t === "H5 钢琴" || t === "在线钢琴Html5" || t === "HTML5钢琴") {
        a.textContent = "在线钢琴";
      }
    });
  }

  /* 工具开关同步：后台关闭的工具在导航隐藏（与主页一致） */
  function syncToolsNav() {
    try {
      fetch("/api/tools.json").then(function (r) { return r.json(); }).then(function (j) {
        if (!j || !j.ok || !j.data) return;
        var enabled = {};
        j.data.forEach(function (t) { if (t.enabled) enabled[t.key] = 1; });
        var map = { "在线钢琴": "piano", "在线乐器": "music", "调音器": "tiaoyin", "节拍器": "metronome" };
        document.querySelectorAll(".nav-links a, .site-nav a, .header-nav a").forEach(function (a) {
          var key = a.getAttribute("data-tool") || map[a.textContent.trim()];
          if (key && !enabled[key]) {
            a.style.display = "none";
          }
        });
      }).catch(function () {});
    } catch (e) {}
  }

  /* 移动端汉堡（统一顶栏使用） */
  function injectHamburger() {
    if (document.querySelector(".mobile-hamburger")) return;
    var header = document.querySelector("header.nav.injected-nav, header.xw-header, header.nav, .site-header");
    if (!header) return;
    var btn = document.createElement("button");
    btn.className = "mobile-hamburger";
    btn.type = "button";
    btn.setAttribute("aria-label", "菜单");
    btn.appendChild(document.createElement("span"));
    var mask = document.createElement("div");
    mask.className = "mobile-drawer-mask";
    var drawer = document.createElement("div");
    drawer.className = "mobile-drawer";
    var logo = document.createElement("div");
    logo.className = "drawer-logo";
    logo.textContent = "清逸的博客";
    var nav = document.createElement("ul");
    nav.className = "drawer-nav";
    var src = header.querySelector(".nav-links, .header-nav, .site-nav");
    if (src) {
      src.querySelectorAll("a").forEach(function (a) {
        var li = document.createElement("li");
        var na = document.createElement("a");
        na.href = a.getAttribute("href") || "#";
        na.textContent = a.textContent.trim();
        li.appendChild(na);
        nav.appendChild(li);
      });
    }
    var userWrap = document.createElement("div");
    userWrap.className = "drawer-user";
    var srcUser = header.querySelector(".nav-user a, .header-user a, .absolute-user a");
    if (srcUser) {
      var ua = document.createElement("a");
      ua.href = srcUser.getAttribute("href") || "#";
      ua.textContent = srcUser.textContent.trim();
      userWrap.appendChild(ua);
    }
    drawer.appendChild(logo);
    drawer.appendChild(nav);
    if (userWrap.children.length) drawer.appendChild(userWrap);
    document.body.appendChild(btn);
    document.body.appendChild(mask);
    document.body.appendChild(drawer);
    function toggle(open) {
      var willOpen = (open === undefined) ? !drawer.classList.contains("open") : open;
      drawer.classList.toggle("open", willOpen);
      mask.classList.toggle("show", willOpen);
      btn.classList.toggle("active", willOpen);
      document.body.style.overflow = willOpen ? "hidden" : "";
    }
    btn.addEventListener("click", function (e) { e.stopPropagation(); toggle(); });
    mask.addEventListener("click", function () { toggle(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") toggle(false); });
  }

  /* ---------- 登录弹窗改造：统一跳转到独立登录页 ----------
   * 旧 Vue 弹窗（login-ensure-modal）存在三个问题：
   *   1. 标题写死「登录 SHAWN.COM」，品牌不符
   *   2. QQ 扫码登录指向 /auth/qq，本部署无回调，点击必失败
   *   3. 账号密码表单需连点 6 次才显示，且无注册入口，与登录页不一致
   * 处理方式：拦截弹窗根节点的出现，点击遮罩/关闭时改为跳转 /user/login.html；
   * 同时兜底拦截 QQ 按钮 /auth/qq 的点击，避免跳到不存在的回调。
   * 这样所有 Vue 页面的「登录」入口都与登录页内容完全一致。
   */
  function normalizeLoginModal() {
    var modal = document.querySelector(".login-ensure-modal");
    if (!modal) return;
    /* 标题改为站点品牌 */
    var head = modal.querySelector(".modal-header");
    if (head && head.textContent.indexOf("SHAWN.COM") >= 0) {
      head.textContent = " 登录 · 清逸的博客 ";
    }
    /* QQ 登录按钮改为跳转登录页（避免 /auth/qq 死链） */
    modal.querySelectorAll('a[href^="/auth/qq"]').forEach(function (a) {
      a.setAttribute("href", P + "user/login.html");
      a.removeAttribute("target");
    });
    /* 「已下线」提示改为可点击的登录页跳转 */
    var dis = modal.querySelector(".pwd-entry-disabled");
    if (dis) {
      dis.textContent = "使用账号密码登录 / 注册 →";
      dis.style.cursor = "pointer";
      dis.style.color = "#2f81f7";
      dis.onclick = function () { window.location.href = P + "user/login.html"; };
    }
  }

  /* 《追加补充.md》FR-X12：PWA —— 注入 manifest + 注册 Service Worker
   * 放在 header-fix 里统一处理，所有页面（含 Worker 动态渲染的详情页）一次生效，
   * 不必逐页改 <head>。失败一律静默，绝不影响页面其它功能。 */
  function installPwa() {
    try {
      if (!document.querySelector('link[rel="manifest"]')) {
        var l = document.createElement("link");
        l.rel = "manifest";
        l.href = P + "manifest.json";
        document.head.appendChild(l);
      }
      if (!document.querySelector('link[rel="icon"]')) {
        var ic = document.createElement("link");
        ic.rel = "icon";
        ic.type = "image/svg+xml";
        ic.href = P + "icons/icon.svg";
        document.head.appendChild(ic);
      }
      /* SW 只在 HTTPS（或 localhost）下可注册；scope 用深度前缀，根页面即 "/" */
      if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
        navigator.serviceWorker.register(P + "sw.js", { scope: P }).catch(function () {});
      }
    } catch (e) { /* 忽略 */ }
  }

  /* 《追加补充.md》NFR-X6：可访问性基础项
   * ① 首个可聚焦元素「跳到正文」；② 统一 :focus-visible 焦点环；
   * ③ 尊重 prefers-reduced-motion；④ 给导航/主区域补 aria-label 与 role（缺失才加，不动既有结构）。 */
  function injectA11y() {
    try {
      /* 先定位主内容容器并确保它有 id，再据此生成跳转链接 */
      var main = document.querySelector(".main-col, .content-container, .wrap, main");
      if (main) {
        if (!main.id) main.id = "main";
        if (!main.getAttribute("role")) main.setAttribute("role", "main");
      }
      var target = main && main.id ? main.id : "main";
      if (!document.getElementById("skipToMain") && document.body) {
        var a = document.createElement("a");
        a.id = "skipToMain";
        a.className = "skip-link";
        a.href = "#" + target;
        a.textContent = "跳到正文";
        if (document.body.firstChild) document.body.insertBefore(a, document.body.firstChild);
        else document.body.appendChild(a);
      }
      if (!document.getElementById("a11y-css")) {
        var s = document.createElement("style");
        s.id = "a11y-css";
        s.textContent =
          ".skip-link{position:absolute;left:-9999px;top:0;z-index:9999;background:#2563eb;color:#fff;padding:10px 16px;border-radius:0 0 10px 0;font-size:14px;text-decoration:none}" +
          ".skip-link:focus{left:0}" +
          "a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,[tabindex]:focus-visible{outline:2px solid #2563eb;outline-offset:2px}" +
          "@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important;scroll-behavior:auto !important}}";
        document.head.appendChild(s);
      }
      var nav = document.querySelector("header.nav .nav-links, header.nav, .site-header");
      if (nav && !nav.getAttribute("aria-label")) nav.setAttribute("aria-label", "站点导航");
    } catch (e) { /* 忽略 */ }
  }

  /* 《追加补充.md》FR-X12：深色模式切换按钮（仅阅读页：首页/文章列表/文章详情页）
   * 挂载到 .nav-in 末尾；并用 MutationObserver 守护——导航容器被任何脚本重建时立即补挂，
   * 根治「一闪而过」的问题。 */
  function injectThemeToggle() {
    try {
      var p = location.pathname;
      var isReadPage =
        /^\/$/.test(p) || /\/index\.html$/.test(p) ||
        /\/article\/index\.html$/.test(p) || /\/article\/a_[a-zA-Z0-9]+\.html$/.test(p) ||
        /\/user\/(profile|forgot|reset|verify)\.html$/.test(p);
      if (!isReadPage) return;

      function ensureButton() {
        var bar = document.querySelector(".nav-in");
        if (!bar) return null;
        var btn = document.getElementById("themeToggle");
        if (btn && btn.parentNode === bar) { refreshLabel(btn); return btn; }
        if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
        btn = document.createElement("button");
        btn.id = "themeToggle";
        btn.type = "button";
        btn.setAttribute("aria-label", "切换深浅色");
        btn.title = "切换深浅色";
        btn.style.cssText = "border:1px solid rgba(148,163,184,.45);background:rgba(148,163,184,.14);color:var(--gh-muted,#5a6a7a);cursor:pointer;font-size:13px;margin-left:4px;padding:4px 12px;border-radius:999px;line-height:1.4;white-space:nowrap";
        btn.onclick = function () {
          var html = document.documentElement;
          var nowDark = html.getAttribute("data-theme") === "dark" ||
            (!html.getAttribute("data-theme") && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
          var next = nowDark ? "light" : "dark";
          html.setAttribute("data-theme", next);
          html.style.colorScheme = next;
          try { localStorage.setItem("blog_theme", next); } catch (e) {}
          refreshLabel(btn);
        };
        bar.appendChild(btn);
        refreshLabel(btn);
        return btn;
      }
      function refreshLabel(btn) {
        if (!btn) return;
        var saved = null;
        try { saved = localStorage.getItem("blog_theme"); } catch (e) {}
        var html = document.documentElement;
        var dark = saved ? saved === "dark" : (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
        if (saved) { html.setAttribute("data-theme", saved); }
        else { html.removeAttribute("data-theme"); }
        html.style.colorScheme = dark ? "dark" : "light";
        btn.textContent = dark ? "☀️ 浅色" : "🌙 深色";
      }

      ensureButton();

      // 守护：导航容器被重建/按钮被移除时立即恢复
      if (window.MutationObserver) {
        new MutationObserver(function () {
          var b = document.getElementById("themeToggle");
          if (!b || !b.isConnected) ensureButton();
        }).observe(document.body, { childList: true, subtree: true });
      }
      // 首屏后延迟再确保一次（覆盖异步渲染的顶栏）
      setTimeout(ensureButton, 300);
      setTimeout(ensureButton, 1200);
    } catch (e) { /* 忽略 */ }
  }

  function run() {
    loadCss(P + "soulsoft-tools.css");
    injectNavCss();
    injectToolCommentsCss();
    installPwa();
    injectA11y();
    injectThemeToggle();
    /* 登录态尽早渲染：run 在 DOMContentLoaded 即执行，比 runDom(600ms) 早得多，
     * 否则首屏会先闪现 HTML 里写死的「登录」，再跳成下拉/登录+注册。 */
    renderNavUser();
  }
  /* ---------- 工具页评论区：删除旧 Vue 组件，换新组件 ----------
   * 旧评论区（.xw-pinlun2 / inline-panel）依赖已下线的旧后端，且样式不统一。
   * 处理：等 Vue 挂载后移除旧组件，在页面底部注入新评论卡（原生 JS，调 /api/pinlun/*）。
   * page_id = 页面路径（如 /piano/），后台评论管理同一数据源。
   * 仅对工具页生效（#app 存在且非文章详情/首页/列表/关于我/登录）。
   */
  function injectToolCommentsCss() {
    if (document.getElementById("tool-comments-css")) return;
    var s = document.createElement("style");
    s.id = "tool-comments-css";
    s.textContent =
      ".tool-comments{max-width:900px;margin:26px auto 40px;padding:22px 26px;background:#fff;border:1px solid #e4e9f0;border-radius:16px;box-shadow:0 8px 24px rgba(15,23,42,.05);font-family:inherit}" +
      ".tool-comments h3{font-size:16px;font-weight:700;color:#2563eb;margin:0 0 14px}" +
      ".tool-comments .tc-list{list-style:none;margin:0;padding:0}" +
      ".tool-comments .tc-item{border-bottom:1px dashed #edf0f4;padding:12px 0}" +
      ".tool-comments .tc-item:last-child{border-bottom:0}" +
      ".tool-comments .tc-name{font-weight:600;font-size:13.5px;color:#1e293b}" +
      ".tool-comments .tc-time{font-size:11.5px;color:#94a3b8;margin-left:10px}" +
      ".tool-comments .tc-content{font-size:14px;color:#334155;margin-top:5px;line-height:1.7;word-break:break-word}" +
      ".tool-comments .tc-empty{color:#94a3b8;font-size:13.5px;text-align:center;padding:18px 0}" +
      ".tool-comments .tc-input{display:flex;gap:10px;margin-top:14px}" +
      ".tool-comments .tc-input textarea{flex:1;border:1px solid #e2e8f0;border-radius:12px;padding:11px 15px;font-size:14px;outline:none;resize:vertical;min-height:56px;font-family:inherit}" +
      ".tool-comments .tc-input textarea:focus{border-color:#2563eb}" +
      ".tool-comments .tc-input button{border:0;background:linear-gradient(135deg,#2563eb,#0ea5e9);color:#fff;border-radius:12px;padding:0 22px;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap}" +
      ".tool-comments .tc-user{display:flex;align-items:center;gap:8px;margin-top:11px;font-size:13px;color:#64748b}" +
      ".tool-comments .tc-user button{border:1px solid #d0d7de;background:#f6f8fa;color:#2563eb;border-radius:8px;padding:4px 14px;font-size:12.5px;font-weight:600;cursor:pointer}" +
      ".tool-comments .tc-user button:hover{background:#e9f2ff}" +
      ".tool-comments .tc-user .uname{color:#2563eb;font-weight:600}" +
      "@media(max-width:720px){.tool-comments{margin:18px 14px 28px;padding:16px}.tool-comments .tc-input{flex-direction:column}.tool-comments .tc-input button{padding:10px 0;width:100%}}";
    document.head.appendChild(s);
  }

  function tcEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toolPageId() {
    return location.pathname.replace(/\/index\.html$/, "/").replace(/\.html$/, "") || "/";
  }

  function isToolPage() {
    /* 文章详情/列表/关于我/登录/首页有自己的评论区或不需要；其余（含 #app 工具页）生效 */
    if (!document.querySelector("#app")) return false;
    var p = location.pathname;
    if (/\/article\/|\/aboutme\/|\/user\/|^\/?$|\/index\.html$/.test(p) && !/\/piano\/|\/music\/|\/tiaoyin\/|\/metronome\/|\/kalimba\/|\/guitar-chords\//.test(p)) return false;
    return true;
  }

  function replaceOldComments() {
    if (!isToolPage()) return;
    /* 删除旧评论区组件 */
    var olds = document.querySelectorAll(".xw-pinlun2, .article-pinlun, .pinlun-list, [class*='inline-panel']");
    if (!olds.length && document.querySelector(".tool-comments")) { loadToolComments(); return; }
    olds.forEach(function (el) { el.remove(); });
    /* 注入新评论卡（若已有则刷新数据） */
    var exist = document.querySelector(".tool-comments");
    if (!exist) {
      var card = document.createElement("div");
      card.className = "tool-comments";
      card.innerHTML =
        '<h3>评论</h3>' +
        '<div class="tc-list" id="tcList"><div class="tc-empty">加载中…</div></div>' +
        '<div class="tc-input"><textarea id="tcText" placeholder="发表一下看法" maxlength="600"></textarea>' +
        '<button id="tcBtn">发送</button></div>' +
        '<div class="tc-user" id="tcUser"><button type="button" onclick="goToolLogin()"> 登录 </button><span> 或 匿名发表评论</span></div>';
      var app = document.querySelector("#app");
      (app || document.body).appendChild(card);
      var btn = document.getElementById("tcBtn");
      if (btn) btn.onclick = publishToolComment;
    }
    loadToolComments();
    renderToolCommentUser();
  }

  function renderToolCommentUser() {
    var row = document.getElementById("tcUser");
    if (!row) return;
    fetch("/api/user/info").then(function (r) { return r.json(); }).then(function (j) {
      if (!(j && j.success && j.data)) return;
      var name = (j.data.profile && j.data.profile.name) || j.data.username || "用户";
      row.innerHTML = '<span class="uname">' + tcEsc(name) + '</span><span>（将以该身份发表评论）</span>';
    }).catch(function () {});
  }

  function loadToolComments() {
    var box = document.getElementById("tcList");
    if (!box) return;
    fetch("/api/pinlun/list", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: toolPageId(), pageIndex: 1 })
    }).then(function (r) { return r.json(); }).then(function (j) {
      var list = (j.success && j.data && j.data.list) || [];
      if (!list.length) { box.innerHTML = '<div class="tc-empty">还没有评论，来抢沙发</div>'; return; }
      box.innerHTML = list.map(function (c) {
        var u = (c.user && c.user.name) || "匿名用户";
        return '<div class="tc-item"><span class="tc-name">' + tcEsc(u) + '</span><span class="tc-time">' + tcEsc(c.time || "") + '</span><div class="tc-content">' + tcEsc(c.content || "") + '</div></div>';
      }).join("");
    }).catch(function () { box.innerHTML = '<div class="tc-empty">评论加载失败</div>'; });
  }

  function publishToolComment() {
    var t = document.getElementById("tcText");
    var btn = document.getElementById("tcBtn");
    if (!t || !btn) return;
    var v = t.value.trim();
    if (!v) { alert("评论内容不能为空"); return; }
    btn.disabled = true; btn.textContent = "发送中…";
    var body = { id: toolPageId(), text: v };
    fetch("/api/user/info").then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.success && j.data) body.name = (j.data.profile && j.data.profile.name) || j.data.username || "";
      return fetch("/api/pinlun/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }).catch(function () {
      return fetch("/api/pinlun/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }).then(function (r) { return r.json(); }).then(function (j) {
      btn.disabled = false; btn.textContent = "发送";
      if (j.success) { t.value = ""; loadToolComments(); } else { alert(j.msg || "发表失败"); }
    }).catch(function () { btn.disabled = false; btn.textContent = "发送"; alert("发表失败，请稍后再试"); });
  }

  function goToolLogin() {
    window.location.href = P + "user/login.html?next=" + encodeURIComponent(location.pathname + location.search);
  }
  window.goToolLogin = goToolLogin;

  function runDom2() {
    /* Vue 挂载较晚，延迟执行评论区替换 */
    setTimeout(replaceOldComments, 1500);
    setTimeout(replaceOldComments, 3500);
  }

  /* 《追加补充.md》FR-X5：顶栏注入「搜索」入口（所有页面共用；已存在则跳过，幂等）
   * 用 P（深度前缀）拼绝对可用的相对路径，兼容 /、/article/、/piano/ 等任意层级。 */
  function injectSearchLink() {
    /* 搜索页自身不注入「搜索」入口（自链无意义）；其余页面导航里已静态写入（data-search="1"），有则跳过 */
    if (/\/search\//.test(location.pathname)) return;
    var nav = document.querySelector(".nav-links, .site-nav, .header-nav");
    if (!nav) return;
    if (nav.querySelector('a[data-search="1"]')) return;
    var a = document.createElement("a");
    a.href = P + "search/index.html";
    a.setAttribute("data-search", "1");
    a.textContent = "搜索";
    nav.appendChild(a);
  }
  function runDom() {
    removeLegacyHeader();
    injectHeader();
    /* 底部空位修复：隐藏旧 Vue footer 残留（其内容已由顶栏/页面自身承载） */
    document.querySelectorAll("footer.xw-footer, footer").forEach(function (f) { f.style.display = "none"; });
    /* 静态顶栏为 fixed（与主页一致）；Vue 页面（含 #app）原 xw-header 移除后内容上顶，需让出顶部 58px。
       首页/关于我/文章列表等原生 .nav 页面本身已预留留白，不额外加。 */
    if (document.querySelector("header.nav") && document.querySelector("#app")) {
      document.body.style.paddingTop = "58px";
    }
    renderNavUser();
    injectThemeToggle();
    normalizeNavText();
    injectHamburger();
    highlightNav();
    syncToolsNav();
    injectSearchLink();
    normalizeLoginModal();
    replaceOldComments();
  }
  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", run); }
  else { run(); }
  watchLegacyHeader();
  setTimeout(runDom, 600);
  setTimeout(runDom, 1800);
  runDom2();
  /* 弹窗是异步挂载的（登录时才出现），用观察器持续监听 */
  (function watchLoginModal() {
    if (!window.MutationObserver) return;
    new MutationObserver(function () { normalizeLoginModal(); })
      .observe(document.body, { childList: true, subtree: true });
  })();
})();
