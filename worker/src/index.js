/**
 * 清逸的博客 · Cloudflare Worker（动态后端）
 * ------------------------------------------------------------------
 * 站点：https://blog.qingyi.dpdns.org/  （Cloudflare 代理）
 * 静态站：GitHub Pages（已设置自定义域名 blog.qingyi.dpdns.org，直出，不经 Worker）
 * 动态数据：Cloudflare D1（env.DB，见 wrangler.toml）
 *
 * 拓扑（避免回源死循环）：
 *   浏览器 ──► Cloudflare
 *                ├─ 非 /api/*（首页/文章/工具/图片等）──► GitHub Pages（直出）
 *                └─ /api/* 路由 ──► 本 Worker ──► D1
 *
 * 职责：
 *   1. /api/public/posts.json —— 从 raw.githubusercontent.com 读取静态列表，
 *      并把 D1 里的阅读量合并进 views 字段（“阅读 N”与“热门文章”排序生效）
 *   2. /api/view                 —— 文章详情页打点 +1 阅读量
 *   3. /api/pinlun/*             —— 评论系统（list / publish / replies / vote / del）
 *   4. 其余扩展能力（SEO/订阅源/搜索/点赞收藏/评论审核与风控/限流审计/密码重置与邮箱验证/
 *      访问统计/订阅与通知/用户体系/内容运营）—— 全部拆到 ./features/*.js 独立模块（零依赖），
 *      由本文件 import 并接线；模块清单与职责见《文档索引》§3.2「后端功能模块在哪」。
 *      扩展表结构在 ./extend-schema.js（84 条语句）+ migrations/0003_extend.sql。
 *
 * 说明：
 *   前端已写死这些接口（见 o/cdn-2607/a/0/use-pinlun-list-*.js），
 *   本 Worker 严格按其 { success, data, msg } 约定回包，无需改动前端 Vue。
 *   posts.json 的静态元数据以仓库为准：env.POSTS_URL 指向 raw 文件，
 *   编辑 site/api/public/posts.json 推送到 GitHub 后即生效（带短缓存）。
 */

// 《追加补充.md》扩展表结构（27 张扩展表 + 现有表字段增补 + 索引）——与基础 SCHEMA_SQL 分离，
// 用 EXTEND_MARKER_TABLE（article_likes）单独判断，避免「posts 已存在就整体跳过」导致扩展表永远不建。
import { EXTEND_STATEMENTS, EXTEND_MARKER_TABLE } from "./extend-schema.js";
// 《追加补充.md》FR-X5 全文搜索（D1 FTS5 优先、LIKE 兜底；FTS 建表与索引自愈同步在模块内部完成）
import { handleSearch, handleSuggest } from "./features/search.js";
// 《追加补充.md》FR-X10：文章点赞 / 收藏（与评论赞踩分开，靠 client_key / user_id 去重）
import { handleArticleLike, handleArticleBookmark, articleCounts, likeButtonHtml } from "./features/likes.js";
// 《追加补充.md》FR-X19/FR-X20：评论审核队列 + 风控（黑名单/敏感词/先审后发）+ 举报
import {
  checkCommentRisk, handleReport, handleAdminCommentsBulk, handleAdminReports,
  handleAdminCommentSettings, handleAdminBlacklist,
} from "./features/moderation.js";
// 《追加补充.md》FR-X1/FX-X2/FR-X3/FR-X4 + NFR-X1：robots / sitemap / feeds / 文章页 meta / 安全响应头
import {
  robotsTxt, sitemapXml, feedXml, articleMeta, applySecurityHeaders, SECURITY_HEADERS,
  notFoundPage, errorPage,
} from "./features/seo.js";
// 《追加补充.md》NFR-X2 限流 / NFR-X3 审计 / NFR-X4 X-Request-Id
import {
  newRequestId, withRequestId, checkRateLimit, rateLimitResponse,
  recordAudit, handleAdminAuditLogs, handleAdminRateLimits,
} from "./features/security.js";
// 《追加补充.md》FR-X13 密码重置 / FR-X14 邮箱验证（骨架：未配 MAIL_WEBHOOK_URL 时只生成令牌不发信）
import {
  handlePasswordResetRequest, handlePasswordResetConfirm,
  handleEmailVerifyRequest, handleEmailVerifyConfirm, handleAdminResetTokens, resolveMe,
} from "./features/auth-ext.js";
// 《追加补充.md》R7 访问统计（visits/daily_stats/公开统计/后台统计）
import { recordVisit, handlePublicStats, handleAdminStats, aggregateDaily } from "./features/stats.js";
// 《追加补充.md》FR-X23 订阅与 Newsletter / FR-X21 通知（站内信 + Webhook 投递）
import {
  handleSubscribe, handleUnsubscribe, notifyEvent,
  handleAdminSubscribers, handleAdminNotifications, handleAdminWebhooks, handleMyNotifications,
} from "./features/notify.js";
// 《追加补充.md》FR-X15 资料头像 / FR-X16 会话管理 / FR-X17 2FA 骨架 / FR-X18 OAuth 骨架 / FR-X22 评论增强
import {
  handleMyProfile, handleMySessions, handleMy2fa, handleMyPassword, handleOAuthStart, handleOAuthCallback,
  handleMyBookmarks, handleMyComments, handleMyLikes,
  handleAdminUsersExt, enhanceComments,
} from "./features/users-ext.js";
// 《追加补充.md》FR-X9 修订与定时发布 / FR-X11 重定向 / 后台导出导入
import {
  snapshotRevision, handleAdminRevisions, applyScheduledPosts, schedulePost,
  handleAdminExport, handleAdminImport, handleAdminRedirects, resolveRedirect,
} from "./features/content.js";

// 回源 Pages 的静态响应只下发这些安全头（**不含 CSP**：工具页与旧 Vue SPA 可能依赖 eval/new Function，
// 需在浏览器逐页验证后再单独开启，见《追加补充.md》NFR-X1 的落地注意）。
const PROXY_SAFE_HEADERS = [
  "Strict-Transport-Security",
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Referrer-Policy",
  "Permissions-Policy",
];
/* 核心前端资源的部署版本号：修改 /js/header-fix.js 或 /soulsoft-tools.css 后递增（a→b→c…），
 * 用于回源时绕过 GitHub Pages/CDN 缓存，确保改动立即生效。 */
const ASSET_VER = "d";

/** R7 统计懒聚合（项目没有 Cron）：访问统计接口时补「昨天」，打开后台时顺带刷新「今天」；失败不影响接口 */
async function lazyAggregateStats(env, path) {
  try {
    if (!env.DB) return;
    const y = new Date(Date.now() + 8 * 3600 * 1000 - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const hit = await env.DB.prepare("SELECT id FROM daily_stats WHERE date = ?1 LIMIT 1").bind(y).first();
    if (!hit) await aggregateDaily(env, y);
    if (String(path || "").indexOf("/admin/") >= 0) await aggregateDaily(env);
  } catch (e) { /* 聚合失败不影响接口 */ }
}

export default {
  // NFR-X4：统一给响应补 X-Request-Id。
  // 回源 Pages 拿到的 Response 其 headers 是 immutable guard（直接 set 会抛 TypeError），
  // 故先复制一份可变 Headers 再重建 Response；任何失败都原样返回，绝不影响主流程。
  async fetch(request, env, ctx) {
    const reqId = request.headers.get("x-request-id") || newRequestId();
    const resp = await handleFetch(request, env, ctx);
    try {
      const headers = new Headers(resp.headers);
      withRequestId(headers, reqId);
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
    } catch (e) {
      return resp;
    }
  },
};

async function handleFetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 首次请求自动建表（幂等，免手动 wrangler d1 execute）
    if (path.startsWith("/api/") || path.startsWith("/api-v1/")) {
      try { await ensureSchema(env); } catch (e) { /* 建表失败不阻断，后续接口自行降级 */ }
    }

    try {
      // 文章详情页动态渲染：/article/a_xxx.html 从 D1 读正文（保存即生效，等价写 HTML 文件）
      if (/^\/article\/a_[a-zA-Z0-9]+\.html$/.test(path)) {
        // FR(R7)：记录文章页访问（模块内部优先 ctx.waitUntil，不阻塞渲染）
        void recordVisit(request, env, ctx, { path: path, sourceFile: path.split("/").pop() });
        return handleArticleDetail(request, env, path);
      }

      // 前端 axios 拦截器会把源码里的 /api/* 运行时改写成 /api-v1/*。
      // 因此两个前缀都要处理：/api/* 与 /api-v1/*。
      if (path === "/api/public/posts.json") return handlePosts(request, env, ctx);
      if (path === "/api/public/columns.json") return handlePublicColumns(env);
      if (path === "/api/public/tags.json") return handlePublicTags(env);
      if (path === "/api/tools.json") return handlePublicTools(env);
      if (path === "/api/about.json") return handlePublicAbout(env);
      if (path === "/api/layout.json") return handlePublicLayout(env);
      if (path === "/api/view") {
        // NFR-X2：阅读量打点限流（默认 1 分钟 60 次 / 客户端指纹）
        const rl = await checkRateLimit(env, { name: "view", key: "view:" + clientKey(request) });
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleView(request, env);
      }
      if (path === "/api/ping" || path === "/api/health" || path === "/api-v1/ping" || path === "/api-v1/health") return health(env);

      // ===== 《追加补充.md》FR-X10：文章点赞 / 收藏 =====
      // ⚠ 必须放在下面「旧契约 /api/article/*」之前，否则会被 articleMock 抢走
      if (path === "/api/article/like") return handleArticleLike(request, env);
      if (path === "/api/article/bookmark") return handleArticleBookmark(request, env);

      // ===== 《追加补充.md》FR-X20：公开举报（评论/文章）=====
      if (path === "/api/report") {
        const rl = await checkRateLimit(env, { name: "report", key: "report:" + clientKey(request) });
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleReport(request, env);
      }

      // ===== 《追加补充.md》FR-X1/FR-X4：robots / sitemap / 三种订阅源（动态生成，数据源为 D1 posts）=====
      if (path === "/robots.txt") {
        return new Response(robotsTxt(env), {
          status: 200,
          headers: applySecurityHeaders({ "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" }),
        });
      }
      if (path === "/sitemap.xml") {
        return new Response(await sitemapXml(env), {
          status: 200,
          headers: applySecurityHeaders({ "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" }),
        });
      }
      if (path === "/rss.xml" || path === "/atom.xml" || path === "/feed.json") {
        const kind = path === "/rss.xml" ? "rss" : (path === "/atom.xml" ? "atom" : "json");
        const ctype = kind === "rss" ? "application/rss+xml; charset=utf-8"
          : kind === "atom" ? "application/atom+xml; charset=utf-8"
          : "application/feed+json; charset=utf-8";
        return new Response(await feedXml(env, kind), {
          status: 200,
          headers: applySecurityHeaders({ "content-type": ctype, "cache-control": "public, max-age=3600" }),
        });
      }

      // 评论：/api/pinlun/* 与 /api-v1/pinlun/*
      if (path.startsWith("/api/pinlun/") || path.startsWith("/api-v1/pinlun/")) {
        return handlePinlun(request, env, ctx);
      }

      // 旧前端契约：/api-v1/csrf（返回字符串 token）、/api-v1/user/info（Cookie 会话）、/api-v1/article/*
      if (path === "/api-v1/csrf" || path === "/api/csrf") return csrfToken();
      if (path === "/api-v1/user/info") return handleUserInfo(request, env);
      if (path === "/api-v1/user/login") return handleUserLogin(request, env);
      if (path === "/api-v1/user/logout") return handleUserLogout(request, env);
      if (path.startsWith("/api-v1/article/") || path.startsWith("/api/article/")) {
        return articleMock(path);
      }

      // 登录 / 注册（登录页原生 fetch 调用，不经 axios 拦截器改写）
      // 注意：/api/user/login|info|logout 是 Vue 组件走 Cookie 会话（Set-Cookie），
      //       /api/login|me|logout 是登录页/admin 走 X-Token + localStorage token。
      if (path === "/api/user/login") return handleUserLogin(request, env);
      if (path === "/api/user/info") return handleUserInfo(request, env);
      if (path === "/api/user/logout") return handleUserLogout(request, env);
      if (path === "/api/login" || path === "/api/v1/login") {
        const rl = await checkRateLimit(env, { name: "login", key: "login:" + clientKey(request) });
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleLogin(request, env);
      }
      if (path === "/api/register" || path === "/api/user/register") {
        const rl = await checkRateLimit(env, { name: "register", key: "register:" + clientKey(request) });
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleRegister(request, env, ctx);
      }
      if (path === "/api/me" || path === "/api-v1/me") return handleMe(request, env);
      if (path === "/api/logout" || path === "/api-v1/logout") return handleLogout(request, env);

      // ===== 《追加补充.md》FR-X13 密码重置 / FR-X14 邮箱验证 =====
      // ⚠ 必须早于最下方 `if (path.startsWith("/api/")) return proxyStaticJson(...)` 兜底
      if (path === "/api/auth/password/request" || path === "/api-v1/auth/password/request") {
        const rl = await checkRateLimit(env, { name: "pwreset", key: "pwreset:" + clientKey(request) });
        if (!rl.allowed) return rateLimitResponse(rl);
        return handlePasswordResetRequest(request, env);
      }
      if (path === "/api/auth/password/confirm" || path === "/api-v1/auth/password/confirm") {
        return handlePasswordResetConfirm(request, env);
      }
      if (path === "/api/auth/email/verify/request" || path === "/api-v1/auth/email/verify/request") {
        // fetch 层没有 me：用轻量 token→user 查询（只认 X-Token，与 /api/me 同口径）
        const me = await resolveMe(request, env);
        return handleEmailVerifyRequest(request, env, me);
      }
      if (path === "/api/auth/email/verify/confirm" || path === "/api-v1/auth/email/verify/confirm") {
        return handleEmailVerifyConfirm(request, env);
      }

      // ===== FR(R7) 公开统计 / FR-X23 订阅与退订 / FR-X21 我的站内信 =====
      if (path === "/api/public/stats" || path === "/api-v1/public/stats") {
        await lazyAggregateStats(env, path);
        return handlePublicStats(request, env);
      }
      if (path === "/api/subscribe") {
        const rl = await checkRateLimit(env, { name: "subscribe", key: "subscribe:" + clientKey(request) });
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleSubscribe(request, env);
      }
      if (path === "/api/unsubscribe") return handleUnsubscribe(request, env);
      if (path === "/api/my/notifications") {
        const me = await resolveMe(request, env);
        return handleMyNotifications(request, env, me);
      }

      // ===== FR-X15/X16/X17：我的资料 / 我的会话 / 2FA（均需登录，用 resolveMe 取用户）=====
      if (path === "/api/my/profile" || path === "/api/my/sessions" || path === "/api/my/2fa" || path === "/api/my/password" ||
          path === "/api/my/bookmarks" || path === "/api/my/comments" || path === "/api/my/likes") {
        const me = await resolveMe(request, env);
        if (!me) return json({ ok: false, msg: "请先登录" }, 401);
        if (path === "/api/my/profile") return handleMyProfile(request, env, me);
        if (path === "/api/my/sessions") return handleMySessions(request, env, me);
        if (path === "/api/my/password") return handleMyPassword(request, env, me);
        if (path === "/api/my/bookmarks") return handleMyBookmarks(request, env, me);
        if (path === "/api/my/comments") return handleMyComments(request, env, me);
        if (path === "/api/my/likes") return handleMyLikes(request, env, me);
        return handleMy2fa(request, env, me);
      }

      // ===== FR-X18：第三方登录（骨架；未配 GITHUB_CLIENT_ID 时返回 501）=====
      if (/^\/(?:api|api-v1)\/oauth\/[a-zA-Z0-9_-]+\/(start|callback)$/.test(path)) {
        if (path.endsWith("/start")) return handleOAuthStart(request, env);
        return handleOAuthCallback(request, env);
      }

      // ===== 全文搜索（FR-X5）：必须早于最后的 /api/ 静态回源兜底 =====
      if (path === "/api/public/search") {
        const rl = await checkRateLimit(env, { name: "search", key: "search:" + clientKey(request) });
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleSearch(request, env, ctx);
      }
      if (path === "/api/public/search/suggest") return handleSuggest(request, env);

      // ===== 公开接口：专栏下的文章列表（详情页右侧「专栏文章展示态」按需拉取）=====
      const colArtsMatch = path.match(/^\/api\/columns\/([^\/]+)\/articles$/);
      if (colArtsMatch) return handleColumnArticles(request, env, decodeURIComponent(colArtsMatch[1]));

      // ===== 上传的文件读取（base64 存 D1）=====
      if (path.startsWith("/api/uploads/")) return handleAdmin(request, env, path);

      // ===== 管理后台接口（admin/index.html 调用，X-Token 鉴权）=====
      if (path.startsWith("/api/dashboard") || path.startsWith("/api/posts") ||
          path.startsWith("/api/categories") || path.startsWith("/api/tags") ||
          path.startsWith("/api/columns") || path.startsWith("/api/comments") ||
          path.startsWith("/api/users") || path.startsWith("/api/settings") ||
          path.startsWith("/api/upload") || path.startsWith("/api/import_posts") ||
          path.startsWith("/api/admin") || path.startsWith("/api-v1/admin")) {
        return handleAdmin(request, env, path);
      }

      // 静态 JSON：/api/* 与 /api-v1/*（tools/about/layout/columns/tags 等）
      if (path.startsWith("/api/")) return proxyStaticJson(request, env, path);
      if (path.startsWith("/api-v1/")) return proxyStaticJson(request, env, path);

      // ===== 后台保护：/admin/* 仅管理员可访问，其余一律 404（防注入/爆破）=====
      if (path.startsWith("/admin")) {
        return guardAdmin(request, env);
      }

      // FR-X11：旧链接重定向（命中即 301/302；带模块内 60 秒缓存，失败一律放过）
      if (!path.startsWith("/api/") && !path.startsWith("/api-v1/") && !path.startsWith("/admin")) {
        const hit = await resolveRedirect(env, path);
        if (hit && hit.to_path) {
          const headers = { location: hit.to_path, "cache-control": "no-store" };
          applySecurityHeaders(headers);
          return new Response(null, { status: Number(hit.code) || 301, headers });
        }
      }

      // 其余一切（/index.html、/article/index.html、/piano/、图片等静态资源）：
      // 回源 GitHub Pages 反向代理。这样无论 Cloudflare 路由配成整站还是精确 /api/*，
      // 全站都能正常访问（Worker 作为统一入口：API 走 D1，静态回源 Pages）。
      const staticResp = await proxyStatic(request, env);
      // FR(R7)：只对「回源成功的 HTML 页面」记一次访问（静态资源不记，避免写放大）
      try {
        const ctype = staticResp.headers.get("content-type") || "";
        if (staticResp.status === 200 && ctype.indexOf("text/html") >= 0) {
          void recordVisit(request, env, ctx, { path: path });
        }
      } catch (e) { /* 统计失败不影响页面 */ }
      // 《追加补充.md》FR-X11：回源 404 时用 Worker 自渲染的 HTML 404 页兜底
      // （/admin* 仍走 guardAdmin 的纯文本 404，不在此列＝不暴露后台存在性）
      if (staticResp.status === 404 && !path.startsWith("/admin")) {
        const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" };
        applySecurityHeaders(headers);
        return new Response(notFoundPage(env, path), { status: 404, headers });
      }
      // 全站行为脚本与统一样式必须及时生效：禁用强缓存（否则改版后浏览器长时间跑旧版，
      // 表现为「改了没生效 / 新旧 UI 混杂」）。no-cache 仍允许协商缓存（304），不增多少流量。
      if (path === "/js/header-fix.js" || path === "/soulsoft-tools.css") {
        const h = new Headers(staticResp.headers);
        h.set("cache-control", "no-cache");
        applySecurityHeaders(h);
        return new Response(staticResp.body, { status: staticResp.status, headers: h });
      }
      return staticResp;
    } catch (err) {
      // 诊断模式：把异常堆栈带回响应体，便于快速定位 500 根因
      const stack = String(err && err.stack || err && err.message || err).slice(0, 600);
      // 浏览器直访的页面路径返回 HTML 错误页（API 仍回 JSON，便于前端解析与排障）
      if (!path.startsWith("/api/") && !path.startsWith("/api-v1/")) {
        const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
        applySecurityHeaders(headers);
        return new Response(errorPage(env, 500, stack), { status: 500, headers });
      }
      return json({ success: false, ok: false, msg: "服务器开小差了", error: stack }, 500);
    }
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function json(obj, status = 200, extraHeaders = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, X-Token",
    ...extraHeaders,
  };
  // NFR-X1：统一补安全响应头（已存在的键不覆盖，便于个别接口单独放宽）
  applySecurityHeaders(headers);
  return new Response(JSON.stringify(obj), { status, headers });
}

function nowMs() {
  return Date.now();
}

function fmtTime(ms) {
  // Workers 运行时是 UTC，加 8 小时偏移使其显示北京时间（UTC+8）
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return (
    d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
    " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds())
  );
}

/** 读取 JSON 请求体；非法返回 null */
async function readBody(request) {
  try {
    const ct = request.headers.get("content-type") || "";
    if (!ct.includes("json")) return {};
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/** 健康检查：一眼看出 D1 是否绑定、表是否已建（评论/阅读量功能可用的关键） */
async function health(env) {
  const out = { ok: true, now: Date.now(), d1: false, tables: [] };
  if (!env.DB) {
    out.hint = "D1 未绑定：请在 Cloudflare 控制台 → Workers → 该 Worker → Settings → Bindings 添加 D1 绑定，变量名必须是 DB；或通过 wrangler.toml 部署。";
    return json(out, 200);
  }
  out.d1 = true;
  // 自动建表
  try { await ensureSchema(env); } catch (e) { out.schema_err = String(e && e.message || e); }
  try {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all();
    out.tables = (tables.results || []).map((r) => r.name);
    if (!out.tables.includes("comments")) {
      out.hint = "D1 已绑定，但 comments 表不存在";
    }
    // 诊断：posts 总数 + 占位/脏正文数 + raw 可达性
    try {
      const cnt = await env.DB.prepare("SELECT COUNT(*) AS c FROM posts").first();
      out.posts_total = cnt ? cnt.c : 0;
      const ph = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM posts WHERE content LIKE '[a_%' OR content = '' OR content IS NULL OR content LIKE '%xw-pinlun2%'"
      ).first();
      out.posts_dirty_content = ph ? ph.c : 0;
      const rawOk = await fetch(String(env.RAW_ARTICLE_BASE || "") + "/a_5a0bf49035583c99c0b28d70.html", { headers: { "user-agent": "qingyi-blog-worker" } });
      out.raw_article_status = rawOk.status;
    } catch (e) {
      out.diag_err = String(e && e.message || e);
    }
  } catch (e) {
    out.hint = "D1 已绑定，但查询失败：" + String(e && e.message || e);
  }
  return json(out, 200);
}

/* ============ 自动建表（首次运行时执行，免去手动 wrangler d1 execute） ============ */
let _schemaReady = false;
let _schemaPromise = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT UNIQUE NOT NULL,
  nickname   TEXT    NOT NULL DEFAULT '',
  email      TEXT    NOT NULL DEFAULT '',
  pass_salt  TEXT    NOT NULL DEFAULT '',
  pass_hash  TEXT    NOT NULL DEFAULT '',
  role       TEXT    NOT NULL DEFAULT 'user',
  status     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expire_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  category_id INTEGER,
  summary     TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  status      INTEGER NOT NULL DEFAULT 1,
  is_top      INTEGER NOT NULL DEFAULT 0,
  views       INTEGER NOT NULL DEFAULT 0,
  source_file TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
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
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER,
  page_id    TEXT    NOT NULL DEFAULT '',
  root_id    INTEGER NOT NULL DEFAULT 0,
  parent_id  INTEGER NOT NULL DEFAULT 0,
  author     TEXT    NOT NULL DEFAULT '匿名用户',
  email      TEXT    NOT NULL DEFAULT '',
  avatar     TEXT    NOT NULL DEFAULT '',
  role       TEXT    NOT NULL DEFAULT 'user',
  content    TEXT    NOT NULL,
  status     INTEGER NOT NULL DEFAULT 1,
  zan        INTEGER NOT NULL DEFAULT 0,
  cai        INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_page ON comments (page_id, root_id, status);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id, status);
CREATE TABLE IF NOT EXISTS votes (
  comment_id INTEGER NOT NULL,
  client_key TEXT    NOT NULL,
  type       INTEGER NOT NULL,
  PRIMARY KEY (comment_id, client_key)
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS about_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS views (
  source_file TEXT PRIMARY KEY,
  count       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS uploads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL DEFAULT 'image/png',
  size       INTEGER NOT NULL DEFAULT 0,
  data_b64   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

async function ensureSchema(env) {
  if (_schemaReady) return;
  if (_schemaPromise) return _schemaPromise;
  _schemaPromise = (async () => {
    // ---- 1) 基础结构：14 张业务表 + 2 个索引 ----
    // 快速路径：posts 表已存在说明基础结构已建过，跳过这 16 条 DDL
    let baseExists = false;
    try {
      const chk = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'").first();
      baseExists = !!chk;
    } catch (e) { /* 忽略，继续建表 */ }

    if (!baseExists) {
      // D1 的 exec() 不支持多语句，必须逐条 prepare 执行。
      const stmts = SCHEMA_SQL
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const sql of stmts) {
        try {
          await env.DB.prepare(sql).run();
        } catch (e) {
          /* IF NOT EXISTS 幂等，重复表/列报错可忽略 */
        }
      }
    }

    // 列迁移（**必须放在基础结构分支之外**：posts 已存在、但 users.email / comments.post_id 缺失的老库也要补）
    // 两条都幂等（列已存在会报 duplicate column name，被吞掉即可）
    try {
      await env.DB.prepare("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''").run();
    } catch (e) { /* 已存在则忽略 */ }
    try {
      await env.DB.prepare("ALTER TABLE comments ADD COLUMN post_id INTEGER").run();
    } catch (e) { /* 已存在则忽略 */ }
    // article_likes 增补 user_id（「我的点赞」按账号查询用）；独立无条件执行，因为
    // 扩展分支以 article_likes 作 marker、表已存在会跳过全部语句，此列必须单独补。
    try {
      await env.DB.prepare("ALTER TABLE article_likes ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0").run();
    } catch (e) { /* 已存在则忽略 */ }

    // ---- 2) 扩展结构（《追加补充.md》TABLE-X1..X27 + 字段增补 + 索引）----
    // 用独立 marker 判断，不能复用上面的 posts 快速路径（否则扩展表永远不会建）。
    // 逐条执行且每条吞错：ALTER 在已加列时会报 duplicate column，属预期；
    // 若中途失败，marker 表仍未建，下次请求会自动重试。
    try {
      const ext = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?1"
      ).bind(EXTEND_MARKER_TABLE).first();
      if (!ext) {
        for (const stmt of EXTEND_STATEMENTS) {
          try {
            await env.DB.prepare(stmt).run();
          } catch (e) { /* 幂等报错可忽略 */ }
        }
      }
    } catch (e) { /* 扩展建表失败不阻断基础功能 */ }

    _schemaReady = true;
    _schemaPromise = null;
  })().catch((e) => { _schemaPromise = null; throw e; });
  return _schemaPromise;
}

/** 旧前端契约：GET /api-v1/csrf 返回纯字符串 token（前端把响应体直接作为 _csrf 附加） */
function csrfToken() {
  const body = '"qingyi-blog-worker-csrf"';
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

/**
 * 旧前端契约：/api-v1/article/*。
 * ⚠ 关键：详情页正文已预渲染进 HTML。若 /article 返回 success:true 且 article:null，
 *   前端会把 store 里的文章覆盖成 null，导致标题/正文/日期全丢（显示 1970-1-1）。
 *   因此这里必须返回 success:false，让前端 fetchItem 抛错后「保留预渲染内容」。
 *   categorys/list 同理返回失败态，避免空数据覆盖已有渲染。
 */
function articleMock(path) {
  return json({ success: false, msg: "内容已预渲染，无需刷新" }, 200);
}

/* ================================================================== */
/* 文章详情页动态渲染：从 D1 读正文，用静态 HTML 作骨架替换标题/正文/元信息 */
/* ================================================================== */

async function handleArticleDetail(request, env, path) {
  const db = env.DB;
  const sourceFile = path.split("/").pop();
  if (!db) return passthroughArticle(request, env);

  // 从 D1 读文章
  let post = null;
  try {
    post = await db.prepare(
      "SELECT id,title,summary,content,status,views,created_at,updated_at,source_file FROM posts WHERE source_file = ?1"
    ).bind(sourceFile).first();
  } catch (e) { post = null; }

  // D1 没这篇文章：回退静态 HTML 直出（passthrough 到 GitHub Pages）
  if (!post) return passthroughArticle(request, env);

  // 分栏过滤（?col=）：上/下篇导航限定在该分栏内；专栏面板直接进入「专栏文章展示态」
  const url = new URL(request.url);
  const colFilter = url.searchParams.get("col") || "";
  let colId = null;
  if (colFilter) {
    try {
      const c = await db.prepare("SELECT id FROM columns WHERE name=?").bind(colFilter).first();
      colId = c ? c.id : null;
    } catch (e) { colId = null; }
  }

  // 上/下篇（按创建时间排序的相邻文章；带 ?col= 时限定在该分栏内）
  let prevPost = null, nextPost = null;
  try {
    const inCol = colId
      ? " AND id IN (SELECT post_id FROM post_columns WHERE column_id=" + Number(colId) + ")"
      : "";
    const prev = await db.prepare(
      "SELECT title, source_file FROM posts WHERE status=1 AND created_at > ?1" + inCol + " ORDER BY created_at ASC LIMIT 1"
    ).bind(post.created_at).first();
    const next = await db.prepare(
      "SELECT title, source_file FROM posts WHERE status=1 AND created_at < ?1" + inCol + " ORDER BY created_at DESC LIMIT 1"
    ).bind(post.created_at).first();
    prevPost = prev; nextPost = next;
  } catch (e) {}

  // 分栏数据：仅返回「专栏名 + 文章数量」；文章列表由前端点击专栏后按需请求
  let colGroups = [];
  let colArticles = [];   // ?col= 存在时：该分栏的文章列表（直接进入「专栏文章展示态」）
  try {
    let cols;
    if (colFilter) {
      cols = await db.prepare("SELECT id,name FROM columns WHERE name=? ORDER BY sort,id").bind(colFilter).all();
    } else {
      cols = await db.prepare("SELECT id,name FROM columns ORDER BY sort,id").all();
    }
    for (const c of (cols.results || [])) {
      const cntRow = await db.prepare(
        "SELECT COUNT(*) AS c FROM post_columns pc JOIN posts p ON p.id=pc.post_id " +
        "WHERE pc.column_id=?1 AND p.status=1"
      ).bind(c.id).first();
      colGroups.push({ name: c.name, count: cntRow ? cntRow.c : 0 });
    }
    // 带分栏筛选时：拉取该分栏的文章列表（模板直接渲染为展示态，排序与上/下篇口径一致）
    if (colFilter && colId) {
      const arts = await db.prepare(
        "SELECT p.title, p.source_file FROM post_columns pc JOIN posts p ON p.id=pc.post_id " +
        "WHERE pc.column_id=?1 AND p.status=1 ORDER BY p.created_at DESC, p.id DESC"
      ).bind(colId).all();
      colArticles = (arts.results || []).map(a => ({ title: a.title, source_file: a.source_file }));
    }
  } catch (e) {}

  // 本文所属分栏名（卡片左上角展示；取 sort 最靠前的第一个；无分栏则空白占位）
  let postCol = "";
  try {
    const c = await db.prepare(
      "SELECT c.name FROM post_columns pc JOIN columns c ON c.id=pc.column_id " +
      "WHERE pc.post_id=?1 ORDER BY c.sort, c.id LIMIT 1"
    ).bind(post.id).first();
    if (c && c.name) postCol = c.name;
  } catch (e) {}

  // FR-X7：相关文章（同标签优先，其次同分栏；排除当前篇，最多 4 篇）
  let related = [];
  try {
    const rel = await db.prepare(
      "SELECT DISTINCT p.id, p.title, p.source_file, p.views FROM posts p " +
      "JOIN post_tags pt ON pt.post_id = p.id " +
      "WHERE pt.tag_id IN (SELECT tag_id FROM post_tags WHERE post_id = ?1) " +
      "AND p.id != ?1 AND p.status = 1 " +
      "ORDER BY p.created_at DESC, p.id DESC LIMIT 4"
    ).bind(post.id).all();
    related = (rel.results || []).map(r => ({ title: r.title, source_file: r.source_file }));
    if (!related.length) {
      const rel2 = await db.prepare(
        "SELECT DISTINCT p.id, p.title, p.source_file FROM posts p " +
        "JOIN post_columns pc ON pc.post_id = p.id " +
        "WHERE pc.column_id IN (SELECT column_id FROM post_columns WHERE post_id = ?1) " +
        "AND p.id != ?1 AND p.status = 1 " +
        "ORDER BY p.created_at DESC, p.id DESC LIMIT 4"
      ).bind(post.id).all();
      related = (rel2.results || []).map(r => ({ title: r.title, source_file: r.source_file }));
    }
  } catch (e) {}

  // 全部使用内置模板动态渲染（含评论 + 右侧悬浮组件），不依赖静态 HTML 文件
  // FR-X10：点赞 / 收藏计数（含当前访客是否已赞，供首屏高亮；失败时模块内部回退 0）
  const counts = await articleCounts(env, sourceFile, request);
  const rendered = renderArticleFromTemplate(post, sourceFile, { prev: prevPost, next: nextPost, colGroups, colFilter, colArticles, env, counts, postCol, related });
  const htmlHeaders = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=60",
  };
  // NFR-X1：详情页是 Worker 自渲染的 HTML，可安全下发完整安全响应头（含 CSP，页面内联脚本由 'unsafe-inline' 放行）
  applySecurityHeaders(htmlHeaders);
  return new Response(rendered, { status: 200, headers: htmlHeaders });
}

/* 内置模板渲染完整详情页（导航 + 评论区 + 右侧悬浮组件），不依赖静态 HTML */
function renderArticleFromTemplate(post, sourceFile, extras) {
  const ex = extras || {};
  const prevPost = ex.prev || null;
  const nextPost = ex.next || null;
  const colGroups = ex.colGroups || [];
  const colFilter = ex.colFilter || "";
  const colArticles = ex.colArticles || [];
  const counts = ex.counts || { likes: 0, bookmarks: 0 };
  const postCol = ex.postCol || "";
  const related = ex.related || [];
  const colQS = colFilter ? "?col=" + encodeURIComponent(colFilter) : "";
  // 两态专栏面板：默认「专栏 + 文章数量」；带 ?col= 时直接进入「专栏文章展示态」（服务端直出，无二次请求）
  const colRowsHtml = colGroups.map(g =>
    `<div class="colgroup-row${colFilter && g.name === colFilter ? " on" : ""}" data-col="${escapeHtml(g.name)}"><span class="colgroup-name">${escapeHtml(g.name)}</span><span class="colgroup-cnt">${g.count} 篇</span></div>`
  ).join("");
  const colArtsHtml = colArticles.length
    ? `<ul class="side-arts">${colArticles.map(a => `<li><a href="/article/${escapeHtml(a.source_file)}${escapeHtml(colQS)}">${escapeHtml(a.title)}</a></li>`).join("")}</ul>`
    : `<div class="c-empty" style="font-size:12.5px;color:#94a3b8;padding:10px 0">该专栏暂无文章</div>`;
  const colPanelHtml = colFilter
    ? `<span class="col-back" onclick="showColumns()">← 返回专栏</span>${colRowsHtml}${colArtsHtml}`
    : colRowsHtml;
  const title = escapeHtml(post.title || "");
  const date = String(post.created_at || "");
  // 更新时间：仅在明显晚于发布时间（>60 秒）时才展示，避免每篇文章都重复两个相同时间
  const updated = String(post.updated_at || "");
  const updatedHtml = (updated && updated.slice(0, 10) !== date.slice(0, 10))
    ? ' · 更新于 ' + escapeHtml(updated)
    : "";
  // 卡片顶部行：左=分栏名，右=发布时间（+更新时间），不再单独占一条 meta 条
  const topRow =
    '<div class="art-top">' +
      '<span class="art-col">' + (postCol ? '<span class="art-dot"></span>' + escapeHtml(postCol) : '&nbsp;') + '</span>' +
      '<span class="art-dates">发布于 ' + escapeHtml(date) + updatedHtml + '</span>' +
    '</div>';
  // FR-X7：相关文章区块（有数据才渲染）
  const relatedHtml = related.length
    ? '<div class="related-block">' +
      '<h3>相关文章</h3>' +
      '<ul class="related-list">' + related.map(r =>
        '<li><a href="/article/' + escapeHtml(r.source_file) + '">' + escapeHtml(r.title) + '</a></li>'
      ).join("") + '</ul></div>'
    : "";
  const pageId = sourceFile || "";   // 评论 page_id
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="author" content="qingyi">
<title>${title} - 清逸的博客</title>
${articleMeta(post, { env: ex.env || {}, col: colFilter, source_file: sourceFile })}
<link rel="stylesheet" href="/soulsoft-tools.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;background:#f5f7fb;color:#0f172a;line-height:1.8;padding-top:58px}
.nav{position:fixed;top:0;left:0;right:0;height:58px;z-index:50;background:rgba(255,255,255,.85);backdrop-filter:blur(12px);border-bottom:1px solid #e4e9f0}
.nav-in{max-width:1200px;margin:0 auto;height:100%;display:flex;align-items:center;gap:24px;padding:0 24px}
.nav .logo{font-size:19px;font-weight:800;background:linear-gradient(135deg,#2563eb,#0ea5e9);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;text-decoration:none;white-space:nowrap}
.nav a{color:#5a6a7a;text-decoration:none;font-size:14px;font-weight:600;white-space:nowrap}
.nav a:hover{color:#2563eb}
.nav .user{margin-left:auto}
.wrap{max-width:1280px;margin:32px auto 40px;padding:0 24px;display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:28px;align-items:start}
.main-col{min-width:0}
.article-card{background:#fff;border:1px solid #e4e9f0;border-radius:18px;padding:36px 44px;box-shadow:0 10px 30px rgba(15,23,42,.05);margin-bottom:20px}
h1{font-size:28px;font-weight:800;line-height:1.4;margin:0 0 16px;color:#0f172a}
.art-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.art-col{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:#475569}
.art-dot{width:8px;height:8px;border-radius:50%;background:#2563eb;display:inline-block}
.art-dates{font-size:12px;color:#94a3b8;white-space:nowrap}
.meta{font-size:13px;color:#94a3b8;padding:12px 16px;background:#f8fafc;border-radius:12px;margin-bottom:22px}
.content{font-size:16px;line-height:1.9;color:#1e293b;word-break:break-word}
.content h2{font-size:22px;margin:28px 0 14px;padding-left:12px;border-left:4px solid #2563eb}
.content h3{font-size:18px;margin:22px 0 12px}
.content img{max-width:100%;border-radius:12px;margin:16px 0}
.content pre{background:#0f172a;color:#e2e8f0;border-radius:12px;padding:18px;overflow-x:auto;font-size:13.5px;line-height:1.7}
.content pre{position:relative}
.content pre .copy-btn{position:absolute;top:8px;right:8px;padding:4px 12px;font-size:12px;color:#cbd5e1;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:7px;cursor:pointer;opacity:0;transition:.15s}
.content pre:hover .copy-btn{opacity:1}
.content pre .copy-btn:hover{background:rgba(255,255,255,.18);color:#fff}
.content pre .copy-btn.done{color:#86efac}
.lightbox{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;cursor:zoom-out}
.lightbox.on{display:flex}
.lightbox img{max-width:92vw;max-height:92vh;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.lightbox .lb-close{position:absolute;top:18px;right:24px;color:#fff;font-size:34px;cursor:pointer;line-height:1}
.content code{font-family:ui-monospace,Menlo,Consolas,monospace}
.content p code,.content li code{background:#eef2ff;color:#4f46e5;padding:2px 7px;border-radius:6px;font-size:13.5px}
.content blockquote{border-left:4px solid #0ea5e9;background:#f0f9ff;padding:12px 18px;border-radius:0 12px 12px 0;margin:16px 0;color:#475569}
.content table{border-collapse:collapse;width:100%;margin:16px 0}
.content th,.content td{border:1px solid #e2e8f0;padding:10px 14px;font-size:14px}
.content th{background:#f8fafc}
.content a{color:#2563eb;text-decoration:underline}
.comments{background:#fff;border:1px solid #e4e9f0;border-radius:18px;padding:24px 28px;box-shadow:0 10px 30px rgba(15,23,42,.05)}
.related-block{background:#fff;border:1px solid #e4e9f0;border-radius:18px;padding:22px 28px;box-shadow:0 10px 30px rgba(15,23,42,.05);margin-bottom:20px}
.related-block h3{font-size:16px;font-weight:700;margin-bottom:14px;color:#2563eb}
.related-list{list-style:none;display:grid;grid-template-columns:1fr 1fr;gap:10px 22px}
.related-list li{font-size:14px}
.related-list a{color:#334155;text-decoration:none;line-height:1.6}
.related-list a:hover{color:#2563eb}
.related-list li::before{content:"▸";color:#2563eb;margin-right:7px}
@media(max-width:640px){.related-list{grid-template-columns:1fr}}
.comments h3{font-size:16px;font-weight:700;margin-bottom:16px;color:#2563eb}
.comment-list{list-style:none}
.comment-item{border-bottom:1px dashed #edf0f4;padding:14px 0}
.comment-item:last-child{border-bottom:0}
.c-name{font-weight:600;font-size:13.5px;color:#1e293b}
.c-time{font-size:11.5px;color:#94a3b8;margin-left:10px}
.c-content{font-size:14px;color:#334155;margin-top:6px;line-height:1.7;word-break:break-word}
.c-empty{color:#94a3b8;font-size:13.5px;text-align:center;padding:20px 0}
.comment-input{display:flex;gap:10px;margin-top:16px}
.comment-input textarea{flex:1;border:1px solid #e2e8f0;border-radius:12px;padding:12px 16px;font-size:14px;outline:none;resize:vertical;min-height:60px;font-family:inherit}
.comment-input textarea:focus{border-color:#2563eb}
.comment-input button{border:0;background:linear-gradient(135deg,#2563eb,#0ea5e9);color:#fff;border-radius:12px;padding:0 24px;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap}
.comment-input button:hover{opacity:.9}
.comment-user-row{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;color:#64748b}
.comment-user-row button{border:1px solid #d0d7de;background:#f6f8fa;color:#2563eb;border-radius:8px;padding:4px 14px;font-size:12.5px;font-weight:600;cursor:pointer}
.comment-user-row button:hover{background:#e9f2ff}
.comment-user-row .uname{color:#2563eb;font-weight:600}
/* ---- 右侧悬浮组件（目录 / 上下篇 / 分类专栏），sticky 滚动跟随 ---- */
.side-col{position:sticky;top:74px;display:flex;flex-direction:column;gap:16px}
.side-block{background:#fff;border:1px solid #e4e9f0;border-radius:14px;padding:16px;box-shadow:0 6px 20px rgba(15,23,42,.07)}
.side-block h4{font-size:13.5px;font-weight:700;color:#2563eb;margin-bottom:10px}
.toc-list{list-style:none;font-size:12.5px}
.toc-list li{padding:5px 0;border-bottom:1px dashed #f1f5f9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toc-list li:last-child{border-bottom:0}
.toc-list a{color:#475569;text-decoration:none;display:block}
.toc-list a:hover{color:#2563eb}
.toc-list li.lv3{padding-left:14px}
.pager-block .pg-item{display:block;text-decoration:none;padding:10px 12px;border:1px solid #e4e9f0;border-radius:10px;margin-bottom:8px;transition:.15s}
.pager-block .pg-item:hover{border-color:#2563eb;transform:translateY(-1px)}
.pager-block .pg-item:last-child{margin-bottom:0}
.pager-block .pg-label{display:block;font-size:11px;color:#94a3b8}
.pager-block .pg-title{display:block;font-size:12.5px;font-weight:600;color:#1e293b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pager-block .pg-item.next{text-align:left}
.pager-block .pg-item.disabled{opacity:.45;pointer-events:none}
.colgroup-name{font-size:12px;font-weight:600;color:#64748b;margin:10px 0 4px}
.colgroup-name:first-child{margin-top:0}
.colgroup-row{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px;color:#1e293b;margin-bottom:4px;transition:.15s}
.colgroup-row:hover{background:#f1f5f9}
.colgroup-row.on{background:rgba(37,99,235,.08);color:#2563eb}
.colgroup-row .colgroup-name{margin:0;color:inherit;font-weight:600}
.colgroup-row .colgroup-cnt{font-size:11.5px;color:#94a3b8;flex:none}
.colgroup-row.on .colgroup-cnt{color:#2563eb}
.col-back{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#2563eb;cursor:pointer;margin-bottom:8px}
.col-back:hover{text-decoration:underline}
.side-arts{list-style:none;font-size:12.5px}
.side-arts li{padding:5px 0;border-bottom:1px dashed #f1f5f9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side-arts li:last-child{border-bottom:0}
.side-arts a{color:#475569;text-decoration:none;display:block}
.side-arts a:hover{color:#2563eb}
@media(max-width:1080px){
  .wrap{grid-template-columns:1fr}
  .side-col{position:static;order:2}
  .main-col{order:1}
}
/* 汉堡按钮：默认隐藏 */
.menu-btn{display:none;background:none;border:0;cursor:pointer;font-size:22px;color:#5a6a7a;line-height:1;padding:4px;margin-left:auto}
@media(max-width:720px){
  .article-card{padding:22px 16px;border-radius:14px;margin-bottom:14px}
  h1{font-size:22px}
  .meta{font-size:12px;padding:10px 12px}
  .content{font-size:15px;line-height:1.85}
  .content h2{font-size:19px;margin:22px 0 12px}
  .content pre{padding:14px;font-size:12.5px}
  .content img{margin:12px 0}
  .wrap{padding:0 14px;margin:20px auto 30px}
  .nav-in{gap:8px;padding:0 12px}
  .nav-in > a:not(.logo):not(.user){display:none}
  .nav .logo{font-size:17px}
  .nav .user{margin-left:auto}
  .menu-btn{display:block}
  .nav-in.menu-open{flex-wrap:wrap;height:auto;padding:8px 12px;align-items:center}
  .nav-in.menu-open > a:not(.logo):not(.user){display:block;width:100%;padding:8px 10px;border-radius:8px;font-size:14px}
  .nav-in.menu-open > a:not(.logo):not(.user):hover{background:#f3f7fc}
  .nav-in.menu-open .user{width:100%;margin:4px 0 0}
  .comments{padding:16px 14px;border-radius:14px}
  .comment-input{flex-direction:column}
  .comment-input button{padding:10px 0;width:100%}
  .comment-input textarea{min-height:80px}
  .side-block{padding:14px}
}
/* ---- FR-X12 深色模式（跟随系统 + html[data-theme=dark] 手动覆盖） ---- */
@media (prefers-color-scheme: dark){
  html:not([data-theme="light"]) body{background:#0b1220;color:#e2e8f0}
  html:not([data-theme="light"]) .nav{background:rgba(17,26,44,.85);border-bottom:1px solid #1e293b}
  html:not([data-theme="light"]) .nav a{color:#94a3b8}
  html:not([data-theme="light"]) .article-card,
  html:not([data-theme="light"]) .comments,
  html:not([data-theme="light"]) .related-block,
  html:not([data-theme="light"]) .side-block{background:#111a2c;border-color:#1e293b}
  html:not([data-theme="light"]) h1,
  html:not([data-theme="light"]) .c-name,
  html:not([data-theme="light"]) .pager-block .pg-title{color:#e2e8f0}
  html:not([data-theme="light"]) .content{color:#cbd5e1}
  html:not([data-theme="light"]) .content blockquote{background:#12263a;color:#94a3b8}
  html:not([data-theme="light"]) .content th,.content td{border-color:#1e293b}
  html:not([data-theme="light"]) .content th{background:#1e293b}
  html:not([data-theme="light"]) .content p code,
  html:not([data-theme="light"]) .content li code{background:#1e293b;color:#93c5fd}
  html:not([data-theme="light"]) .comment-item,
  html:not([data-theme="light"]) .toc-list li,
  html:not([data-theme="light"]) .side-arts li{border-color:#1e293b}
  html:not([data-theme="light"]) .c-content,
  html:not([data-theme="light"]) .related-list a,
  html:not([data-theme="light"]) .colgroup-row,
  html:not([data-theme="light"]) .toc-list a,
  html:not([data-theme="light"]) .side-arts a{color:#94a3b8}
  html:not([data-theme="light"]) .colgroup-row:hover,
  html:not([data-theme="light"]) .nav-in.menu-open > a:not(.logo):not(.user):hover{background:#1e293b}
  html:not([data-theme="light"]) .comment-input textarea{background:#0f172a;border-color:#1e293b;color:#e2e8f0}
  html:not([data-theme="light"]) .comment-user-row button{background:#1e293b;border-color:#334155}
  html:not([data-theme="light"]) .pager-block .pg-item{border-color:#1e293b}
}
html[data-theme="dark"] body{background:#0b1220;color:#e2e8f0}
html[data-theme="dark"] .nav{background:rgba(17,26,44,.85);border-bottom:1px solid #1e293b}
html[data-theme="dark"] .nav a{color:#94a3b8}
html[data-theme="dark"] .article-card,
html[data-theme="dark"] .comments,
html[data-theme="dark"] .related-block,
html[data-theme="dark"] .side-block{background:#111a2c;border-color:#1e293b}
html[data-theme="dark"] h1,
html[data-theme="dark"] .c-name,
html[data-theme="dark"] .pager-block .pg-title{color:#e2e8f0}
html[data-theme="dark"] .content{color:#cbd5e1}
html[data-theme="dark"] .content blockquote{background:#12263a;color:#94a3b8}
html[data-theme="dark"] .content th,.content td{border-color:#1e293b}
html[data-theme="dark"] .content th{background:#1e293b}
html[data-theme="dark"] .content p code,
html[data-theme="dark"] .content li code{background:#1e293b;color:#93c5fd}
html[data-theme="dark"] .comment-item,
html[data-theme="dark"] .toc-list li,
html[data-theme="dark"] .side-arts li{border-color:#1e293b}
html[data-theme="dark"] .c-content,
html[data-theme="dark"] .related-list a,
html[data-theme="dark"] .colgroup-row,
html[data-theme="dark"] .toc-list a,
html[data-theme="dark"] .side-arts a{color:#94a3b8}
html[data-theme="dark"] .colgroup-row:hover,
html[data-theme="dark"] .nav-in.menu-open > a:not(.logo):not(.user):hover{background:#1e293b}
html[data-theme="dark"] .comment-input textarea{background:#0f172a;border-color:#1e293b;color:#e2e8f0}
html[data-theme="dark"] .comment-user-row button{background:#1e293b;border-color:#334155}
html[data-theme="dark"] .pager-block .pg-item{border-color:#1e293b}
/* FR-X10 点赞/收藏栏（likes.js 内联样式是白底，这里深色覆盖） */
html[data-theme="dark"] .al-bar{background:#111a2c!important;border-color:#1e293b!important}
html[data-theme="dark"] .al-btn{background:#1e293b!important;border-color:#334155!important;color:#cbd5e1!important}
html[data-theme="dark"] .al-btn.on{background:linear-gradient(135deg,#2563eb,#0ea5e9)!important;border-color:transparent!important;color:#fff!important}
html[data-theme="dark"] .al-btn .al-cnt{color:#94a3b8!important}
html[data-theme="dark"] .al-tip{color:#64748b!important}
/* 评论区强化覆盖（防被后加载的内联样式盖回白底） */
html[data-theme="dark"] .comments{background:#111a2c!important;border-color:#1e293b!important;color:#e2e8f0}
html[data-theme="dark"] .comments h3{color:#60a5fa!important}
html[data-theme="dark"] .c-empty{color:#94a3b8!important}
html[data-theme="dark"] .comment-input textarea{background:#0f172a!important;border-color:#1e293b!important;color:#e2e8f0!important}
</style>
</head>
<body>
<header class="nav">
  <div class="nav-in" id="navIn">
    <a class="logo" href="/index.html">清逸的博客</a>
    <nav class="nav-links" id="navLinks">
      <a href="/index.html">首页</a>
      <a href="/article/index.html">文章</a>
      <a href="/aboutme/index.html">关于我</a>
      <a href="/search/index.html" data-search="1">搜索</a>
    </nav>
    <div class="nav-user" id="navUser"><a href="/user/login.html">登录</a><a href="/user/login.html#register" style="margin-left:10px">注册</a></div>
<script>
/* 首帧即正确渲染登录态（不依赖外部 header-fix.js 下载，消除闪现） */
(function(){
  try{
    var b=document.getElementById("navUser"); if(!b) return;
    var esc=function(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});};
    var u=localStorage.getItem("xw_username");
    if(u){
      b.setAttribute("data-nav-user","ready");
      b.innerHTML='<div class="nav-user-menu" style="position:relative;display:inline-block">'+
        '<button type="button" class="nav-uname" style="border:1px solid rgba(148,163,184,.45);background:rgba(148,163,184,.12);color:#475569;cursor:pointer;font-size:13px;font-weight:600;padding:5px 14px;border-radius:999px;line-height:1.4">'+esc(u)+'</button>'+
        '<div class="nav-user-dropdown" style="position:absolute;top:calc(100% + 6px);right:0;min-width:140px;background:#fff;border:1px solid #e6edf5;border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.12);padding:6px;z-index:100;display:none">'+
          '<a href="/user/profile.html" style="display:block;padding:9px 14px;border-radius:8px;color:#0f172a;text-decoration:none;font-size:13.5px">👤 个人中心</a>'+
          '<a href="#" id="navLogoutBtn" style="display:block;padding:9px 14px;border-radius:8px;color:#dc2626;text-decoration:none;font-size:13.5px">退出</a>'+
        '</div></div>';
      var un=b.querySelector(".nav-uname"), m=b.querySelector(".nav-user-dropdown");
      if(un&&m){un.onclick=function(ev){ev.stopPropagation();m.style.display=m.style.display==="none"?"block":"none";};document.addEventListener("click",function(ev){if(!b.contains(ev.target))m.style.display="none";});}
      var lo=b.querySelector("#navLogoutBtn");
      if(lo)lo.onclick=function(ev){ev.preventDefault();try{["xw_token","xw_username","shawn_site_token","shawn_site_user","shawn_admin_token","shawn_admin_role"].forEach(function(k){localStorage.removeItem(k);});}catch(e){}try{fetch("/api/user/logout",{method:"POST",credentials:"include"});}catch(e){}location.reload();};
    }
  }catch(e){}
})();
</script>
    <button class="menu-btn" id="menuBtn" onclick="toggleMenu()">☰</button>
  </div>
</header>
<div class="wrap">
<div class="main-col">
  <div class="article-card">
    ${topRow}
    <h1>${title}</h1>
    <div class="content">${lazyImages(post.content || "")}</div>
  </div>
  ${likeButtonHtml(sourceFile, counts)}
  <div class="comments">
    <h3>评论</h3>
    <div class="comment-list" id="commentList"><div class="c-empty">加载中…</div></div>
    <div class="comment-input">
      <textarea id="commentText" placeholder="发表一下看法" maxlength="600"></textarea>
      <button id="commentBtn" onclick="publishComment()">发送</button>
    </div>
    <div class="comment-user-row" id="commentUserRow">
      <button type="button" id="commentLoginBtn" onclick="goLogin()"> 登录 </button>
      <span> 或 匿名发表评论</span>
    </div>
  </div>
  ${relatedHtml}
</div>
<aside class="side-col">
  <div class="side-block">
    <h4>目录</h4>
    <ul class="toc-list" id="tocList"><li><a>加载中…</a></li></ul>
  </div>
  <div class="side-block pager-block">
    <h4>文章导航${colFilter ? "（" + escapeHtml(colFilter) + "）" : ""}</h4>
    ${prevPost ? `<a class="pg-item" id="pgPrev" href="/article/${escapeHtml(prevPost.source_file)}${escapeHtml(colQS)}"><span class="pg-label">上一篇</span><span class="pg-title">${escapeHtml(prevPost.title)}</span></a>` : `<a class="pg-item disabled" id="pgPrev"><span class="pg-label">上一篇</span><span class="pg-title">没有更新的文章</span></a>`}
    ${nextPost ? `<a class="pg-item next" id="pgNext" href="/article/${escapeHtml(nextPost.source_file)}${escapeHtml(colQS)}"><span class="pg-label">下一篇</span><span class="pg-title">${escapeHtml(nextPost.title)}</span></a>` : `<a class="pg-item next disabled" id="pgNext"><span class="pg-label">下一篇</span><span class="pg-title">没有更早的文章</span></a>`}
  </div>
  ${colGroups.length ? `<div class="side-block">
    <h4 id="colTitle">分类专栏${colFilter ? "（" + escapeHtml(colFilter) + "）" : ""}</h4>
    <div id="colPanel">${colPanelHtml}</div>
  </div>` : ""}
</aside>
</div>
<script>
var PAGE_ID = ${JSON.stringify(pageId)};
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
/* 阅读量打点：详情页打开 +1（幂等：同一会话同一文章只计一次，交给 Worker POST /api/view） */
(function(){
  try{
    if(!PAGE_ID)return;
    var k="blog_viewed_"+PAGE_ID,seen=null;
    try{seen=sessionStorage.getItem(k);}catch(e){}
    if(seen)return;
    try{sessionStorage.setItem(k,"1");}catch(e){}
    fetch("/api/view",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({source_file:PAGE_ID,id:PAGE_ID})}).catch(function(){});
  }catch(e){}
})();
function loadComments(){
  fetch("/api/pinlun/list",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:PAGE_ID,pageIndex:1})})
    .then(function(r){return r.json();}).then(function(j){
      var box=document.getElementById("commentList");
      var list=(j.success&&j.data&&j.data.list)||[];
      if(!list.length){box.innerHTML='<div class="c-empty">暂无评论，来抢沙发</div>';return;}
      box.innerHTML=list.map(function(c){
        var u=(c.user&&c.user.name)||"匿名用户";
        return '<div class="comment-item"><span class="c-name">'+esc(u)+'</span><span class="c-time">'+esc(c.time||"")+'</span><div class="c-content">'+esc(c.content||"")+'</div></div>';
      }).join("");
    }).catch(function(){document.getElementById("commentList").innerHTML='<div class="c-empty">评论加载失败</div>';});
}
function publishComment(){
  var t=document.getElementById("commentText");
  var v=t.value.trim();
  if(!v){alert("评论内容不能为空");return;}
  var btn=document.getElementById("commentBtn");
  btn.disabled=true;btn.textContent="发送中…";
  var body={id:PAGE_ID,text:v};
  // 已登录则带上用户名署名，否则匿名
  fetch("/api/user/info").then(function(r){return r.json();}).then(function(j){
    if(j&&j.success&&j.data){
      body.name=(j.data.profile&&j.data.profile.name)||j.data.username||"";
    }
    return fetch("/api/pinlun/publish",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  }).catch(function(){return fetch("/api/pinlun/publish",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});})
    .then(function(r){return r.json();}).then(function(j){
      btn.disabled=false;btn.textContent="发送";
      if(j.success){t.value="";loadComments();}else{alert(j.msg||"发表失败");}
    }).catch(function(){btn.disabled=false;btn.textContent="发送";alert("发表失败，请稍后再试");});
}
// 评论区用户行：读 Cookie 会话（/api/user/info）显示登录昵称。
// 注意：导航栏登录态统一由 header-fix.js 的 renderNavUser 渲染（读 localStorage），
// 此处**不再**渲染 #navUser，避免两套数据源互相覆盖导致「登录/注册」与下拉菜单交替闪现。
(function(){
  fetch("/api/user/info").then(function(r){return r.json();}).then(function(j){
    if(!(j&&j.success&&j.data)){return;}
    var name=(j.data.profile&&j.data.profile.name)||j.data.username||"用户";
    var crow=document.getElementById("commentUserRow");
    if(crow){crow.innerHTML='<span class="uname">'+esc(name)+'</span><span>（将以该身份发表评论）</span>';}
  }).catch(function(){});
})();
function goLogin(){ location.href="/user/login.html?next="+encodeURIComponent(location.pathname+location.search); }
function toggleMenu(){ document.getElementById("navIn").classList.toggle("menu-open"); }
/* 分类专栏两态切换：默认展示专栏列表+数量；点击进入该专栏展示文章（上/下篇同步限定在该专栏内） */
var LOADED_COL = ${JSON.stringify(colFilter)};
var PAGER_INIT = {};
function colURL(name){ var p=location.pathname; return name?(p+"?col="+encodeURIComponent(name)):p; }
function colTitleSet(name){
  var h=document.getElementById("colTitle");
  if(h)h.textContent=name?("分类专栏（"+name+"）"):"分类专栏";
}
function bindColRows(){
  var panel=document.getElementById("colPanel");
  if(!panel)return;
  panel.querySelectorAll(".colgroup-row").forEach(function(row){
    row.onclick=function(){showColumn(row.getAttribute("data-col"));};
  });
}
function colRowHtml(name,cnt,on){
  return '<div class="colgroup-row'+(on?" on":"")+'" data-col="'+esc(name)+'"><span class="colgroup-name">'+esc(name)+'</span><span class="colgroup-cnt">'+cnt+' 篇</span></div>';
}
function buildArts(list,col){
  if(!list.length)return '<div class="c-empty" style="font-size:12.5px;color:#94a3b8;padding:10px 0">该专栏暂无文章</div>';
  var q=col?("?col="+encodeURIComponent(col)):"";
  return '<ul class="side-arts">'+list.map(function(a){
    return '<li><a href="/article/'+esc(a.source_file)+q+'">'+esc(a.title)+'</a></li>';
  }).join("")+'</ul>';
}
function setPager(id,label,item,col){
  var el=document.getElementById(id);
  if(!el)return;
  var isNext=id==="pgNext";
  var base="pg-item"+(isNext?" next":"");
  var head='<span class="pg-label">'+label+'</span>';
  if(item){
    el.className=base;
    el.setAttribute("href","/article/"+encodeURIComponent(item.source_file)+(col?("?col="+encodeURIComponent(col)):""));
    el.innerHTML=head+'<span class="pg-title">'+esc(item.title)+'</span>';
  }else{
    el.className=base+" disabled";
    el.removeAttribute("href");
    el.innerHTML=head+'<span class="pg-title">'+(isNext?"没有更早的文章":"没有更新的文章")+'</span>';
  }
}
function restorePager(){
  ["pgPrev","pgNext"].forEach(function(id){
    var el=document.getElementById(id),init=PAGER_INIT[id];
    if(!el||!init)return;
    el.className=init.cls;el.innerHTML=init.html;
    if(init.href)el.setAttribute("href",init.href);else el.removeAttribute("href");
  });
}
/* 兜底：若 /api/columns/<name>/articles 未生效，用公开文章列表在前端筛选该专栏 */
function artsFromPosts(payload,col,cur){
  var list=((payload&&payload.data&&payload.data.list)||[]).filter(function(p){
    return p&&p.source_file&&(p.columns||[]).indexOf(col)>=0;
  });
  list.sort(function(a,b){return String(b.created_at||"").localeCompare(String(a.created_at||""));});
  var idx=-1;
  list.forEach(function(p,i){if(p.source_file===cur)idx=i;});
  return {
    ok:true,
    data:list.map(function(p){return {title:p.title,source_file:p.source_file};}),
    prev:idx>0?{title:list[idx-1].title,source_file:list[idx-1].source_file}:null,
    next:(idx>=0&&idx<list.length-1)?{title:list[idx+1].title,source_file:list[idx+1].source_file}:null
  };
}
function loadColumn(name,cb){
  var done=false;
  function fin(v){if(!done){done=true;cb(v);}}
  fetch("/api/columns/"+encodeURIComponent(name)+"/articles?cur="+encodeURIComponent(PAGE_ID))
    .then(function(r){return r.json();})
    .then(function(j){
      if(j&&j.ok&&j.data){fin(j);return;}
      throw new Error("fallback");
    })
    .catch(function(){
      fetch("/api/public/posts.json").then(function(r){return r.json();})
        .then(function(j){fin(artsFromPosts(j,name,PAGE_ID));})
        .catch(function(){fin({ok:false,data:[]});});
    });
}
function showColumn(name){
  var panel=document.getElementById("colPanel");
  if(!panel||!name)return;
  panel.innerHTML='<span class="col-back" onclick="showColumns()">← 返回专栏</span><div class="c-empty" style="font-size:12.5px;color:#94a3b8;padding:10px 0">加载中…</div>';
  colTitleSet(name);
  try{history.replaceState(null,"",colURL(name));}catch(e){}
  loadColumn(name,function(j){
    if(!j||!j.ok){
      panel.innerHTML='<span class="col-back" onclick="showColumns()">← 返回专栏</span><div class="c-empty" style="font-size:12.5px;color:#94a3b8;padding:10px 0">加载失败</div>';
      return;
    }
    var list=j.data||[];
    panel.innerHTML='<span class="col-back" onclick="showColumns()">← 返回专栏</span>'+colRowHtml(name,list.length,true)+buildArts(list,name);
    bindColRows();
    if(j&&(j.prev!==undefined||j.next!==undefined)){
      setPager("pgPrev","上一篇",j.prev||null,name);
      setPager("pgNext","下一篇",j.next||null,name);
    }
  });
}
function showColumns(){
  /* 本页是从 ?col= 直出进入的：回到无分栏状态需要服务端重算上/下篇，直接跳回 */
  if(LOADED_COL){location.href=colURL("");return;}
  var panel=document.getElementById("colPanel");
  if(!panel)return;
  colTitleSet("");restorePager();
  try{history.replaceState(null,"",colURL(""));}catch(e){}
  fetch("/api/public/columns.json").then(function(r){return r.json();}).then(function(j){
    var cols=(j&&j.data)||[];
    if(!cols.length){panel.innerHTML='<div class="c-empty" style="font-size:12.5px;color:#94a3b8;padding:10px 0">暂无专栏</div>';return;}
    panel.innerHTML=cols.map(function(c){
      var name=c.name, cnt=c.cnt!=null?c.cnt:0;
      return colRowHtml(name,cnt,false);
    }).join("");
    bindColRows();
  }).catch(function(){panel.innerHTML='<div class="c-empty" style="font-size:12.5px;color:#94a3b8;padding:10px 0">加载失败</div>';});
}
/* 记录首屏（无分栏时）的上/下篇，便于「返回专栏」还原 */
(function(){
  ["pgPrev","pgNext"].forEach(function(id){
    var el=document.getElementById(id);
    if(el)PAGER_INIT[id]={html:el.innerHTML,cls:el.className,href:el.getAttribute("href")||""};
  });
})();
// 目录提取：从正文 h2/h3 生成锚点列表
(function(){
  var heads=document.querySelectorAll(".content h2, .content h3");
  var ul=document.getElementById("tocList");
  if(!ul)return;
  if(!heads.length){ul.innerHTML='<li><a>无目录</a></li>';return;}
  var html="";
  heads.forEach(function(h,i){
    if(!h.id)h.id="sec-"+i;
    var cls=h.tagName==="H3"?' class="lv3"':"";
    html+='<li'+cls+'><a href="#'+h.id+'">'+esc(h.textContent)+"</a></li>";
  });
  ul.innerHTML=html;
})();
function doLogout(){
  fetch("/api/user/logout",{method:"POST"}).then(function(){location.reload();}).catch(function(){location.reload();});
}
/* 初始专栏列表绑定点击事件（事件委托）；?col= 直出时面板已处于文章展示态，无需绑定 */
(function(){ bindColRows(); })();
loadComments();
/* FR-X8：代码块复制按钮 + 图片灯箱（纯前端增强，不动数据） */
(function(){
  // ① 代码复制：给每个 <pre> 右上角加「复制」按钮
  document.querySelectorAll(".content pre").forEach(function(pre){
    var btn=document.createElement("button");
    btn.type="button";btn.className="copy-btn";btn.textContent="复制";
    btn.onclick=function(){
      /* 只复制代码文本：优先取 <code> 子元素；否则克隆 pre 并剔除按钮自身，避免把"复制"二字带上 */
      var code=pre.querySelector("code");
      var txt="";
      if(code){txt=code.textContent||"";}
      else{
        var clone=pre.cloneNode(true);
        var b=clone.querySelector(".copy-btn");if(b)b.remove();
        txt=clone.textContent||"";
      }
      function done(){btn.textContent="已复制";btn.classList.add("done");setTimeout(function(){btn.textContent="复制";btn.classList.remove("done");},1500);}
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(txt).then(done).catch(function(){fallbackCopy(txt);done();});
      }else{fallbackCopy(txt);done();}
    };
    pre.appendChild(btn);
  });
  function fallbackCopy(t){
    try{
      var ta=document.createElement("textarea");ta.value=t;ta.style.position="fixed";ta.style.opacity="0";
      document.body.appendChild(ta);ta.select();document.execCommand("copy");document.body.removeChild(ta);
    }catch(e){}
  }
  // ② 图片灯箱：点击正文图片放大查看
  var lb=document.createElement("div");
  lb.className="lightbox";
  lb.innerHTML='<span class="lb-close">&times;</span><img alt="">';
  document.body.appendChild(lb);
  var lbImg=lb.querySelector("img");
  function closeLb(){lb.classList.remove("on");}
  lb.addEventListener("click",function(e){if(e.target!==lbImg)closeLb();});
  lbImg.addEventListener("click",function(e){e.stopPropagation();});
  document.querySelectorAll(".content img").forEach(function(img){
    img.style.cursor="zoom-in";
    img.addEventListener("click",function(){
      lbImg.src=img.getAttribute("src")||img.src;lb.classList.add("on");
    });
  });
})();
</script>
<script src="/js/header-fix.js"></script>
</body>
</html>`;
}

async function fetchStaticArticle(env, sourceFile) {
  const rawBase = String(env.RAW_ARTICLE_BASE || "").trim().replace(/\/+$/, "");
  if (!rawBase) return "";
  const resp = await fetch(rawBase + "/" + sourceFile, { headers: { "user-agent": "qingyi-blog-worker" } });
  if (!resp.ok) return "";
  return await resp.text();
}

/* 回退：直接把请求转发到 GitHub Pages 的静态文章 */
async function passthroughArticle(request, env) {
  return proxyStatic(request, env);
}

/**
 * 后台访问保护：/admin/* 仅管理员（session 有效且 role 为 admin/super_admin）可访问。
 * 校验通过 → 回源静态后台页面；未登录/非管理员 → 返回 404（与不存在无异，防探测）。
 */
/* 未登录/非管理员访问 /admin 时：302 跳转前端登录页（带 next 回跳），不展示后台拦截页 */
function redirectToLogin(nextPath) {
  const next = encodeURIComponent(nextPath || "/admin/index.html");
  return new Response(null, {
    status: 302,
    headers: { location: "/user/login.html?next=" + next, "cache-control": "no-store" },
  });
}

async function guardAdmin(request, env) {
  const db = env.DB;
  if (!db) return notFound();

  // 方式一：X-Token（admin 界面 localStorage 的 shawn_admin_token）
  const xToken = (request.headers.get("X-Token") || "").slice(0, 80);
  // 方式二：Cookie session（登录页 Set-Cookie）
  const cookie = parseCookie(request);
  const cToken = (cookie.session || "").slice(0, 80);

  const token = xToken || cToken;
  if (!token) return redirectToLogin("/admin/index.html");

  let role = null;
  try {
    const row = await db.prepare(
      "SELECT u.role, u.status, s.expire_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?1"
    ).bind(token).first();
    if (!row) return redirectToLogin("/admin/index.html");
    if (row.expire_at < nowMs()) return redirectToLogin("/admin/index.html");
    if (row.status !== 1) return redirectToLogin("/admin/index.html");
    if (row.role !== "admin" && row.role !== "super_admin") {
      // 已登录但非管理员：跳首页（若跳登录页会因"已登录"而死循环）
      return new Response(null, {
        status: 302,
        headers: { location: "/index.html", "cache-control": "no-store" },
      });
    }
    role = row.role;
  } catch (e) {
    return redirectToLogin("/admin/index.html");
  }

  // 管理员通过：动态返回后台页面（Pages 上已不部署 admin，从 raw 仓库源码拉取）
  const url = new URL(request.url);
  const relPath = url.pathname.replace(/^\/admin\/?/, "");
  // /admin 或 /admin/ → index.html；/admin/web/editor.html → web/editor.html
  const file = relPath || "index.html";
  const html = await fetchAdminAsset(env, file);
  if (!html) return notFound();

  // 静态资源（js/css/图片等非 html）按扩展名给类型
  const mimeMap = {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "application/javascript; charset=utf-8",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    svg: "image/svg+xml", ico: "image/x-icon", woff2: "font/woff2", woff: "font/woff",
  };
  const ext = (file.split(".").pop() || "").toLowerCase();
  const mime = mimeMap[ext] || "application/octet-stream";
  const cacheCtl = ext === "html" ? "no-store" : "public, max-age=3600";
  return new Response(html, { status: 200, headers: { "content-type": mime, "cache-control": cacheCtl } });
}

/* 从 raw 仓库拉取 admin 后台静态文件（源码仓库本身公开，无额外泄露）。
 * 回源 URL 追加 av 版本参数绕过 raw CDN 缓存，保证 push 后 admin 页面立即更新。 */
async function fetchAdminAsset(env, relFile) {
  const rawBase = String(env.RAW_ADMIN_BASE || "").trim().replace(/\/+$/, "");
  if (!rawBase) return "";
  // 防目录穿越
  const safe = relFile.replace(/\\/g, "/").split("/").filter(s => s && s !== "." && s !== "..").join("/");
  if (!safe) return "";
  const bust = (safe.endsWith(".html") || safe.endsWith(".js") || safe.endsWith(".css"))
    ? "?av=" + ASSET_VER
    : "";
  const resp = await fetch(rawBase + "/" + safe + bust, { headers: { "user-agent": "qingyi-blog-worker" } });
  if (!resp.ok) return "";
  return await resp.text();
}

function notFound() {
  return new Response("404 Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/**
 * 静态资源反向代理：回源 GitHub Pages 裸源。
 * 关键：Pages 已设自定义域名，裸源请求会 301 到自定义域名（会再次进 Worker 造成死循环），
 * 因此用 redirect:"manual"，收到 301 时把 Location 里的自定义域名改写回裸源，再跟随一次。
 */
async function proxyStatic(request, env) {
  const staticOrigin = String(env.STATIC_ORIGIN || "").trim().replace(/\/+$/, "");
  const customHost = String(env.CUSTOM_HOST || "blog.qingyi.dpdns.org").trim();
  if (!staticOrigin) {
    return new Response("静态源未配置（STATIC_ORIGIN）", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const url = new URL(request.url);
  // 部署版本号 cache-busting：核心行为文件与所有 HTML 页面回源时追加 ?av=，
  // 绕过 GitHub Pages/CDN 的旧文件缓存，保证 deploy/push 后改动立即生效。
  // （用户可见的 URL 不变，只有 Worker→Pages 的回源 URL 带上 av 参数。）
  // ⚠ 每次前端资源更新后，把 ASSET_VER 递增一位（如 a→b）。
  let pathname = url.pathname;
  let search = url.search;
  const isCoreAsset = pathname === "/js/header-fix.js" || pathname === "/soulsoft-tools.css";
  const isHtmlPage = pathname.endsWith(".html") || pathname.endsWith("/") ||
    !/\.[a-zA-Z0-9]+$/.test(pathname);
  if (isCoreAsset || isHtmlPage) {
    search = (search ? search + "&" : "?") + "av=" + ASSET_VER;
  }
  let target = staticOrigin + pathname + search;

  for (let hop = 0; hop < 3; hop++) {
    const resp = await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    });
    // 2xx：直接透传
    if (resp.ok) {
      const headers = new Headers(resp.headers);
      headers.set("access-control-allow-origin", "*");
      // NFR-X1：回源静态页只补「不与页面脚本冲突」的安全头（不下发 CSP，见文件顶部 PROXY_SAFE_HEADERS 说明）
      for (const name of PROXY_SAFE_HEADERS) {
        if (!headers.has(name) && SECURITY_HEADERS[name]) headers.set(name, SECURITY_HEADERS[name]);
      }
      return new Response(resp.body, { status: resp.status, headers });
    }
    // 3xx：把 Location 里的自定义域名改回裸源，继续跟随（保留 av cache-busting 参数）
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location") || "";
      if (!loc) break;
      let next = loc;
      if (loc.startsWith("/") ) {
        // 相对路径：拼到裸源
        next = "https://kingku-shawn.github.io" + loc;
      } else {
        next = loc.replace("https://" + customHost, "https://kingku-shawn.github.io/blog");
      }
      // 重定向丢失了 av 参数时补回（Pages 301 常常剥掉 query）
      if (search && next.indexOf("av=" + ASSET_VER) < 0) {
        next += (next.indexOf("?") >= 0 ? "&" : "?") + "av=" + ASSET_VER;
      }
      target = next;
      continue;
    }
    // 4xx/5xx：透传
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  }
  return new Response("重定向次数过多", { status: 508, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/* 用 D1 的 title/content/summary/tags 替换静态 HTML 骨架里的对应节点 */
function renderArticleHtml(html, post) {
  let out = html;

  // 替换标题
  out = out.replace(/<h1 class="detail-title"[^>]*>[\s\S]*?<\/h1>/, `<h1 class="detail-title">${escapeHtml(post.title || "")}</h1>`);

  // 替换正文（detail-content 内部）
  out = replaceDetailContent(out, post.content || "");

  return out;
}

/** NFR-X5：给正文里的 <img> 补 loading="lazy" / decoding="async"（已有 loading 的不动），减少首屏带宽与解码压力 */
function lazyImages(html) {
  try {
    return String(html == null ? "" : html).replace(/<img\b([^>]*)>/gi, function (m, attrs) {
      if (/\bloading\s*=/i.test(attrs)) return m;
      return "<img loading=\"lazy\" decoding=\"async\"" + attrs + ">";
    });
  } catch (e) {
    return html == null ? "" : String(html);
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* 替换 <div class="detail-content">...</div> 内部为给定 content。
   正文结束锚点：`<div class="xw-pinlun2`（评论组件开始）。
   替换后补回正文和外层的闭合标签 </div></div>，保证结构完整。 */
function replaceDetailContent(html, content) {
  const marker = 'class="detail-content"';
  const i = html.indexOf(marker);
  if (i < 0) return html;
  let start = html.indexOf(">", i);
  if (start < 0) return html;
  start += 1;
  const endAnchor = '<div class="xw-pinlun2';
  let end = html.indexOf(endAnchor, start);
  if (end < 0) {
    end = html.indexOf("<script", start);
    if (end < 0) end = html.length;
  }
  const head = html.slice(0, start);
  const tail = html.slice(end);
  // content 后补回 detail-content 闭合 + 外层 detail-section/content 的闭合
  return head + content + "</div></div>" + tail;
}

/* ------------------------------------------------------------------ */
/* 登录 / 注册（D1 账号体系，对齐 user/login.html 的 {ok,token,user} 契约） */
/* ------------------------------------------------------------------ */

function hexEncode(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, saltHex) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations: 100000 },
    keyMaterial, 256
  );
  return hexEncode(bits);
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function handleRegister(request, env, ctx) {
  if (request.method === "OPTIONS") return json({ ok: true });
  const db = env.DB;
  if (!db) return json({ ok: false, msg: "数据库未绑定" }, 500);
  const body = (await readBody(request)) || {};
  const username = String(body.username || "").trim().slice(0, 32);
  const nickname = String(body.nickname || "").trim().slice(0, 40);
  const password = String(body.password || "");
  if (!/^[A-Za-z0-9_\-\.]{3,32}$/.test(username)) return json({ ok: false, msg: "用户名需为 3-32 位字母、数字、下划线" });
  if (password.length < 6) return json({ ok: false, msg: "密码至少 6 位" });

  const exists = await db.prepare("SELECT id FROM users WHERE username = ?1").bind(username).first();
  if (exists) return json({ ok: false, msg: "用户名已存在" });

  const salt = hexEncode(crypto.getRandomValues(new Uint8Array(8)));
  const hash = await hashPassword(password, salt);
  // 管理员机制：环境变量 ADMIN_USER 指定的用户名注册即管理员；否则首个注册账号自动成为管理员
  let role = "user";
  const adminUser = String(env.ADMIN_USER || "").trim();
  if (adminUser && username === adminUser) {
    role = "admin";
  } else {
    const anyUser = await db.prepare("SELECT COUNT(*) AS c FROM users").first();
    if (!anyUser || anyUser.c === 0) role = "admin";
  }
  await db.prepare(
    "INSERT INTO users (username, nickname, pass_salt, pass_hash, role, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)"
  ).bind(username, nickname || username, salt, hash, role, nowMs()).run();
  // FR-X21：注册事件通知（站内信 + Webhook，best-effort；没有 ctx 时模块内部 fire-and-forget）
  void notifyEvent(env, ctx, "user.register", { username: username, role: role, link: "/admin/index.html" });
  return json({ ok: true, msg: role === "admin" ? "注册成功（管理员）" : "注册成功", role });
}

/* 首次登录时：若用户表为空，且配置了 ADMIN_USER + ADMIN_PASS，则自动创建管理员账号 */
async function ensureSeedAdmin(db, env) {
  const adminUser = String(env.ADMIN_USER || "").trim();
  const adminPass = String(env.ADMIN_PASS || "").trim();
  if (!adminUser || !adminPass) return null;
  const any = await db.prepare("SELECT COUNT(*) AS c FROM users").first();
  if (any && any.c > 0) return null; // 已有用户，不再种子
  const salt = hexEncode(crypto.getRandomValues(new Uint8Array(8)));
  const hash = await hashPassword(adminPass, salt);
  await db.prepare(
    "INSERT INTO users (username, nickname, pass_salt, pass_hash, role, status, created_at) VALUES (?1, ?2, ?3, ?4, 'admin', 1, ?5)"
  ).bind(adminUser, adminUser, salt, hash, nowMs()).run();
  return adminUser;
}

/* ------------------------------------------------------------------ */
/* Cookie 会话（Vue 评论组件契约：/api/user/login|info|logout）           */
/* ------------------------------------------------------------------ */

function parseCookie(request) {
  const c = request.headers.get("cookie") || "";
  const out = {};
  c.split(";").forEach(function (kv) {
    const i = kv.indexOf("=");
    if (i < 0) return;
    out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  });
  return out;
}

async function userRowToVue(db, row) {
  // Vue user store 期望的 user 对象结构
  return {
    _id: String(row.id),
    username: row.username,
    email: row.email || row.username,
    avatar: row.avatar || "",
    role: row.role || "user",
    isc: row.role === "super_admin",
    profile: { name: row.nickname || row.username },
    token: "",
  };
}

async function handleUserLogin(request, env) {
  if (request.method === "OPTIONS") return json({ ok: true });
  const db = env.DB;
  if (!db) return json({ ok: false, msg: "数据库未绑定" }, 500);
  await ensureSeedAdmin(db, env);
  const body = (await readBody(request)) || {};
  const username = String(body.username || "").trim().slice(0, 32);
  const password = String(body.password || "");
  const user = await db.prepare("SELECT * FROM users WHERE username = ?1 AND status = 1").bind(username).first();
  if (!user) return json({ success: false, msg: "用户名或密码错误" });
  const hash = await hashPassword(password, user.pass_salt);
  if (hash !== user.pass_hash) return json({ success: false, msg: "用户名或密码错误" });

  const token = hexEncode(crypto.getRandomValues(new Uint8Array(24)));
  const now = nowMs();
  await db.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expire_at) VALUES (?1, ?2, ?3, ?4)"
  ).bind(token, user.id, now, now + 8 * 3600 * 1000).run();

  const vueUser = await userRowToVue(db, { ...user, avatar: user.avatar || "" });
  const headers = {
    "set-cookie": "session=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800",
  };
  return new Response(JSON.stringify({ success: true, data: vueUser }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", ...headers },
  });
}

async function handleUserInfo(request, env) {
  const db = env.DB;
  if (!db) return json({ ok: false, msg: "数据库未绑定" }, 500);
  const cookie = parseCookie(request);
  const token = (cookie.session || "").slice(0, 80);
  if (!token) return json({ success: false, msg: "未登录" });
  const row = await db.prepare(
    "SELECT u.*, s.expire_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?1"
  ).bind(token).first();
  if (!row || row.expire_at < nowMs()) return json({ success: false, msg: "会话已过期" });
  if (row.status !== 1) return json({ success: false, msg: "账号已被禁用" });
  const vueUser = await userRowToVue(db, row);
  return json({ success: true, data: vueUser });
}

async function handleUserLogout(request, env) {
  const db = env.DB;
  const cookie = parseCookie(request);
  const token = (cookie.session || "").slice(0, 80);
  if (db && token) {
    await db.prepare("DELETE FROM sessions WHERE token = ?1").bind(token).run();
  }
  return new Response(JSON.stringify({ success: true, data: null }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "set-cookie": "session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0", "access-control-allow-origin": "*" },
  });
}

async function handleLogin(request, env) {
  if (request.method === "OPTIONS") return json({ ok: true });
  const db = env.DB;
  if (!db) return json({ ok: false, msg: "数据库未绑定" }, 500);
  await ensureSeedAdmin(db, env);
  const body = (await readBody(request)) || {};
  const username = String(body.username || "").trim().slice(0, 32);
  const password = String(body.password || "");
  const user = await db.prepare("SELECT * FROM users WHERE username = ?1 AND status = 1").bind(username).first();
  if (!user) return json({ ok: false, msg: "用户名或密码错误" });
  const hash = await hashPassword(password, user.pass_salt);
  if (hash !== user.pass_hash) return json({ ok: false, msg: "用户名或密码错误" });

  const token = hexEncode(crypto.getRandomValues(new Uint8Array(24)));
  const now = nowMs();
  await db.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expire_at) VALUES (?1, ?2, ?3, ?4)"
  ).bind(token, user.id, now, now + 8 * 3600 * 1000).run();
  const u = { username: user.username, nickname: user.nickname || user.username, email: user.email || "", role: user.role || "user", role_name: roleName(user.role || "user") };
  // 兼容三种前端契约：
  //   登录页（user/login.html）：{ ok, token, user:{username,nickname,role} }
  //   admin 界面：{ ok, token, user:{...role_name} }
  //   旧 Vue 弹窗（index-D-3VvwBs.js 的 Am）：{ success, data:{...user, token, _id} }
  // 同时 Set-Cookie，让 Vue 评论组件（Cookie 会话）也能识别登录态
  return new Response(JSON.stringify({
    ok: true,
    success: true,
    token,
    user: u,
    data: { ...u, token, _id: String(user.id), avatar: "", email: user.email || user.username, profile: { name: u.nickname } },
  }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "set-cookie": "session=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800",
    },
  });
}

async function handleMe(request, env) {
  const db = env.DB;
  if (!db) return json({ ok: false, msg: "数据库未绑定" }, 500);
  const token = (request.headers.get("X-Token") || "").slice(0, 80);
  if (!token) return json({ success: false, ok: false, msg: "未登录" }, 200);
  const row = await db.prepare(
    "SELECT u.id, u.username, u.nickname, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id " +
    "WHERE s.token = ?1 AND s.expire_at > ?2"
  ).bind(token, nowMs()).first();
  if (!row) return json({ success: false, ok: false, msg: "会话已过期" }, 200);
  const u = { username: row.username, nickname: row.nickname || row.username, email: row.email || "", role: row.role || "user" };
  // admin 界面 boot() 期望 { ok, user:{...role_name}, perms[] }
  const perms = rolePerms(u.role);
  return json({
    ok: true,
    success: true,
    user: { ...u, role_name: roleName(u.role) },
    perms,
    data: { ...u, _id: String(row.id), avatar: "", email: row.email || row.username, profile: { name: u.nickname }, is_admin: isAdminRole(u.role) },
  });
}

async function handleLogout(request, env) {
  const db = env.DB;
  // 优先 X-Token，其次 Cookie session（登录页 Set-Cookie 的会话）
  const xToken = (request.headers.get("X-Token") || "").slice(0, 80);
  const cookie = parseCookie(request);
  const cToken = (cookie.session || "").slice(0, 80);
  const token = xToken || cToken;
  if (db && token) {
    await db.prepare("DELETE FROM sessions WHERE token = ?1").bind(token).run();
  }
  // 清除浏览器 Cookie，避免评论区/旧组件读 /api/user/info 仍判为已登录
  return json({ ok: true, success: true, data: null }, 200, {
    "set-cookie": "session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
  });
}

/* 角色 → 权限映射（对齐 admin/server.py 的 ROLE_PERMS） */
function roleName(role) {
  return { super_admin: "超级管理员", admin: "管理员", user: "普通用户" }[role] || role;
}
function isAdminRole(role) {
  return role === "super_admin" || role === "admin";
}
function rolePerms(role) {
  if (role === "super_admin") return ["dashboard", "users", "posts", "categories", "comments", "settings", "tags", "columns", "import_posts"];
  if (role === "admin") return ["dashboard", "posts", "categories", "comments", "settings", "tags", "columns", "import_posts"];
  return ["dashboard"];
}

/** 客户端指纹（“我点过赞”的本地判断，不要求登录） */
function clientKey(request) {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "0.0.0.0";
  const ua = request.headers.get("user-agent") || "";
  return (ip + "|" + ua).slice(0, 180);
}

/**
 * 从 raw.githubusercontent.com 读取静态 JSON（兜底用）。
 * RAW_API_BASE 形如：
 *   https://raw.githubusercontent.com/Kingku-Shawn/blog/main/api
 * 请求 /api/tools.json          → RAW_API_BASE + /tools.json
 * 请求 /api/public/columns.json → RAW_API_BASE + /public/columns.json
 * raw 不经过 GitHub Pages、无自定义域名 301，最安全，杜绝回源死循环。
 */
async function proxyStaticJson(request, env, path) {
  const rawBase = String(env.RAW_API_BASE || "").trim().replace(/\/+$/, "");
  if (!rawBase) {
    return json({ ok: false, msg: "未配置 RAW_API_BASE，静态 JSON 无法兜底" }, 500);
  }
  const rel = path.replace(/^\/api\//, "").replace(/^\//, "");
  // 仅允许安全的 .json 相对路径，防目录穿越 / 任意文件读取
  if (!/^[a-zA-Z0-9_\-/]+\.json$/.test(rel) || rel.includes("..")) {
    return json({ ok: false, msg: "未实现的接口：" + path }, 404);
  }
  const target = rawBase + "/" + rel;
  const resp = await fetch(target, {
    redirect: "follow",
    headers: { "user-agent": "qingyi-blog-worker" },
    cf: { cacheTtl: 120, cacheEverything: true },
  });
  if (!resp.ok) {
    return json({ ok: false, msg: "静态 JSON 不存在（HTTP " + resp.status + "）" }, resp.status);
  }
  const text = await resp.text();
  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=120",
      "access-control-allow-origin": "*",
    },
  });
}

/** 读取静态 posts.json 元数据（真源 = 仓库 raw 文件），带 5 分钟内存缓存 */
let _postsCache = { ts: 0, body: null, promise: null };

async function fetchStaticPosts(env) {
  const postsUrl = String(env.POSTS_URL || "").trim();
  if (!postsUrl) throw new Error("未配置 POSTS_URL（raw 文件地址）");

  // 进程级缓存，减少 raw 请求与 D1 压力
  if (_postsCache.body && nowMs() - _postsCache.ts < 5 * 60 * 1000) {
    return _postsCache.body;
  }
  if (_postsCache.promise) return _postsCache.promise;

  _postsCache.promise = (async () => {
    const resp = await fetch(postsUrl, {
      redirect: "follow",
      headers: { "user-agent": "qingyi-blog-worker" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!resp.ok) throw new Error("上游文章列表不可用（HTTP " + resp.status + "）");
    const text = await resp.text();
    let payload;
    try { payload = JSON.parse(text); } catch (e) { throw new Error("上游文章列表格式错误"); }
    _postsCache.ts = nowMs();
    _postsCache.body = payload;
    _postsCache.promise = null;
    return payload;
  })().catch((e) => { _postsCache.promise = null; throw e; });

  return _postsCache.promise;
}

/* ------------------------------------------------------------------ */
/* 阅读量动态化                                                        */
/* ------------------------------------------------------------------ */

/** 文章标识：source_file = "a_<id>.html"，详情页 URL 同为 /article/a_<id>.html */
function normSourceFile(v) {
  let s = String(v == null ? "" : v).trim();
  if (!s) return "";
  s = s.split("/").pop();
  if (s.startsWith("a_") && s.endsWith(".html")) return s;
  if (s.endsWith(".html")) s = s.slice(0, -5);
  return "a_" + s.replace(/^a_/, "") + ".html";
}

async function viewsMap(env) {
  const map = new Map();
  try {
    const rows = await env.DB.prepare("SELECT source_file, count FROM views").all();
    for (const r of rows.results || []) map.set(r.source_file, r.count);
  } catch (e) {
    /* 表未建时忽略，视为全 0 */
  }
  return map;
}

/* 前台文章列表缓存（3 秒，避免高并发下反复查 D1） */
let _postsListCache = { ts: 0, body: null };

async function handlePosts(request, env, ctx) {
  if (request.method === "OPTIONS") return json({ ok: true });
  // 短缓存：3 秒内的重复请求直接返回
  if (_postsListCache.body && nowMs() - _postsListCache.ts < 3000) {
    return json({ ok: true, data: _postsListCache.body.data });
  }
  // 文章真源已迁到 D1 posts 表：优先从 D1 读；D1 为空（未导入）时回退 raw 静态源
  let list = [];
  let source = "d1";
  try {
    const rows = await env.DB.prepare(
      "SELECT id,title,summary,status,is_top,views,source_file,created_at,updated_at,category_id FROM posts WHERE status=1 ORDER BY is_top DESC, created_at DESC, id DESC"
    ).all();
    if (rows.results && rows.results.length) {
      // 一次性聚合查询所有文章的 tags 和 columns，避免逐篇子查询（O(n) 次查询 → 2 次）
      const allTags = await env.DB.prepare(
        "SELECT pt.post_id, t.name FROM post_tags pt JOIN tags t ON t.id=pt.tag_id ORDER BY t.id"
      ).all();
      const allCols = await env.DB.prepare(
        "SELECT pc.post_id, c.name FROM post_columns pc JOIN columns c ON c.id=pc.column_id ORDER BY c.id"
      ).all();
      const tagMap = new Map();
      for (const r of allTags.results || []) {
        if (!tagMap.has(r.post_id)) tagMap.set(r.post_id, []);
        tagMap.get(r.post_id).push(r.name);
      }
      const colMap = new Map();
      for (const r of allCols.results || []) {
        if (!colMap.has(r.post_id)) colMap.set(r.post_id, []);
        colMap.get(r.post_id).push(r.name);
      }
      list = rows.results.map((p) => ({
        id: p.id, title: p.title, summary: p.summary, views: p.views,
        source_file: p.source_file, created_at: p.created_at, updated_at: p.updated_at,
        tags: tagMap.get(p.id) || [],
        columns: colMap.get(p.id) || [],
      }));
    }
  } catch (e) { list = []; }

  if (!list.length) {
    source = "raw";
    try {
      const payload = await fetchStaticPosts(env);
      list = (payload && payload.data && payload.data.list) || [];
    } catch (e) { list = []; }
  }

  const body = { list, source };
  _postsListCache = { ts: nowMs(), body: { data: body } };
  return json({ ok: true, data: body });
}

async function handlePublicColumns(env) {
  try {
    const rows = await env.DB.prepare(
      "SELECT c.name, COUNT(pc.post_id) AS cnt FROM columns c LEFT JOIN post_columns pc ON pc.column_id=c.id GROUP BY c.id ORDER BY c.sort, c.id"
    ).all();
    return json({ ok: true, data: rows.results || [] });
  } catch (e) {
    // 表未建：回退 raw
    const payload = await fetchStaticJson(env, "/api/public/columns.json").catch(() => null);
    return json(payload || { ok: true, data: [] });
  }
}

/* 公开接口：某专栏下的文章列表（详情页右侧「专栏文章展示态」按需拉取）
   可选 ?cur=<source_file>：同时返回该文章在本专栏内的上/下篇，用于原地切换专栏时的导航更新 */
async function handleColumnArticles(request, env, colName) {
  const db = env.DB;
  if (!db) return json({ ok: false, data: [] });
  try {
    const url = new URL(request.url);
    const cur = url.searchParams.get("cur") || "";
    const col = await db.prepare("SELECT id,name FROM columns WHERE name=? ORDER BY sort,id").bind(colName).first();
    if (!col) return json({ ok: true, data: [] });
    const arts = await db.prepare(
      "SELECT p.title, p.source_file FROM post_columns pc JOIN posts p ON p.id=pc.post_id " +
      "WHERE pc.column_id=?1 AND p.status=1 ORDER BY p.created_at DESC, p.id DESC"
    ).bind(col.id).all();
    const out = { ok: true, data: (arts.results || []).map(a => ({ title: a.title, source_file: a.source_file })) };
    // 上/下篇限定在该专栏内（与详情页 ?col= 直出时的口径完全一致）
    if (cur) {
      const p = await db.prepare("SELECT created_at FROM posts WHERE source_file=?1").bind(cur).first();
      if (p) {
        const inCol = " AND id IN (SELECT post_id FROM post_columns WHERE column_id=" + Number(col.id) + ")";
        const prev = await db.prepare(
          "SELECT title, source_file FROM posts WHERE status=1 AND created_at > ?1" + inCol + " ORDER BY created_at ASC LIMIT 1"
        ).bind(p.created_at).first();
        const next = await db.prepare(
          "SELECT title, source_file FROM posts WHERE status=1 AND created_at < ?1" + inCol + " ORDER BY created_at DESC LIMIT 1"
        ).bind(p.created_at).first();
        out.prev = prev || null;
        out.next = next || null;
      }
    }
    return json(out);
  } catch (e) {
    return json({ ok: true, data: [] });
  }
}

async function handlePublicTags(env) {
  try {
    const rows = await env.DB.prepare(
      "SELECT t.name, t.color, COUNT(pt.post_id) AS cnt FROM tags t LEFT JOIN post_tags pt ON pt.tag_id=t.id GROUP BY t.id ORDER BY cnt DESC, t.id"
    ).all();
    return json({ ok: true, data: rows.results || [] });
  } catch (e) {
    const payload = await fetchStaticJson(env, "/api/public/tags.json").catch(() => null);
    return json(payload || { ok: true, data: [] });
  }
}

/* 前台公开接口：工具开关 / 关于我 / 装修布局 —— D1 优先，空则回退 raw 静态 JSON */
async function handlePublicTools(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key='tools'").first();
    if (row) {
      const tools = JSON.parse(row.value);
      const enabled = (Array.isArray(tools) ? tools : []).filter((t) => t && t.enabled !== false);
      return json({ ok: true, data: enabled });
    }
  } catch (e) { /* settings 表未建，回退 raw */ }
  // 回退 raw 静态 tools.json
  try {
    const payload = await fetchStaticJson(env, "/api/tools.json");
    return json(payload || { ok: true, data: [] });
  } catch (e) {
    return json({ ok: true, data: [] });
  }
}

async function handlePublicAbout(env) {
  try {
    const row = await env.DB.prepare("SELECT content, created_at FROM about_versions ORDER BY id DESC LIMIT 1").first();
    if (row) return json({ ok: true, data: { content: row.content, created_at: row.created_at } });
  } catch (e) { /* about_versions 表未建，回退 raw */ }
  try {
    const payload = await fetchStaticJson(env, "/api/about.json");
    return json(payload || { ok: true, data: { content: "", created_at: "" } });
  } catch (e) {
    return json({ ok: true, data: { content: "", created_at: "" } });
  }
}

async function handlePublicLayout(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key='layout'").first();
    if (row) {
      return json({ ok: true, data: JSON.parse(row.value) });
    }
  } catch (e) { /* settings 表未建，回退 raw */ }
  try {
    const payload = await fetchStaticJson(env, "/api/layout.json");
    return json(payload || { ok: true, data: { custom: false, pages: {} } });
  } catch (e) {
    return json({ ok: true, data: { custom: false, pages: {} } });
  }
}

/* 读 raw 静态 JSON（供公开接口兜底） */
async function fetchStaticJson(env, path) {
  const rawBase = String(env.RAW_API_BASE || "").trim().replace(/\/+$/, "");
  if (!rawBase) return null;
  const rel = path.replace(/^\/api\//, "").replace(/^\//, "");
  const resp = await fetch(rawBase + "/" + rel, { headers: { "user-agent": "qingyi-blog-worker" } });
  if (!resp.ok) return null;
  const text = await resp.text();
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function handleView(request, env) {
  if (request.method === "OPTIONS") return json({ ok: true });
  const body = await readBody(request);
  if (body === null) return json({ ok: false, msg: "请求体非法" }, 400);
  const key = normSourceFile(body.source_file || body.file || body.id);
  if (!key) return json({ ok: false, msg: "缺少文章标识" }, 400);

  const db = env.DB;
  if (!db) return json({ ok: false, msg: "数据库未绑定（env.DB 为空）" }, 500);
  await db.prepare(
    "INSERT INTO views (source_file, count) VALUES (?1, 1) " +
    "ON CONFLICT(source_file) DO UPDATE SET count = count + 1"
  ).bind(key).run();
  // 同步更新 posts 表阅读量（文章真源在 D1）
  try {
    await db.prepare("UPDATE posts SET views = views + 1 WHERE source_file = ?1").bind(key).run();
  } catch (e) {}
  const row = await db.prepare("SELECT count FROM views WHERE source_file = ?1").bind(key).first();

  return json({ ok: true, data: { source_file: key, views: row ? row.count : 1 } });
}

/* ------------------------------------------------------------------ */
/* 评论系统（对齐前端 /api/pinlun/* 契约）                              */
/* ------------------------------------------------------------------ */

function commentToItem(row, myVote) {
  const ms = Number(row.created_at) || nowMs();
  return {
    id: row.id,
    rootId: row.root_id || 0,
    parentId: row.parent_id || 0,
    content: row.content || "",
    user: {
      name: row.author || "匿名用户",
      avatar: row.avatar || "",
      email: row.email || "",
      self: false,
      role: row.role || "user",
    },
    time: fmtTime(ms),
    createTime: ms,
    createdAt: ms,
    zan: row.zan || 0,
    cai: row.cai || 0,
    myVote: myVote || 0,
    // FR-X22：评论增强字段（置顶/作者标识/编辑时间）——前端可选使用，老前端忽略无副作用
    isPinned: row.is_pinned ? 1 : 0,
    isAuthor: row.is_author ? 1 : 0,
    editedAt: row.edited_at || 0,
  };
}

async function myVoteOf(env, commentId, key) {
  const row = await env.DB.prepare(
    "SELECT type FROM votes WHERE comment_id = ?1 AND client_key = ?2"
  ).bind(commentId, key).first();
  return row ? row.type : 0;
}

async function handlePinlun(request, env, ctx) {
  if (request.method === "OPTIONS") return json({ ok: true });
  const url = new URL(request.url);
  const action = url.pathname
    .replace(/^\/api-v1\/pinlun\/?/, "")
    .replace(/^\/api\/pinlun\/?/, "")
    .replace(/\/$/, "") || "list";
  const body = (await readBody(request)) || {};
  const db = env.DB;
  if (!db) {
    return json({ success: false, msg: "数据库未绑定（env.DB 为空），请在 Worker 的 D1 Bindings 里绑定变量名 DB" }, 500);
  }
  const key = clientKey(request);

  switch (action) {
    case "list": {
      // 前端真实契约：{ id, pageIndex, q }（q = 评论搜索关键词，可为空）
      const pageId = String(body.id || body.pageId || "site").slice(0, 120);
      const pageIndex = Math.max(1, parseInt(body.pageIndex || 1, 10) || 1);
      const pageSize = 20;
      const q = String(body.q || "").trim().slice(0, 100);
      const offset = (pageIndex - 1) * pageSize;
      // 统一 4 个绑定参数：q 为空时 LIKE '%%' 恒真，天然兼容两种情况，无需拼两套 SQL
      const like = "%" + q + "%";
      const where = "page_id = ?1 AND root_id = 0 AND status = 1 AND content LIKE ?4";
      const totalRow = await db.prepare(
        "SELECT COUNT(*) AS c FROM comments WHERE " + where
      ).bind(pageId, pageSize, offset, like).first();
      const total = totalRow ? totalRow.c : 0;
      const rows = await db.prepare(
        "SELECT * FROM comments WHERE " + where +
        " ORDER BY id DESC LIMIT ?2 OFFSET ?3"
      ).bind(pageId, pageSize, offset, like).all();
      // FR-X22：评论增强（Gravatar 头像兜底 + 作者标识/置顶标记）——在 commentToItem 之前对原始行做增强
      const enriched = await enhanceComments(env, rows.results || [], null);
      const list = [];
      for (const r of enriched) {
        list.push(commentToItem(r, await myVoteOf(env, r.id, key)));
      }
      return json({ success: true, data: { list, total, pageIndex } });
    }

    case "replies": {
      // 前端真实契约：{ rootId, pageIndex }
      const rootId = parseInt(body.rootId || 0, 10) || 0;
      const rows = await db.prepare(
        "SELECT * FROM comments WHERE root_id = ?1 AND status = 1 ORDER BY id ASC"
      ).bind(rootId).all();
      const list = [];
      for (const r of rows.results || []) {
        list.push(commentToItem(r, await myVoteOf(env, r.id, key)));
      }
      return json({ success: true, data: { list, total: list.length, pageIndex: 1 } });
    }

    case "publish": {
      // 前端真实契约：{ id, text, rootId?, replyToName? }（内容字段是 text，不是 content！）
      const pageId = String(body.id || "site").slice(0, 120);
      const content = String(body.text || body.content || "").trim().slice(0, 600);
      if (!content) return json({ success: false, msg: "评论内容不能为空" });
      const rootId = parseInt(body.rootId || 0, 10) || 0;
      const replyToName = String(body.replyToName || "").trim().slice(0, 40);
      // 登录用户：从 X-Token / 本地 token 识别（简化：header 或 body 带用户名即署名，否则匿名）
      const author = String(body.author || body.name || "").trim().slice(0, 40) || "匿名用户";
      const ts = nowMs();

      // NFR-X2：评论发布限流（默认 1 分钟 5 次 / 客户端指纹）
      const rlPub = await checkRateLimit(env, { name: "comment", key: "comment:" + key });
      if (!rlPub.allowed) return rateLimitResponse(rlPub);

      // 《追加补充.md》FR-X20 风控：黑名单命中直接拒绝；敏感词命中或开启「先审后发」则入库为待审（status=0）
      let risk = { blocked: false, needAudit: false, reason: "" };
      try {
        risk = await checkCommentRisk(env, {
          content, clientKey: key, ipHash: "", ua: request.headers.get("user-agent") || "", email: "", pageId,
        });
      } catch (e) { /* 风控异常不阻断发布，按正常流程走 */ }
      if (risk && risk.blocked) {
        return json({ success: false, msg: risk.reason || "评论包含被禁止的内容" });
      }
      const newStatus = risk && risk.needAudit ? 0 : 1;
      // FR-X19：补写 post_id（评论的 page_id 就是文章 source_file），否则后台审核/举报无法关联到文章
      let postId = 0;
      try {
        const pr = await db.prepare("SELECT id FROM posts WHERE source_file = ?1").bind(pageId).first();
        postId = pr ? pr.id : 0;
      } catch (e) { postId = 0; }

      const info = await db.prepare(
        "INSERT INTO comments (post_id, page_id, root_id, parent_id, content, author, email, status, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
      ).bind(postId, pageId, rootId, rootId, content, author, "", newStatus, ts).run();

      const item = commentToItem(
        { id: info.meta.last_row_id, root_id: rootId, parent_id: rootId, content, author, email: "", status: newStatus, created_at: ts, zan: 0, cai: 0 },
        0
      );
      const okMsg = newStatus === 0
        ? "已提交，待站长审核后展示"
        : (rootId ? "回复已发表" : "已发表，站长确认后会展示");
      // FR-X21：站内信 + Webhook 通知（best-effort，不阻塞响应；表未建时模块内部静默降级）
      void notifyEvent(env, ctx, rootId ? "comment.reply" : "comment.new", {
        id: info.meta.last_row_id, pageId: pageId, postId: postId, author: author,
        content: String(content).slice(0, 300), status: newStatus, link: "/article/" + pageId,
      });
      return json({ success: true, data: { item }, msg: okMsg });
    }

    case "vote": {
      const cid = parseInt(body.id || 0, 10) || 0;
      const type = body.type === "cai" ? -1 : 1;
      const existing = await db.prepare(
        "SELECT type FROM votes WHERE comment_id = ?1 AND client_key = ?2"
      ).bind(cid, key).first();

      if (existing) {
        if (existing.type === type) {
          await db.prepare("DELETE FROM votes WHERE comment_id = ?1 AND client_key = ?2").bind(cid, key).run();
        } else {
          await db.prepare("UPDATE votes SET type = ?1 WHERE comment_id = ?2 AND client_key = ?3").bind(type, cid, key).run();
        }
      } else {
        await db.prepare("INSERT INTO votes (comment_id, client_key, type) VALUES (?1, ?2, ?3)").bind(cid, key, type).run();
      }

      const row = await db.prepare(
        "SELECT COALESCE(SUM(CASE WHEN type=1 THEN 1 ELSE 0 END),0) AS zan, " +
        "COALESCE(SUM(CASE WHEN type=-1 THEN 1 ELSE 0 END),0) AS cai FROM votes WHERE comment_id = ?1"
      ).bind(cid).first();
      const zan = row ? row.zan : 0;
      const cai = row ? row.cai : 0;
      const my = await myVoteOf(env, cid, key);
      await db.prepare("UPDATE comments SET zan = ?1, cai = ?2 WHERE id = ?3").bind(zan, cai, cid).run();
      return json({ success: true, data: { zan, cai, myVote: my } });
    }

    case "del": {
      const cid = parseInt(body.id || 0, 10) || 0;
      await db.prepare("UPDATE comments SET status = 0 WHERE id = ?1").bind(cid).run();
      return json({ success: true, msg: "已删除" });
    }

    default:
      return json({ success: false, msg: "未知操作：" + action }, 404);
  }
}

/** 兼容旧静态接口：返回评论总数（可选，前端未强依赖） */
async function handleCommentsJson(request, env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM comments WHERE status = 1").first();
  return json({ ok: true, data: [], total: row ? row.c : 0 });
}

/* ================================================================== */
/* 管理后台（admin/index.html + admin/web/ 复用，X-Token 鉴权）          */
/* ================================================================== */

async function adminAuth(request, env) {
  const token = (request.headers.get("X-Token") || "").slice(0, 80);
  if (!token) return { user: null, err: "未登录或会话已过期", code: 401 };
  const row = await env.DB.prepare(
    "SELECT u.id, u.username, u.nickname, u.email, u.role, u.status FROM sessions s JOIN users u ON u.id = s.user_id " +
    "WHERE s.token = ?1 AND s.expire_at > ?2"
  ).bind(token, nowMs()).first();
  if (!row) return { user: null, err: "会话已过期", code: 401 };
  if (row.status !== 1) return { user: null, err: "账号已被禁用", code: 403 };
  return { user: row, err: null, code: 0 };
}

/* ---- AI 摘要：调用自建模型服务器（Ollama OpenAI 兼容接口），无需第三方账号/API key ---- */
async function handleAiSummary(request, env, me) {
  if (request.method === "OPTIONS") return json({ ok: true });
  if (request.method !== "POST") return json({ ok: false, msg: "方法不支持" }, 405);
  const endpoint = String((env && env.AI_ENDPOINT) || "").trim().replace(/\/+$/, "");
  if (!endpoint) {
    return json({ ok: false, msg: "未配置 AI_ENDPOINT：请在 wrangler 环境变量里设置自建模型服务地址（如 http://你的服务器:11434）" }, 501);
  }
  const body = (await readBody(request)) || {};
  const content = String(body.content || "").trim();
  if (!content) return json({ ok: false, msg: "缺少正文 content" }, 400);
  // 截断到合理长度，避免超长正文打爆模型上下文
  const snippet = content.slice(0, 6000);
  const model = String((env && env.AI_MODEL) || "qwen2.5:7b").trim();

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000); // 60s 超时
    let resp;
    try {
      // 优先 OpenAI 兼容端点（Ollama >= 0.1.x 支持 /v1/chat/completions）
      resp = await fetch(endpoint + "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          temperature: 0.3,
          max_tokens: 200,
          messages: [
            { role: "system", content: "你是文章摘要助手。用 2-3 句话概括文章核心内容，直接输出摘要正文，不要任何前缀、解释或 Markdown 标记，控制在 150 字以内。" },
            { role: "user", content: "请为以下文章生成摘要：\n\n" + snippet },
          ],
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return json({ ok: false, msg: "AI 服务返回错误 " + resp.status + (t ? "：" + t.slice(0, 200) : "") }, 502);
    }
    const j = await resp.json();
    // OpenAI 兼容格式：choices[0].message.content
    let summary = "";
    try {
      summary = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    } catch (e) {}
    // 兜底：Ollama 原生 /api/generate 格式 response 字段
    if (!summary && j && j.response) summary = j.response;
    if (!summary) return json({ ok: false, msg: "AI 返回内容解析失败" }, 502);
    summary = String(summary).replace(/^\s+|\s+$/g, "");
    return json({ ok: true, data: { summary } }, 200);
  } catch (e) {
    return json({ ok: false, msg: "调用 AI 服务失败：" + String(e && e.name === "AbortError" ? "超时" : (e.message || e)) }, 502);
  }
}

async function handleAdmin(request, env, path) {
  if (request.method === "OPTIONS") return json({ ok: true });
  const db = env.DB;
  if (!db) return json({ ok: false, msg: "数据库未绑定" }, 500);
  const body = (await readBody(request)) || {};

  // 登录/注册无需鉴权
  if (path === "/api/login") return adminLogin(request, env, body);
  if (path === "/api/register") return handleRegister(request, env);
  if (path === "/api/me") return handleMe(request, env);
  if (path === "/api/logout") return handleLogout(request, env);

  // 上传文件读取（公开：供文章正文 <img src> 引用，无需鉴权）
  if (path.startsWith("/api/uploads/") && request.method === "GET") {
    return serveUpload(db, path);
  }

  // 其余均需鉴权
  const { user, err, code } = await adminAuth(request, env);
  if (err) return json({ ok: false, msg: err }, code);
  const me = user;
  const isAdmin = me.role === "super_admin" || me.role === "admin";
  const isSuper = me.role === "super_admin";

  // ---- AI 摘要：调用自建模型服务（需登录，admin 及以上）----
  if (path === "/api/admin/ai-summary") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    return handleAiSummary(request, env, me);
  }

  // ---- 《追加补充.md》FR-X19/FR-X20 后台扩展接口：评论批量审核 / 举报处理 / 评论配置 / 黑名单 ----
  if (path === "/api/admin/comments/bulk") return handleAdminCommentsBulk(request, env, me);
  if (path === "/api/admin/comments/report") return handleAdminReports(request, env, me);
  if (path === "/api/admin/settings/comment") return handleAdminCommentSettings(request, env, me);
  if (path === "/api/admin/comment-blacklist") return handleAdminBlacklist(request, env, me);

  // ---- 《追加补充.md》NFR-X2/NFR-X3：安全与可观测后台（模块内再校验 super_admin）----
  if (path === "/api/admin/audit-logs") return handleAdminAuditLogs(request, env, me);
  if (path === "/api/admin/rate-limits") return handleAdminRateLimits(request, env, me);
  if (path === "/api/admin/auth/tokens") return handleAdminResetTokens(request, env, me);
  if (path === "/api/admin/stats" || path === "/api-v1/admin/stats") {
    await lazyAggregateStats(env, path);
    return handleAdminStats(request, env, me);
  }
  if (path === "/api/admin/subscribers") return handleAdminSubscribers(request, env, me);
  if (path === "/api/admin/notifications") return handleAdminNotifications(request, env, me);
  if (path === "/api/admin/webhooks") return handleAdminWebhooks(request, env, me);
  if (path === "/api/admin/users-ext") return handleAdminUsersExt(request, env, me);
  if (path === "/api/admin/revisions") return handleAdminRevisions(request, env, me);
  if (path === "/api/admin/export") return handleAdminExport(request, env, me);
  if (path === "/api/admin/import") return handleAdminImport(request, env, me);
  if (path === "/api/admin/redirects") return handleAdminRedirects(request, env, me);
  // FR-X9：定时发布的「设置侧」（到期由 dashboard 里的 applyScheduledPosts 转正）
  if (path === "/api/posts/schedule" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const at = Number(body.publish_at || body.publishAt || 0) || 0;   // 毫秒；0 = 取消定时并转为草稿
    const r = await schedulePost(env, parseInt(body.id || 0, 10) || 0, at);
    return json(r && r.ok
      ? { ok: true, msg: at > 0 ? "已设置定时发布" : "已取消定时" }
      : { ok: false, msg: (r && r.msg) || "设置失败，请确认扩展列已部署" });
  }

  // NFR-X2：上传限流（按用户维度，默认 1 小时 20 次；/api/uploads/ 公开读图不限流）
  if (path === "/api/upload" && request.method === "POST") {
    const rl = await checkRateLimit(env, { name: "upload", key: "upload:u" + me.id });
    if (!rl.allowed) return rateLimitResponse(rl);
  }

  // ---- dashboard ----
  if (path === "/api/dashboard") {
    // FR-X9：进后台顺手发布到期的定时文章（无 Cron 的替代方案，失败不影响看板）
    try { await applyScheduledPosts(env); } catch (e) { /* 忽略 */ }
    // 首次进入后台时自动 seed：文章真源迁 D1，若 posts 表为空则从 raw 静态源导入一次
    const seedResult = await seedPostsIfEmpty(db, env);
    // 自动补抓/清洗正文：content 是占位符或混入旧评论组件的文章，从 raw 重新拉取（每次最多 10 篇）
    const contentResult = await backfillPostContent(db, env, 10);
    const q = (sql, ...p) => db.prepare(sql).bind(...p).first();
    const n_users = (await q("SELECT COUNT(*) AS c FROM users")).c;
    const n_posts = (await q("SELECT COUNT(*) AS c FROM posts")).c;
    const n_pending = (await q("SELECT COUNT(*) AS c FROM posts WHERE status=0")).c;
    const n_cats = (await q("SELECT COUNT(*) AS c FROM categories")).c;
    const n_comments = (await q("SELECT COUNT(*) AS c FROM comments")).c;
    const n_cmts_pending = (await q("SELECT COUNT(*) AS c FROM comments WHERE status=0")).c;
    const recent = await db.prepare("SELECT id,title,status,is_top,views,created_at FROM posts ORDER BY created_at DESC, id DESC LIMIT 8").all();
    return json({ ok: true, data: {
      users: n_users, posts: n_posts, pending_posts: n_pending,
      categories: n_cats, comments: n_comments, pending_comments: n_cmts_pending,
      recent_posts: recent.results || [], role: me.role, role_name: roleName(me.role),
      seed: seedResult, content_backfill: contentResult,
    }});
  }

  // ---- 文章 ----
  if (path === "/api/posts" && request.method === "GET") {
    // FR-X9：列文章时也顺手发布「到期的定时文章」——原先只在 /api/dashboard 触发，
    // 站长若一直不开仪表盘，到期文章会一直停在草稿（失败不影响列表返回）。
    try { await applyScheduledPosts(env); } catch (e) { /* 忽略 */ }
    const rows = await db.prepare(
      "SELECT p.id,p.title,p.category_id,p.summary,p.content,p.status,p.is_top,p.views,p.created_at,p.updated_at,p.source_file,c.name AS category " +
      "FROM posts p LEFT JOIN categories c ON p.category_id=c.id ORDER BY p.is_top DESC, p.created_at DESC, p.id DESC").all();
    // 一次性聚合所有 tags/columns，避免逐篇子查询
    const allTags = await db.prepare(
      "SELECT pt.post_id, t.name FROM post_tags pt JOIN tags t ON t.id=pt.tag_id ORDER BY t.id").all();
    const allCols = await db.prepare(
      "SELECT pc.post_id, c.name FROM post_columns pc JOIN columns c ON c.id=pc.column_id ORDER BY c.id").all();
    const tagMap = new Map();
    for (const r of allTags.results || []) {
      if (!tagMap.has(r.post_id)) tagMap.set(r.post_id, []);
      tagMap.get(r.post_id).push(r.name);
    }
    const colMap = new Map();
    for (const r of allCols.results || []) {
      if (!colMap.has(r.post_id)) colMap.set(r.post_id, []);
      colMap.get(r.post_id).push(r.name);
    }
    const result = (rows.results || []).map((r) => ({
      ...r,
      tags: tagMap.get(r.id) || [],
      columns: colMap.get(r.id) || [],
    }));
    return json({ ok: true, data: result });
  }
  if (path === "/api/posts/create" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const title = String(body.title || "").trim().slice(0, 200);
    if (!title) return json({ ok: false, msg: "请输入标题" });
    const summary = String(body.summary || "").slice(0, 500);
    const content = String(body.content || "");
    const cover = String(body.cover_image || "").slice(0, 500);
    const ts = nowStr();
    // 自动生成 source_file（a_ + 随机 hex + .html），供详情页路由与列表链接使用
    const sourceFile = body.source_file || ("a_" + hexEncode(crypto.getRandomValues(new Uint8Array(12))) + ".html");
    const info = await db.prepare(
      "INSERT INTO posts (title,category_id,summary,content,status,is_top,views,source_file,cover_image,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,0,?7,?8,?9,?9)"
    ).bind(title, body.category_id || null, summary, content, body.status ? 1 : 0, body.is_top ? 1 : 0, sourceFile, cover, ts).run();
    const pid = info.meta.last_row_id;
    await setPostLinks(db, pid, body.tags, body.columns);
    return json({ ok: true, msg: "文章《" + title + "》已创建", id: pid, source_file: sourceFile });
  }
  if (path === "/api/posts/update" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const pid = parseInt(body.id || 0, 10) || 0;
    const title = String(body.title || "").trim().slice(0, 200);
    if (!title) return json({ ok: false, msg: "请输入标题" });
    // FR-X9：更新前先存一份历史快照（每篇保留最近 20 版；快照失败不影响更新）
    await snapshotRevision(env, pid, me.id, String(body.note || "手动保存").slice(0, 200));
    await db.prepare(
      "UPDATE posts SET title=?,category_id=?,summary=?,content=?,status=?,is_top=?,cover_image=?,updated_at=? WHERE id=?"
    ).bind(title, body.category_id || null, String(body.summary || "").slice(0, 500), String(body.content || ""), body.status ? 1 : 0, body.is_top ? 1 : 0, String(body.cover_image || "").slice(0, 500), nowStr(), pid).run();
    await setPostLinks(db, pid, body.tags, body.columns);
    return json({ ok: true, msg: "文章已更新" });
  }
  if (path === "/api/posts/delete" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const pid = parseInt(body.id || 0, 10) || 0;
    await db.prepare("DELETE FROM posts WHERE id=?").bind(pid).run();
    await db.prepare("DELETE FROM post_tags WHERE post_id=?").bind(pid).run();
    await db.prepare("DELETE FROM post_columns WHERE post_id=?").bind(pid).run();
    return json({ ok: true, msg: "文章已删除" });
  }

  // ---- 分类 ----
  if (path === "/api/categories" && request.method === "GET") {
    const rows = await db.prepare(
      "SELECT c.id,c.name,c.sort,(SELECT COUNT(*) FROM posts p WHERE p.category_id=c.id) AS cnt FROM categories c ORDER BY c.sort, c.id").all();
    return json({ ok: true, data: rows.results || [] });
  }
  if (path === "/api/categories/create" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const name = String(body.name || "").trim().slice(0, 30);
    if (!name) return json({ ok: false, msg: "请输入分类名称" });
    const ex = await db.prepare("SELECT id FROM categories WHERE name=?").bind(name).first();
    if (ex) return json({ ok: false, msg: "分类已存在" });
    await db.prepare("INSERT INTO categories (name,sort) VALUES (?,?)").bind(name, parseInt(body.sort || 0, 10) || 0).run();
    return json({ ok: true, msg: "分类已创建" });
  }
  if (path === "/api/categories/update" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const cid = parseInt(body.id || 0, 10) || 0;
    const name = String(body.name || "").trim().slice(0, 30);
    if (!name) return json({ ok: false, msg: "请输入分类名称" });
    await db.prepare("UPDATE categories SET name=?,sort=? WHERE id=?").bind(name, parseInt(body.sort || 0, 10) || 0, cid).run();
    return json({ ok: true, msg: "分类已更新" });
  }
  if (path === "/api/categories/delete" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const cid = parseInt(body.id || 0, 10) || 0;
    await db.prepare("UPDATE posts SET category_id=NULL WHERE category_id=?").bind(cid).run();
    await db.prepare("DELETE FROM categories WHERE id=?").bind(cid).run();
    return json({ ok: true, msg: "分类已删除" });
  }

  // ---- 标签 ----
  if (path === "/api/tags" && request.method === "GET") {
    const rows = await db.prepare(
      "SELECT t.id,t.name,t.color,COUNT(pt.post_id) AS cnt FROM tags t LEFT JOIN post_tags pt ON pt.tag_id=t.id GROUP BY t.id ORDER BY cnt DESC, t.id").all();
    return json({ ok: true, data: rows.results || [] });
  }
  if (path === "/api/tags/create" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const name = String(body.name || "").trim().replace(/^#/, "").slice(0, 30);
    if (!name) return json({ ok: false, msg: "请输入标签名称" });
    const color = /^#[0-9a-fA-F]{6}$/.test(body.color || "") ? body.color : "#58a6ff";
    const ex = await db.prepare("SELECT id FROM tags WHERE name=?").bind(name).first();
    if (ex) return json({ ok: false, msg: "标签已存在" });
    await db.prepare("INSERT INTO tags (name,color) VALUES (?,?)").bind(name, color).run();
    return json({ ok: true, msg: "标签已创建" });
  }
  if (path === "/api/tags/update" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const tid = parseInt(body.id || 0, 10) || 0;
    const name = String(body.name || "").trim().replace(/^#/, "").slice(0, 30);
    const color = /^#[0-9a-fA-F]{6}$/.test(body.color || "") ? body.color : "#58a6ff";
    await db.prepare("UPDATE tags SET name=?,color=? WHERE id=?").bind(name, color, tid).run();
    return json({ ok: true, msg: "标签已更新" });
  }
  if (path === "/api/tags/delete" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const tid = parseInt(body.id || 0, 10) || 0;
    await db.prepare("DELETE FROM post_tags WHERE tag_id=?").bind(tid).run();
    await db.prepare("DELETE FROM tags WHERE id=?").bind(tid).run();
    return json({ ok: true, msg: "标签已删除" });
  }

  // ---- 分栏 ----
  if (path === "/api/columns" && request.method === "GET") {
    const rows = await db.prepare(
      "SELECT c.id,c.name,c.sort,COUNT(pc.post_id) AS cnt FROM columns c LEFT JOIN post_columns pc ON pc.column_id=c.id GROUP BY c.id ORDER BY c.sort, c.id").all();
    return json({ ok: true, data: rows.results || [] });
  }
  if (path === "/api/columns/create" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const name = String(body.name || "").trim().slice(0, 30);
    if (!name) return json({ ok: false, msg: "请输入分栏名称" });
    const ex = await db.prepare("SELECT id FROM columns WHERE name=?").bind(name).first();
    if (ex) return json({ ok: false, msg: "分栏已存在" });
    await db.prepare("INSERT INTO columns (name,sort) VALUES (?,?)").bind(name, parseInt(body.sort || 0, 10) || 0).run();
    return json({ ok: true, msg: "分栏已创建" });
  }
  if (path === "/api/columns/update" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const cid = parseInt(body.id || 0, 10) || 0;
    const name = String(body.name || "").trim().slice(0, 30);
    if (!name) return json({ ok: false, msg: "请输入分栏名称" });
    await db.prepare("UPDATE columns SET name=?,sort=? WHERE id=?").bind(name, parseInt(body.sort || 0, 10) || 0, cid).run();
    return json({ ok: true, msg: "分栏已更新" });
  }
  if (path === "/api/columns/delete" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const cid = parseInt(body.id || 0, 10) || 0;
    await db.prepare("DELETE FROM post_columns WHERE column_id=?").bind(cid).run();
    await db.prepare("DELETE FROM columns WHERE id=?").bind(cid).run();
    return json({ ok: true, msg: "分栏已删除" });
  }

  // ---- 评论 ----
  if (path === "/api/comments" && request.method === "GET") {
    const rows = await db.prepare(
      "SELECT m.id,m.post_id,m.author,m.email,m.content,m.status,m.created_at,p.title AS post_title " +
      "FROM comments m LEFT JOIN posts p ON m.post_id=p.id ORDER BY m.id DESC").all();
    return json({ ok: true, data: rows.results || [] });
  }
  if (path === "/api/comments/update" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const cid = parseInt(body.id || 0, 10) || 0;
    await db.prepare("UPDATE comments SET status=? WHERE id=?").bind(body.status ? 1 : 0, cid).run();
    return json({ ok: true, msg: "评论状态已更新" });
  }
  if (path === "/api/comments/delete" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const cid = parseInt(body.id || 0, 10) || 0;
    await db.prepare("DELETE FROM comments WHERE id=?").bind(cid).run();
    return json({ ok: true, msg: "评论已删除" });
  }

  // ---- 用户 ----
  if (path === "/api/users" && request.method === "GET") {
    if (!isSuper) return json({ ok: false, msg: "仅超级管理员可查看用户列表" }, 403);
    const rows = await db.prepare("SELECT id,username,role,nickname,email,status,created_at FROM users ORDER BY id").all();
    // created_at 是毫秒时间戳，转成可读日期字符串（admin 界面直接显示）
    const data = (rows.results || []).map((u) => ({ ...u, created_at: fmtTime(Number(u.created_at) || nowMs()) }));
    return json({ ok: true, data });
  }
  if (path === "/api/users/create" && request.method === "POST") {
    if (!isSuper) return json({ ok: false, msg: "仅超级管理员可管理用户" }, 403);
    const username = String(body.username || "").trim().slice(0, 32);
    const password = String(body.password || "");
    const role = body.role || "user";
    if (!/^[A-Za-z0-9_\-\.]{3,32}$/.test(username)) return json({ ok: false, msg: "用户名需为 3-32 位字母、数字、下划线" });
    if (password.length < 6) return json({ ok: false, msg: "密码至少 6 位" });
    if (!["super_admin", "admin", "user"].includes(role)) return json({ ok: false, msg: "角色不合法" });
    const ex = await db.prepare("SELECT id FROM users WHERE username=?").bind(username).first();
    if (ex) return json({ ok: false, msg: "用户名已存在" });
    const salt = hexEncode(crypto.getRandomValues(new Uint8Array(8)));
    const hash = await hashPassword(password, salt);
    await db.prepare(
      "INSERT INTO users (username,nickname,email,pass_salt,pass_hash,role,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,1,?7)"
    ).bind(username, String(body.nickname || "").slice(0, 30), String(body.email || "").slice(0, 80), salt, hash, role, nowMs()).run();
    return json({ ok: true, msg: "用户 " + username + " 创建成功" });
  }
  if (path === "/api/users/update" && request.method === "POST") {
    if (!isSuper) return json({ ok: false, msg: "仅超级管理员可管理用户" }, 403);
    const uid = parseInt(body.id || 0, 10) || 0;
    const role = body.role || "";
    const status = body.status ? 1 : 0;
    const sets = ["nickname=?", "email=?", "status=?"];
    const params = [String(body.nickname || "").slice(0, 30), String(body.email || "").slice(0, 80), status];
    if (role && ["super_admin", "admin", "user"].includes(role)) { sets.push("role=?"); params.push(role); }
    params.push(uid);
    await db.prepare("UPDATE users SET " + sets.join(", ") + " WHERE id=?").bind(...params).run();
    return json({ ok: true, msg: "用户信息已更新" });
  }
  if (path === "/api/users/delete" && request.method === "POST") {
    if (!isSuper) return json({ ok: false, msg: "仅超级管理员可管理用户" }, 403);
    const uid = parseInt(body.id || 0, 10) || 0;
    if (uid === me.id) return json({ ok: false, msg: "不能删除当前登录账号" });
    await db.prepare("DELETE FROM users WHERE id=?").bind(uid).run();
    return json({ ok: true, msg: "用户已删除" });
  }
  if (path === "/api/users/resetpwd" && request.method === "POST") {
    if (!isSuper) return json({ ok: false, msg: "仅超级管理员可管理用户" }, 403);
    const uid = parseInt(body.id || 0, 10) || 0;
    const password = String(body.password || "");
    if (password.length < 6) return json({ ok: false, msg: "新密码至少 6 位" });
    const salt = hexEncode(crypto.getRandomValues(new Uint8Array(8)));
    const hash = await hashPassword(password, salt);
    await db.prepare("UPDATE users SET pass_salt=?,pass_hash=? WHERE id=?").bind(salt, hash, uid).run();
    return json({ ok: true, msg: "密码已重置" });
  }

  // ---- 设置：工具开关 ----
  if (path === "/api/settings/tools" && request.method === "GET") {
    const row = await db.prepare("SELECT value FROM settings WHERE key='tools'").first();
    let tools = [];
    try { tools = row ? JSON.parse(row.value) : []; } catch (e) { tools = []; }
    return json({ ok: true, data: tools });
  }
  if (path === "/api/settings/tools" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const tools = Array.isArray(body.tools) ? body.tools : [];
    await db.prepare("INSERT INTO settings (key,value) VALUES ('tools',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(JSON.stringify(tools)).run();
    return json({ ok: true, msg: "工具展示设置已保存" });
  }

  // ---- 设置：关于我 ----
  if (path === "/api/settings/about" && request.method === "GET") {
    const rows = await db.prepare("SELECT id,content,created_at FROM about_versions ORDER BY id DESC LIMIT 20").all();
    return json({ ok: true, data: rows.results || [] });
  }
  if (path === "/api/settings/about" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const content = String(body.content || "");
    if (!content.trim()) return json({ ok: false, msg: "内容不能为空" });
    const ts = nowStr();
    let final = content;
    if (!/^\s*<p class="about-stamp">/.test(content)) {
      final = '<p class="about-stamp">更新于 ' + ts + '</p>' + content;
    }
    await db.prepare("INSERT INTO about_versions (content,created_at) VALUES (?,?)").bind(final, ts).run();
    return json({ ok: true, msg: "已保存，并在顶部追加时间戳" });
  }

  // ---- 设置：页面装修 ----
  if (path === "/api/settings/layout" && request.method === "GET") {
    const row = await db.prepare("SELECT value FROM settings WHERE key='layout'").first();
    return json({ ok: true, data: row ? JSON.parse(row.value) : { custom: false, pages: {} } });
  }
  if (path === "/api/settings/layout" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    await db.prepare("INSERT INTO settings (key,value) VALUES ('layout',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(JSON.stringify(body.pages ? { custom: true, version: Date.now(), pages: body.pages } : { custom: true, pages: body })).run();
    return json({ ok: true, msg: "装修布局已保存" });
  }
  if (path === "/api/settings/layout/reset" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    await db.prepare("DELETE FROM settings WHERE key='layout'").run();
    return json({ ok: true, msg: "已恢复默认布局", data: { custom: false, pages: {} } });
  }

  // ---- 设置：个人资料 ----
  if (path === "/api/settings" && request.method === "POST") {
    const nickname = String(body.nickname || "").slice(0, 30);
    const email = String(body.email || "").slice(0, 80);
    const old_pwd = String(body.old_password || "");
    const new_pwd = String(body.new_password || "");
    const meRow = await db.prepare("SELECT * FROM users WHERE id=?").bind(me.id).first();
    if (!meRow) return json({ ok: false, msg: "账号不存在" });
    if (nickname || email) {
      await db.prepare("UPDATE users SET nickname=?,email=? WHERE id=?").bind(nickname, email, me.id).run();
    }
    if (old_pwd && new_pwd) {
      const h = await hashPassword(old_pwd, meRow.pass_salt);
      if (h !== meRow.pass_hash) return json({ ok: false, msg: "原密码错误" });
      if (new_pwd.length < 6) return json({ ok: false, msg: "新密码至少 6 位" });
      const salt = hexEncode(crypto.getRandomValues(new Uint8Array(8)));
      const hash = await hashPassword(new_pwd, salt);
      await db.prepare("UPDATE users SET pass_salt=?,pass_hash=? WHERE id=?").bind(salt, hash, me.id).run();
    }
    return json({ ok: true, msg: "个人资料已更新" });
  }

  // ---- 上传（base64 存 D1 uploads 表，替代本地磁盘/R2） ----
  if (path === "/api/upload" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    try {
      const fd = await request.formData();
      const file = fd.get("file");
      if (!file || typeof file === "string") return json({ ok: false, msg: "未收到文件" });
      const name = file.name || "upload.bin";
      const mime = file.type || "application/octet-stream";
      const ext = "." + (name.split(".").pop() || "bin").toLowerCase();
      const allowed = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".mp3", ".wav", ".ogg", ".m4a", ".aac", ".mid", ".midi", ".mp4", ".webm", ".mov"];
      if (!allowed.includes(ext)) return json({ ok: false, msg: "不支持的文件类型，仅允许图片/音频/视频" });
      const buf = await file.arrayBuffer();
      if (buf.byteLength > 3 * 1024 * 1024) return json({ ok: false, msg: "文件超过 3MB 限制（D1 单条上限）" }, 413);
      // base64 编码
      const bytes = new Uint8Array(buf);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const b64 = btoa(bin);
      const info = await db.prepare(
        "INSERT INTO uploads (filename, mime, size, data_b64, created_at) VALUES (?1,?2,?3,?4,?5)"
      ).bind(name, mime, buf.byteLength, b64, nowMs()).run();
      const id = info.meta.last_row_id;
      return json({ ok: true, data: { url: "/api/uploads/" + id, name } });
    } catch (e) {
      return json({ ok: false, msg: "上传失败：" + String(e && e.message || e) });
    }
  }

  // ---- 导入文章 ----
  if (path === "/api/import_posts" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    // 从静态 posts.json 导入到 D1 posts 表（文章真源迁移）
    let list = [];
    try {
      const payload = await fetchStaticPosts(env);
      list = (payload && payload.data && payload.data.list) || [];
    } catch (e) {
      return json({ ok: false, msg: "无法读取文章源：" + String(e.message || e) });
    }
    let imported = 0, updated = 0;
    for (const p of list) {
      const title = String(p.title || "").trim();
      if (!title) continue;
      const source_file = p.source_file || "";
      const summary = String(p.summary || "").slice(0, 500);
      const created_at = p.created_at || nowStr();
      const existing = await db.prepare("SELECT id FROM posts WHERE source_file=?").bind(source_file).first();
      if (existing) {
        // 同步 created_at：历史文章若此前被错误时间覆盖，重新导入即可刷回静态源里的真实发布时间
        await db.prepare("UPDATE posts SET title=?,summary=?,views=?,created_at=? WHERE id=?").bind(title, summary, p.views || 0, created_at, existing.id).run();
        updated++;
      } else {
        await db.prepare(
          "INSERT INTO posts (title,summary,content,status,is_top,views,source_file,created_at,updated_at) VALUES (?1,?2,?3,1,0,?4,?5,?6,?6)"
        ).bind(title, summary, "[" + source_file + "]", p.views || 0, source_file, created_at).run();
        imported++;
      }
    }
    return json({ ok: true, msg: "导入完成：新增 " + imported + " 篇，更新 " + updated + " 篇" });
  }

  // ---- 补抓正文（手动全量：把占位 content 替换为真实正文） ----
  if (path === "/api/posts/import_content" && request.method === "POST") {
    if (!isAdmin) return json({ ok: false, msg: "权限不足" }, 403);
    const result = await backfillPostContent(db, env, 0);
    return json({ ok: true, msg: "正文补抓结果：" + result });
  }

  return json({ ok: false, msg: "未知管理接口：" + path }, 404);
}

async function adminLogin(request, env, body) {
  const db = env.DB;
  await ensureSeedAdmin(db, env);
  const username = String(body.username || "").trim().slice(0, 32);
  const password = String(body.password || "");
  const user = await db.prepare("SELECT * FROM users WHERE username=? AND status=1").bind(username).first();
  if (!user) return json({ ok: false, msg: "用户名或密码错误" }, 401);
  const hash = await hashPassword(password, user.pass_salt);
  if (hash !== user.pass_hash) return json({ ok: false, msg: "用户名或密码错误" }, 401);
  const token = hexEncode(crypto.getRandomValues(new Uint8Array(24)));
  const now = nowMs();
  await db.prepare("INSERT INTO sessions (token,user_id,created_at,expire_at) VALUES (?1,?2,?3,?4)").bind(token, user.id, now, now + 8 * 3600 * 1000).run();
  // 同时 Set-Cookie（与 /api/user/login 口径一致），保证 localStorage 与 Cookie 两套登录态同步，
  // 避免评论/旧组件读 Cookie 而导航读 localStorage 时状态不一致。
  return json({ ok: true, token, user: {
    username: user.username, role: user.role, role_name: roleName(user.role), nickname: user.nickname, email: user.email,
  }}, 200, {
    "set-cookie": "session=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800",
  });
}

async function setPostLinks(db, pid, tags, columns) {
  await db.prepare("DELETE FROM post_tags WHERE post_id=?").bind(pid).run();
  await db.prepare("DELETE FROM post_columns WHERE post_id=?").bind(pid).run();
  for (const t of tags || []) {
    let tid = null;
    if (typeof t === "number") { tid = t; }
    else {
      const name = String(t).replace(/^#/, "").trim().slice(0, 30);
      if (!name) continue;
      let row = await db.prepare("SELECT id FROM tags WHERE name=?").bind(name).first();
      if (row) tid = row.id;
      else {
        const info = await db.prepare("INSERT INTO tags (name,color) VALUES (?,?)").bind(name, "#58a6ff").run();
        tid = info.meta.last_row_id;
      }
    }
    if (tid) await db.prepare("INSERT OR IGNORE INTO post_tags (post_id,tag_id) VALUES (?,?)").bind(pid, tid).run();
  }
  for (const c of columns || []) {
    const cid = parseInt(c, 10);
    if (!cid) continue;
    await db.prepare("INSERT OR IGNORE INTO post_columns (post_id,column_id) VALUES (?,?)").bind(pid, cid).run();
  }
}

function nowStr() {
  // Workers 运行时是 UTC，加 8 小时偏移输出北京时间（UTC+8），与 fmtTime 口径一致
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds());
}

/* 首次进入后台时自动 seed：posts 表为空则从 raw 静态源导入文章 + 标签 + 分栏 */
async function seedPostsIfEmpty(db, env) {
  try {
    const cnt = await db.prepare("SELECT COUNT(*) AS c FROM posts").first();
    if (cnt && cnt.c > 0) return "already";
  } catch (e) {
    return "table-missing";  // posts 表不存在，等待迁移执行
  }
  let list = [];
  try {
    const payload = await fetchStaticPosts(env);
    list = (payload && payload.data && payload.data.list) || [];
  } catch (e) {
    return "source-fail";
  }
  if (!list.length) return "empty-source";

  let imported = 0;
  for (const p of list) {
    const title = String(p.title || "").trim();
    if (!title) continue;
    const source_file = p.source_file || "";
    const summary = String(p.summary || "").slice(0, 500);
    const created_at = p.created_at || nowStr();
    // source_file 幂等：已存在则跳过
    if (source_file) {
      const ex = await db.prepare("SELECT id FROM posts WHERE source_file=?").bind(source_file).first();
      if (ex) continue;
    }
    // 从 raw 仓库拉取文章 HTML，提取正文（detail-content）作为可编辑内容
    let content = "";
    try {
      content = await fetchArticleContent(env, source_file);
    } catch (e) { content = ""; }
    if (!content) content = "<p>（正文待补充）</p>";
    const info = await db.prepare(
      "INSERT INTO posts (title,summary,content,status,is_top,views,source_file,created_at,updated_at) VALUES (?1,?2,?3,1,0,?4,?5,?6,?6)"
    ).bind(title, summary, content, p.views || 0, source_file, created_at).run();
    const pid = info.meta.last_row_id;
    // 标签
    for (const t of (p.tags || [])) {
      const name = String(t).replace(/^#/, "").trim().slice(0, 30);
      if (!name) continue;
      let row = await db.prepare("SELECT id FROM tags WHERE name=?").bind(name).first();
      let tid = row ? row.id : null;
      if (!tid) {
        const i2 = await db.prepare("INSERT INTO tags (name,color) VALUES (?,?)").bind(name, "#58a6ff").run();
        tid = i2.meta.last_row_id;
      }
      await db.prepare("INSERT OR IGNORE INTO post_tags (post_id,tag_id) VALUES (?,?)").bind(pid, tid).run();
    }
    // 分栏（columns 字段是名称数组）
    for (const cname of (p.columns || [])) {
      const name = String(cname).trim().slice(0, 30);
      if (!name) continue;
      let row = await db.prepare("SELECT id FROM columns WHERE name=?").bind(name).first();
      let cid = row ? row.id : null;
      if (!cid) {
        const i2 = await db.prepare("INSERT INTO columns (name,sort) VALUES (?,0)").bind(name).run();
        cid = i2.meta.last_row_id;
      }
      await db.prepare("INSERT OR IGNORE INTO post_columns (post_id,column_id) VALUES (?,?)").bind(pid, cid).run();
    }
    imported++;
  }
  return "imported:" + imported;
}

/* 从 raw 仓库拉取单篇文章 HTML，提取 detail-content 正文 */
async function fetchArticleContent(env, sourceFile) {
  if (!sourceFile) return "";
  const rawBase = String(env.RAW_ARTICLE_BASE || "").trim().replace(/\/+$/, "");
  if (!rawBase) return "";
  const resp = await fetch(rawBase + "/" + sourceFile, { headers: { "user-agent": "qingyi-blog-worker" } });
  if (!resp.ok) return "";
  const html = await resp.text();
  return extractDetailContent(html);
}

/* 从文章 HTML 提取 <div class="detail-content">...</div> 内的正文 */
function extractDetailContent(html) {
  if (!html) return "";
  const marker = 'class="detail-content"';
  const i = html.indexOf(marker);
  if (i < 0) return "";
  // 从 marker 后的第一个 ">" 开始（即 <div class="detail-content"...> 标签结束）
  let start = html.indexOf(">", i);
  if (start < 0) return "";
  start += 1;
  // 结束锚点：评论组件开始（旧 Vue 评论在正文之后、script 之前，必须排除）
  const endAnchor = '<div class="xw-pinlun2';
  let end = html.indexOf(endAnchor, start);
  if (end < 0) {
    // 兜底：到下一个 <script
    end = html.indexOf("<script", start);
    if (end < 0) end = html.length;
  }
  let seg = html.slice(start, end);
  // 去掉尾部闭合标签（detail-content 与外层的 </div></div>）
  seg = seg.replace(/(<\/div>\s*)+$/, "").replace(/<!--\]-->\s*(<\/div>\s*)+$/, "").trim();
  return seg;
}

/* 补抓/清洗正文：content 是占位符、为空、或混入了旧评论组件（xw-pinlun2）的文章，重新从 raw 拉取。
   limit 每次最多处理几篇（dashboard 自动触发用小值避免慢；手动触发传 0=全部） */
async function backfillPostContent(db, env, limit) {
  try {
    const rows = await db.prepare(
      "SELECT id, source_file FROM posts WHERE (content LIKE '[a_%' OR content = '' OR content IS NULL OR content LIKE '%xw-pinlun2%') AND source_file != ''"
    ).all();
    const pending = rows.results || [];
    if (!pending.length) return "all-done";
    const max = limit && limit > 0 ? Math.min(limit, pending.length) : pending.length;
    let done = 0;
    for (const p of pending.slice(0, max)) {
      try {
        const content = await fetchArticleContent(env, p.source_file);
        if (content) {
          await db.prepare("UPDATE posts SET content=? WHERE id=?").bind(content, p.id).run();
          done++;
        }
      } catch (e) { /* 单篇失败继续下一篇 */ }
    }
    return done + "/" + pending.length;
  } catch (e) {
    return "fail:" + String(e && e.message || e);
  }
}

/* 公开读取上传的文件（base64 存 D1） */
async function serveUpload(db, path) {
  const id = parseInt(path.replace("/api/uploads/", ""), 10) || 0;
  const row = await db.prepare("SELECT filename, mime, data_b64 FROM uploads WHERE id=?").bind(id).first();
  if (!row) return new Response("Not Found", { status: 404 });
  let bytes;
  try {
    const bin = atob(row.data_b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch (e) {
    return new Response("Decode error", { status: 500 });
  }
  return new Response(bytes, {
    headers: {
      "content-type": row.mime || "application/octet-stream",
      "cache-control": "public, max-age=31536000",
    },
  });
}
