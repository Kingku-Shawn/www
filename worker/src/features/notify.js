/* ==================================================================
 * 清逸的博客 · 订阅 / 邮件列表 / 站内信 / Webhook（worker/src/features/notify.js）
 * 自包含模块：零依赖、零 import、导入时零副作用
 * ------------------------------------------------------------------
 * 对应《追加补充.md》：
 *   · FR-X23 —— 订阅与 Newsletter（订阅 / 退订 / 后台订阅者管理 / CSV 导出）
 *   · FR-X21 —— 评论通知（站内信 + Webhook，骨架；Webhook 为完整实现）
 *   · D-X6   —— 通知先做 Webhook + 邮件，短信/微信等留待后续
 *
 * 硬约束：
 *   1) 不 import 任何模块（避免与 index.js 循环依赖），小工具全部内部自定义；
 *   2) 导入时零副作用：不查 D1、不发 fetch、不注册定时器；
 *   3) 所有 D1 / fetch / crypto 调用一律 try/catch：通知是 best-effort，永不抛；
 *   4) 只用标准 Web API（crypto.getRandomValues / crypto.subtle / fetch / AbortController
 *      / TextEncoder / Response / JSON），不用任何 Node 专有 API；
 *   5) 用户输入一律 bind 参数，绝不拼进 SQL 字符串（唯一动态片段是 DELETE 的表名白名单）。
 *
 * 依赖的既有表（worker/src/extend-schema.js；本模块不建表、不改表）：
 *   subscriptions         (id, email, token, status, source, created_at)      status 1 生效 / 0 退订
 *   newsletter_subscribers(id, email UNIQUE, status, tag, created_at)
 *   notifications         (id, user_id, type, title, body, link, read_at, created_at)  read_at 0=未读
 *   webhooks              (id, name, url, secret, events, status, fail_count, last_at, created_at)
 *   webhook_deliveries    (id, webhook_id, event, payload, status, status_code, response,
 *                          attempt, next_retry_at, duration_ms, created_at)
 *   audit_logs            (id, user_id, action, target, method, path, ip, ua, detail, created_at)
 *   users                 (id, username, role, status)   role IN ('super_admin','admin')
 *
 * 环境变量约定：
 *   MAIL_WEBHOOK_URL  可选。存在 → 把 {to, subject, text} POST 过去并视为“发信成功”；
 *                     不存在 → 骨架分支：接口照常工作，返回体带 mailConfigured:false，
 *                     msg 说明“邮件服务未配置”，同时把待发内容写 audit_logs 留痕人工处理。
 *   NOTIFY_WEBHOOK_URL 可选。站内事件的兜底 webhook（webhooks 表为空时使用）。
 *
 * 由 index.js 接线的入口（详见交付说明的接线片段）：
 *   公开   → handleSubscribe（POST /api/subscribe）
 *            handleUnsubscribe（GET|POST /api/unsubscribe?token=）
 *   登录   → handleMyNotifications（GET|POST /api/my/notifications，需已登录用户 me）
 *   后台   → handleAdminSubscribers（GET|DELETE /api/admin/subscribers，admin 档）
 *            handleAdminNotifications（GET|POST /api/admin/notifications，admin 档）
 *            handleAdminWebhooks（GET|POST|DELETE /api/admin/webhooks，super_admin）
 *   内部   → notifyEvent(env, ctx, event, payload)（评论/注册/发文事件分发）
 * ================================================================== */

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 站点对外域名兜底（生成退订链接用）；env.CUSTOM_HOST 优先 */
const FALLBACK_HOST = "my.qingyi.dpdns.org/blog";

/** 站点名（邮件主题用） */
const SITE_NAME = "清逸的博客";

/** Webhook 单次投递超时（毫秒），避免拖垮 Worker */
const WEBHOOK_TIMEOUT_MS = 5000;

/** 各类字段截断上限 */
const LIMIT_EMAIL = 120;
const LIMIT_TITLE = 100;
const LIMIT_BODY = 1000;
const LIMIT_EVENT_BODY = 500;
const LIMIT_PAYLOAD = 8000;
const LIMIT_RESPONSE = 500;

/** 事件名 → 中文标题（站内信 / 事件展示用） */
const EVENT_TITLES = {
  "comment.new": "新评论待审核",
  "comment.reply": "评论收到回复",
  "comment.report": "评论被举报",
  "user.register": "新用户注册",
  "post.publish": "文章已发布",
};

/** 事件名 → 默认跳转链接（payload.link 优先） */
const EVENT_LINKS = {
  "comment.new": "/admin/comments.html",
  "comment.reply": "/admin/comments.html",
  "comment.report": "/admin/comments.html",
  "user.register": "/admin/users.html",
  "post.publish": "/admin/posts.html",
};

/* ------------------------------------------------------------------ */
/* 响应助手（逐条对齐 index.js 的 json()；OPTIONS 预检由各入口先返回 jsonResp({ok:true})） */
/* ------------------------------------------------------------------ */

function jsonResp(obj, status, extraHeaders) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, X-Token",
    ...(extraHeaders || {}),
  };
  return new Response(JSON.stringify(obj), { status: status || 200, headers });
}

/* ------------------------------------------------------------------ */
/* 内部小工具                                                          */
/* ------------------------------------------------------------------ */

/** 权限档位（与 index.js 的 isAdmin / isSuper 判断一致） */
function isAdminRole(me) {
  return !!me && (me.role === "super_admin" || me.role === "admin");
}

function isSuperRole(me) {
  return !!me && me.role === "super_admin";
}

/** 安全读 body：非 JSON / 空 body 一律给 {}，绝不抛 */
async function readBodySafe(request) {
  try {
    if (!request || !request.method || request.method === "GET") return {};
    const text = await request.text();
    if (!text) return {};
    const obj = JSON.parse(text);
    return obj && typeof obj === "object" ? obj : {};
  } catch (e) {
    return {};
  }
}

/** 邮箱基础校验 + 归一化（小写、截断 120）；不合法返回 "" */
function normEmail(raw) {
  const email = String(raw == null ? "" : raw).trim().toLowerCase().slice(0, LIMIT_EMAIL);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return "";
  return email;
}

/** 通用字符串截断 */
function clip(v, max) {
  const s = String(v == null ? "" : v);
  return s.length > max ? s.slice(0, max) : s;
}

/** 字节 → 小写 hex（48 位 token / 签名共用） */
function toHex(bufLike) {
  const bytes = bufLike instanceof Uint8Array ? bufLike : new Uint8Array(bufLike);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/** 生成 24 字节随机 token → 48 位 hex */
function newToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(24)));
}

/** 站点主机名：env.CUSTOM_HOST 优先，兜底 FALLBACK_HOST */
function hostOf(env) {
  const h = String((env && env.CUSTOM_HOST) || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return h || FALLBACK_HOST;
}

/** Best-effort 写审计日志；失败静默（detail 过长自动截断） */
async function audit(env, me, action, target, request, detail) {
  try {
    if (!env || !env.DB) return;
    const uid = me && me.id ? me.id : 0;
    const method = request ? request.method : "";
    const path = request ? new URL(request.url).pathname : "";
    const ip = request
      ? (request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "")
      : "";
    const ua = request ? (request.headers.get("user-agent") || "").slice(0, 200) : "";
    await env.DB.prepare(
      "INSERT INTO audit_logs (user_id, action, target, method, path, ip, ua, detail, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
    ).bind(uid, clip(action, 60), clip(target, 200), method, clip(path, 200), clip(ip, 60), ua,
      clip(typeof detail === "string" ? detail : JSON.stringify(detail || {}), 1000), Date.now()).run();
  } catch (e) {
    /* 审计失败静默：绝不影响主流程 */
  }
}

/** Best-effort 写一条站内信；成功返回 true，失败静默返回 false */
async function insertNotification(env, userId, type, title, body, link) {
  try {
    if (!env || !env.DB) return false;
    await env.DB.prepare(
      "INSERT INTO notifications (user_id, type, title, body, link, read_at, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)"
    ).bind(Number(userId) || 0, clip(type, 20), clip(title, LIMIT_TITLE), clip(body, LIMIT_BODY),
      clip(link, 300), Date.now()).run();
    return true;
  } catch (e) {
    return false;
  }
}

/** 取所有在职管理员（站内信收件人）：super_admin / admin 且 status=1 */
async function adminRecipients(env) {
  try {
    const rs = await env.DB.prepare(
      "SELECT id FROM users WHERE role IN ('super_admin','admin') AND status = 1"
    ).all();
    return (rs && rs.results) || [];
  } catch (e) {
    return [];
  }
}

/** 当前登录用户（供 /api/my/notifications 这类“需登录但非后台前缀”的接口复用）：
 *  优先用调用方传入的 me；否则尝试 env.CURRENT_USER；最后自行解析 X-Token。
 *  注：本模块不 import index.js 的 adminAuth，这里做一份等价的轻量查询。 */
async function currentUser(request, env, me) {
  if (me && me.id) return me;
  try {
    if (!env || !env.DB) return null;
    const token = (request.headers.get("X-Token") || "").slice(0, 80);
    if (!token) return null;
    const row = await env.DB.prepare(
      "SELECT u.id, u.username, u.nickname, u.email, u.role, u.status FROM sessions s " +
      "JOIN users u ON u.id = s.user_id WHERE s.token = ?1 AND s.expire_at > ?2"
    ).bind(token, Date.now()).first();
    if (!row || row.status !== 1) return null;
    return row;
  } catch (e) {
    return null;
  }
}

/** CSV 字段转义：含逗号 / 双引号 / 换行的值用双引号包裹，内部 " → "" */
function csvCell(v) {
  const s = String(v == null ? "" : v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 极简 HTML 响应（退订页；浅色卡片风格，无外部资源） */
function htmlResp(html, status) {
  return new Response(html, {
    status: status || 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

/** 邮件发送（骨架版）：
 *  - env.MAIL_WEBHOOK_URL 存在 → POST {to, subject, text}，HTTP 2xx 视为发信成功；
 *  - 不存在 → mailConfigured:false，把待发内容写入 audit_logs 留痕，便于人工补发。
 *  返回 { configured, delivered }；任何异常都不外抛。 */
async function sendMail(env, to, subject, text) {
  // ① Cloudflare 原生发信（send_email binding）
  if (env && env.EMAIL && typeof env.EMAIL.send === "function") {
    try {
      const from = String((env && env.MAIL_FROM) || "清逸的博客 <noreply@qingyi.dpdns.org>");
      await env.EMAIL.send({ to: to, from: from, subject: subject, text: text });
      return { configured: true, delivered: true };
    } catch (e) {
      return { configured: true, delivered: false };
    }
  }

  // ② Resend 直连（方案 B：第三方邮件服务）
  const resendKey = env && env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const from = String((env && env.MAIL_FROM) || "清逸的博客 <noreply@qingyi.dpdns.org>");
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "authorization": "Bearer " + String(resendKey),
          "content-type": "application/json",
        },
        body: JSON.stringify({ from: from, to: [to], subject: subject, text: text }),
      });
      return { configured: true, delivered: !!(res && res.ok) };
    } catch (e) {
      return { configured: true, delivered: false };
    }
  }

  // ③ 回退：MAIL_WEBHOOK_URL
  const url = String((env && env.MAIL_WEBHOOK_URL) || "").trim();
  if (!url) {
    // 骨架分支：留痕（action = mail.pending），站长可据此人工处理
    await audit(env, null, "mail.pending", to, null, { to, subject, text: clip(text, 900) });
    return { configured: false, delivered: false };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to, subject, text }),
        signal: ctrl.signal,
      });
      return { configured: true, delivered: !!(res && res.ok) };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { configured: true, delivered: false };
  }
}

/* ------------------------------------------------------------------ */
/* 导出：订阅与 Newsletter（FR-X23）                                     */
/* ------------------------------------------------------------------ */

export async function handleSubscribe(request, env) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true });
  if (request.method !== "POST") return jsonResp({ ok: false, msg: "方法不允许" }, 405);
  if (!env || !env.DB) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const body = await readBodySafe(request);
  const email = normEmail(body.email);
  if (!email) return jsonResp({ ok: false, msg: "邮箱格式不正确" }, 400);

  const source = clip(String(body.source || "web").trim(), 40) || "web";
  let token = newToken();

  // ---- 双写 1/2：newsletter_subscribers（email UNIQUE → upsert 是本项目允许的写法）----
  //      复用已有 token 语义：重复订阅幂等，status 复位为 1
  let newsOk = false;
  try {
    await env.DB.prepare(
      "INSERT INTO newsletter_subscribers (email, status, tag, created_at) VALUES (?1, 1, ?2, ?3) " +
      "ON CONFLICT(email) DO UPDATE SET status = 1"
    ).bind(email, source, Date.now()).run();
    newsOk = true;
  } catch (e) {
    // 表不存在 / 写失败：独立降级，不影响 subscriptions 与整体成功
    newsOk = false;
  }

  // ---- 双写 2/2：subscriptions（无唯一键，先 SELECT 再 INSERT/UPDATE）----
  //      已存在：只把 status 复位为 1，并“沿用旧 token” —— 旧退订邮件里的链接不能因为
  //      重新订阅一次就失效（幂等）；没有 token 的历史行才补发新 token。
  let subOk = false;
  try {
    const row = await env.DB.prepare(
      "SELECT id, token FROM subscriptions WHERE email = ?1 LIMIT 1"
    ).bind(email).first();
    if (row && row.id) {
      if (row.token) token = String(row.token);
      await env.DB.prepare(
        "UPDATE subscriptions SET status = 1, token = ?1, source = ?2 WHERE id = ?3"
      ).bind(token, source, row.id).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO subscriptions (email, token, status, source, created_at) VALUES (?1, ?2, 1, ?3, ?4)"
      ).bind(email, token, source, Date.now()).run();
    }
    subOk = true;
  } catch (e) {
    subOk = false;
  }

  // 两张表都不可用：明确报错（否则用户以为订阅成功却查无记录）
  if (!newsOk && !subOk) return jsonResp({ ok: false, msg: "订阅失败，请稍后重试" }, 500);

  // ---- 确认邮件（可选）：env.MAIL_WEBHOOK_URL 存在才算“已发送” ----
  const unsubUrl = "https://" + hostOf(env) + "/api/unsubscribe?token=" + encodeURIComponent(token);
  const mail = await sendMail(env, email, "订阅确认 - " + SITE_NAME, "退订链接：" + unsubUrl);

  // 取舍说明：token 只在「邮件服务未配置」时回给前端。
  //  - 邮件已发 → 退订链接已在收件箱里，接口再暴露 token 等于把“谁都能退订”的凭据放进响应体
  //    （同源脚本/日志/代理都可能拿到），收益为零、风险为正，故不回传；
  //  - 邮件未配置 → 用户拿不到退订链接，只能靠前端提示用户自行保存，此时必须回传兜底。
  const data = { mailConfigured: mail.configured, delivered: mail.delivered };
  if (!mail.configured) data.token = token;

  return jsonResp({
    ok: true,
    msg: "订阅成功" + (mail.configured ? "，确认邮件已发送" : "（邮件服务未配置，退订请保留此链接）"),
    data,
  });
}

/** 退订页 HTML（极简、内联 CSS、无外部资源，浅色卡片，与站点风格一致） */
function unsubPage(title, desc, ok) {
  const color = ok ? "#16a34a" : "#dc2626";
  return "<!doctype html>\n" +
    '<html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" + title + " - " + SITE_NAME + "</title><style>" +
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
    "background:#f5f6f8;color:#1f2937;font:15px/1.7 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif}" +
    ".card{max-width:420px;width:calc(100% - 48px);background:#fff;border:1px solid #e5e7eb;" +
    "border-radius:14px;padding:32px 28px;box-shadow:0 6px 24px rgba(0,0,0,.06);text-align:center}" +
    ".dot{display:inline-block;width:40px;height:40px;line-height:40px;border-radius:50%;" +
    "background:" + color + ";color:#fff;font-size:20px;margin-bottom:14px}" +
    "h1{margin:0 0 10px;font-size:20px}" +
    "p{margin:0 0 22px;color:#6b7280;font-size:14px}" +
    "a.btn{display:inline-block;padding:9px 20px;border-radius:8px;background:#2563eb;color:#fff;" +
    "text-decoration:none;font-size:14px}" +
    "a.btn:hover{background:#1d4ed8}" +
    "</style></head><body><div class=\"card\">" +
    '<div class="dot">' + (ok ? "&#10003;" : "!") + "</div>" +
    "<h1>" + title + "</h1><p>" + desc + "</p>" +
    '<a class="btn" href="/index.html">返回首页</a>' +
    "</div></body></html>";
}

export async function handleUnsubscribe(request, env) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true });
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResp({ ok: false, msg: "方法不允许" }, 405);
  }
  if (!env || !env.DB) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  // token 来源：query 优先（邮件里点进来），其次 body（前端 POST 退订）
  let token = "";
  try {
    token = clip(new URL(request.url).searchParams.get("token") || "", 128).trim();
  } catch (e) {
    token = "";
  }
  if (!token) {
    const body = await readBodySafe(request);
    token = clip(String(body.token || ""), 128).trim();
  }
  if (!token) {
    return jsonResp({ ok: false, msg: "退订链接无效" }, 404);
  }

  let row = null;
  try {
    row = await env.DB.prepare(
      "SELECT id, email FROM subscriptions WHERE token = ?1"
    ).bind(token).first();
  } catch (e) {
    row = null;
  }
  if (!row || !row.id) {
    // 表不存在或 token 不存在：统一按“链接无效”处理，不泄漏内部原因
    return htmlResp(unsubPage("退订链接无效", "该链接已失效或不存在，你可能已经退订过了。", false), 404);
  }

  // 主表置退订
  let done = false;
  try {
    await env.DB.prepare(
      "UPDATE subscriptions SET status = 0 WHERE id = ?1"
    ).bind(row.id).run();
    done = true;
  } catch (e) {
    done = false;
  }

  // 同步邮件列表（try/catch 独立降级；email 用主表读出来的值，不做用户输入）
  if (row.email) {
    try {
      await env.DB.prepare(
        "UPDATE newsletter_subscribers SET status = 0 WHERE email = ?1"
      ).bind(row.email).run();
    } catch (e) {
      /* 表缺失或写失败：忽略 */
    }
  }

  await audit(env, null, "subscribe.unsubscribe", row.email || ("id:" + row.id), request,
    { ok: done });

  return htmlResp(unsubPage(
    "已退订",
    "你已成功退订本站邮件通知，之后不会再收到新的邮件。想回来随时重新订阅即可。",
    true
  ), 200);
}

/* ------------------------------------------------------------------ */
/* 导出：事件分发（FR-X21 / D-X6）                                       */
/* ------------------------------------------------------------------ */

/** 兼容 events 两种存法：先 JSON.parse，失败按逗号分隔；空值 = 订阅全部事件 */
function eventMatched(eventsRaw, event) {
  const raw = String(eventsRaw == null ? "" : eventsRaw).trim();
  if (!raw) return true; // events 为空 → 订阅全部
  let list = null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) list = parsed.map((x) => String(x).trim());
    else if (typeof parsed === "string") list = parsed.split(",");
  } catch (e) {
    list = null;
  }
  if (!list) list = raw.replace(/^\[|\]$/g, "").split(",");
  for (let i = 0; i < list.length; i++) {
    if (String(list[i] || "").replace(/["']/g, "").trim() === event) return true;
  }
  return false;
}

/** 事件 → 一句话摘要（站内信 body / 便于过滤），≤500 */
function summarizeEvent(event, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const pick = (k) => (p[k] == null ? "" : String(p[k]));
  let parts;
  if (event.indexOf("comment") === 0) {
    parts = ["文章：" + pick("post_title"), "评论人：" + pick("author"), "内容：" + pick("content")];
  } else if (event === "user.register") {
    parts = ["用户名：" + pick("username"), "邮箱：" + pick("email"), "来源：" + pick("source")];
  } else if (event === "post.publish") {
    parts = ["标题：" + pick("title"), "分类：" + pick("category"), "作者：" + pick("author")];
  } else {
    parts = [pick("summary"), pick("title"), pick("content")];
  }
  // 过滤掉“字段名：”后面没有任何值的片段（避免出现“内容：”这样的空项）
  const filtered = parts.filter((s) => {
    const i = String(s).indexOf("：");
    return i < 0 ? !!String(s).trim() : !!String(s).slice(i + 1).trim();
  });
  if (filtered.length) return clip(filtered.join(" ｜ "), LIMIT_EVENT_BODY);
  try {
    return clip(JSON.stringify(p), LIMIT_EVENT_BODY);
  } catch (e) {
    return "";
  }
}

/** 事件 → 站内信标题（未知事件回落到事件名本身） */
function eventTitle(event) {
  return EVENT_TITLES[event] || String(event || "事件通知");
}

/** 事件 → 站内信跳转链接（payload.link 优先，非法则用内置默认） */
function eventLink(event, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const link = clip(String(p.link || ""), 300).trim();
  if (link) return link.startsWith("/") || /^https?:\/\//i.test(link) ? link : "/";
  return EVENT_LINKS[event] || "/";
}

/** HMAC-SHA256 → 小写 hex；secret 为空或 crypto 不可用返回 "" */
async function hmacHex(secret, text) {
  try {
    if (!secret) return "";
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(text));
    return toHex(sig);
  } catch (e) {
    return "";
  }
}

/** 投递一个 webhook：5 秒超时 + HMAC 签名 + 写 webhook_deliveries + 维护 fail_count。
 *  单条投递的异常在此吞掉（返回 {ok:false}），绝不影响其他 webhook。webhook_id=0 表示
 *  env.NOTIFY_WEBHOOK_URL 兜底通道（没有对应表行）。 */
async function deliverOne(env, hook, event, payloadJson, hookId) {
  const url = String(hook.url || "").trim();
  if (!url) return { ok: false };
  const started = Date.now();
  let ok = false;
  let statusCode = 0;
  let respText = "";
  let errText = "";

  try {
    const headers = { "content-type": "application/json" };
    const sign = await hmacHex(String(hook.secret || ""), payloadJson);
    if (sign) headers["X-Blog-Signature"] = "sha256=" + sign;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST", headers, body: payloadJson, signal: ctrl.signal,
      });
      statusCode = res ? Number(res.status) || 0 : 0;
      ok = !!(res && res.ok);
      try {
        respText = clip(await res.text(), LIMIT_RESPONSE);
      } catch (e) {
        respText = "";
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    errText = clip(String((e && e.message) || e || "投递失败"), LIMIT_RESPONSE);
  }

  const durationMs = Date.now() - started;

  // 写投递记录（失败静默）
  try {
    await env.DB.prepare(
      "INSERT INTO webhook_deliveries (webhook_id, event, payload, status, status_code, response, " +
      "attempt, next_retry_at, duration_ms, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 0, ?7, ?8)"
    ).bind(hookId, clip(event, 60), clip(payloadJson, LIMIT_PAYLOAD), ok ? 1 : 0, statusCode,
      clip(errText || respText, LIMIT_RESPONSE), durationMs, Date.now()).run();
  } catch (e) {
    /* 表缺失或写失败：忽略 */
  }

  // 维护 webhooks 的健康计数（仅真实表行）
  if (hookId > 0) {
    try {
      if (ok) {
        await env.DB.prepare(
          "UPDATE webhooks SET fail_count = 0, last_at = ?1 WHERE id = ?2"
        ).bind(Date.now(), hookId).run();
      } else {
        await env.DB.prepare(
          "UPDATE webhooks SET fail_count = fail_count + 1, last_at = ?1 WHERE id = ?2"
        ).bind(Date.now(), hookId).run();
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  return { ok, statusCode };
}

/** 事件分发主体：站内信 + webhook 投递，全部 best-effort */
async function dispatchEvent(env, event, payload) {
  const safeEvent = clip(String(event || "").trim(), 60);
  if (!safeEvent) return { ok: false, notified: 0, delivered: 0, failed: 0 };

  const data = payload && typeof payload === "object" ? payload : { value: payload };
  const title = eventTitle(safeEvent);
  const summary = summarizeEvent(safeEvent, data);
  const link = eventLink(safeEvent, data);

  // ---- 站内信：所有在职管理员 ----
  let notified = 0;
  const rows = await adminRecipients(env);
  for (let i = 0; i < rows.length; i++) {
    if (await insertNotification(env, rows[i].id, "event", title, summary, link)) notified++;
  }

  // ---- Webhook：events 命中才投递 ----
  const payloadJson = clip(JSON.stringify({ event: safeEvent, at: Date.now(), data }), LIMIT_PAYLOAD);
  let hooks = null;
  try {
    const rs = await env.DB.prepare(
      "SELECT id, name, url, secret, events FROM webhooks WHERE status = 1"
    ).all();
    hooks = (rs && rs.results) || [];
  } catch (e) {
    hooks = null; // null = 表不可用；[] = 表可用但没有配置
  }

  let delivered = 0;
  let failed = 0;

  if (hooks && hooks.length) {
    for (let i = 0; i < hooks.length; i++) {
      const h = hooks[i] || {};
      if (!eventMatched(h.events, safeEvent)) continue;
      const r = await deliverOne(env, h, safeEvent, payloadJson, Number(h.id) || 0);
      if (r.ok) delivered++;
      else failed++;
    }
  } else if (!hooks || !hooks.length) {
    // 表为空（或表不可用）时用 env.NOTIFY_WEBHOOK_URL 兜底，webhook_id 记 0
    const fallback = String((env && env.NOTIFY_WEBHOOK_URL) || "").trim();
    if (fallback) {
      const r = await deliverOne(env, { url: fallback, secret: "" }, safeEvent, payloadJson, 0);
      if (r.ok) delivered++;
      else failed++;
    }
  }

  return { ok: true, event: safeEvent, notified, delivered, failed };
}

export async function notifyEvent(env, ctx, event, payload) {
  // 永不抛：优先 ctx.waitUntil，没有 ctx 就 fire-and-forget
  try {
    if (!env || !env.DB) return { ok: false, msg: "数据库未绑定" };
    const task = dispatchEvent(env, event, payload).catch(() => ({ ok: false }));
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(task);
      return { ok: true, queued: true, event: String(event || "") };
    }
    task.then(() => {}).catch(() => {});
    return { ok: true, queued: true, event: String(event || "") };
  } catch (e) {
    return { ok: false, msg: "notifyEvent 已忽略异常" };
  }
}

/* 备注：dispatchEvent 不额外导出（导出清单严格锁定为 7 个函数）。
 * 若日后需要“等投递完成再返回”（例如后台手动测试 webhook），把它加一行 export 即可。 */

/* ------------------------------------------------------------------ */
/* 导出：后台订阅者管理                                                  */
/* ------------------------------------------------------------------ */

export async function handleAdminSubscribers(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true });
  if (!isAdminRole(me)) return jsonResp({ ok: false, msg: "无权限" }, 403);
  if (!env || !env.DB) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const url = new URL(request.url);

  // ---------------- GET：列表 / CSV 导出 ----------------
  if (request.method === "GET") {
    const list = [];
    // subscriptions：没有 source 列语义时用表名兜底
    try {
      const rs = await env.DB.prepare(
        "SELECT id, email, status, source, created_at FROM subscriptions ORDER BY id DESC LIMIT 500"
      ).all();
      const rows = (rs && rs.results) || [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] || {};
        list.push({
          id: r.id, email: r.email, status: r.status,
          source: r.source || "subscriptions", created_at: r.created_at,
          table: "subscriptions",
        });
      }
    } catch (e) {
      /* 表缺失：跳过 */
    }
    // newsletter_subscribers：无 source 列，用固定标识 "newsletter"
    try {
      const rs = await env.DB.prepare(
        "SELECT id, email, status, tag, created_at FROM newsletter_subscribers ORDER BY id DESC LIMIT 500"
      ).all();
      const rows = (rs && rs.results) || [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] || {};
        list.push({
          id: r.id, email: r.email, status: r.status,
          source: "newsletter", tag: r.tag, created_at: r.created_at,
          table: "newsletter",
        });
      }
    } catch (e) {
      /* 表缺失：跳过 */
    }

    if (String(url.searchParams.get("format") || "") === "csv") {
      const head = "email,status,source,created_at";
      const lines = [head];
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        lines.push([
          csvCell(r.email), csvCell(r.status), csvCell(r.source), csvCell(r.created_at),
        ].join(","));
      }
      // 加 BOM 便于 Excel 正确识别 UTF-8 中文
      const csv = "\uFEFF" + lines.join("\r\n") + "\r\n";
      return new Response(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
          "content-disposition": 'attachment; filename="subscribers.csv"',
        },
      });
    }

    return jsonResp({ ok: true, data: { list, total: list.length } });
  }

  // ---------------- DELETE：按 email 或 id+source 删除 ----------------
  if (request.method === "DELETE") {
    const body = await readBodySafe(request);
    const email = normEmail(body.email);
    const id = Number(body.id) || 0;
    const src = String(body.source || "").trim();
    if (!email && !id) return jsonResp({ ok: false, msg: "缺少 email 或 id" }, 400);

    const db = env.DB;
    let removed = 0;

    if (email) {
      // 两表都尽力删（各自 try/catch）
      try {
        const r1 = await db.prepare("DELETE FROM subscriptions WHERE email = ?1").bind(email).run();
        removed += Number((r1 && r1.meta && r1.meta.changes) || 0);
      } catch (e) { /* 忽略 */ }
      try {
        const r2 = await db.prepare("DELETE FROM newsletter_subscribers WHERE email = ?1").bind(email).run();
        removed += Number((r2 && r2.meta && r2.meta.changes) || 0);
      } catch (e) { /* 忽略 */ }
    } else {
      // 表名只能来自白名单，杜绝 SQL 拼接注入
      const target = src === "newsletter" ? "newsletter_subscribers" : "subscriptions";
      try {
        const r = await db.prepare("DELETE FROM " + target + " WHERE id = ?1").bind(id).run();
        removed += Number((r && r.meta && r.meta.changes) || 0);
      } catch (e) { /* 忽略 */ }
    }

    await audit(env, me, "subscribe.delete", email || (src + ":" + id), request, { removed });
    return jsonResp({ ok: true, msg: "已删除", data: { removed } });
  }

  return jsonResp({ ok: false, msg: "方法不允许" }, 405);
}

export async function handleAdminNotifications(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true });
  if (!isAdminRole(me)) return jsonResp({ ok: false, msg: "无权限" }, 403);
  if (!env || !env.DB) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  // ---------------- GET：最近 100 条站内信（JOIN users 取 username）----------------
  if (request.method === "GET") {
    let list = [];
    try {
      const rs = await env.DB.prepare(
        "SELECT n.id, n.user_id, n.type, n.title, n.body, n.link, n.read_at, n.created_at, " +
        "COALESCE(u.username, '') AS username FROM notifications n " +
        "LEFT JOIN users u ON u.id = n.user_id ORDER BY n.id DESC LIMIT 100"
      ).all();
      list = (rs && rs.results) || [];
    } catch (e) {
      // JOIN 失败（users 表结构异常 / notifications 缺失）→ 降级为不带 username
      try {
        const rs2 = await env.DB.prepare(
          "SELECT id, user_id, type, title, body, link, read_at, created_at FROM notifications " +
          "ORDER BY id DESC LIMIT 100"
        ).all();
        list = ((rs2 && rs2.results) || []).map((r) => ({ ...r, username: "" }));
      } catch (e2) {
        list = [];
      }
    }
    return jsonResp({ ok: true, data: { list, total: list.length } });
  }

  // ---------------- POST：发站内信（指定 user_id 或广播给全部管理员）----------------
  if (request.method === "POST") {
    const body = await readBodySafe(request);
    const title = clip(String(body.title || "").trim(), LIMIT_TITLE);
    const text = clip(String(body.body || "").trim(), LIMIT_BODY);
    const link = clip(String(body.link || "").trim(), 300);
    if (!title) return jsonResp({ ok: false, msg: "标题不能为空" }, 400);

    const type = clip(String(body.type || "system").trim(), 20) || "system";
    let targets = [];
    const uid = Number(body.user_id) || 0;
    if (uid > 0) {
      targets = [uid];
    } else {
      // 缺省 = 广播给全部管理员
      const rows = await adminRecipients(env);
      targets = rows.map((r) => Number(r.id) || 0).filter((x) => x > 0);
    }
    if (!targets.length) return jsonResp({ ok: false, msg: "没有可投递的收件人" }, 400);

    let inserted = 0;
    for (let i = 0; i < targets.length; i++) {
      if (await insertNotification(env, targets[i], type, title, text, link)) inserted++;
    }

    await audit(env, me, "notification.send", uid ? ("user:" + uid) : "broadcast", request,
      { inserted, title });
    return jsonResp({ ok: true, msg: "已发送", data: { inserted } });
  }

  return jsonResp({ ok: false, msg: "方法不允许" }, 405);
}

export async function handleAdminWebhooks(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true });
  if (!isSuperRole(me)) return jsonResp({ ok: false, msg: "无权限（仅超级管理员）" }, 403);
  if (!env || !env.DB) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const db = env.DB;

  // ---------------- GET：webhooks（secret 脱敏）+ 最近 20 条投递 ----------------
  if (request.method === "GET") {
    let hooks = [];
    try {
      const rs = await db.prepare(
        "SELECT id, name, url, secret, events, status, fail_count, last_at, created_at " +
        "FROM webhooks ORDER BY id DESC LIMIT 200"
      ).all();
      hooks = ((rs && rs.results) || []).map((r) => {
        const s = String((r && r.secret) || "");
        // 脱敏：只回前 4 位，其余用省略号（空 secret 仍为空）
        return { ...r, secret: s ? s.slice(0, 4) + "…" : "" };
      });
    } catch (e) {
      hooks = [];
    }

    let deliveries = [];
    try {
      const rs2 = await db.prepare(
        "SELECT id, webhook_id, event, status, status_code, response, attempt, duration_ms, created_at " +
        "FROM webhook_deliveries ORDER BY id DESC LIMIT 20"
      ).all();
      deliveries = (rs2 && rs2.results) || [];
    } catch (e) {
      deliveries = [];
    }

    return jsonResp({ ok: true, data: { list: hooks, deliveries, total: hooks.length } });
  }

  // ---------------- POST：新增 / 更新 ----------------
  if (request.method === "POST") {
    const body = await readBodySafe(request);
    const id = Number(body.id) || 0;
    const name = clip(String(body.name || "").trim(), 100);
    const hookUrl = clip(String(body.url || "").trim(), 500);
    const events = clip(
      typeof body.events === "string" ? body.events : JSON.stringify(body.events || []), 500
    );
    const status = body.status === 0 || body.status === false ? 0 : 1;

    if (!name) return jsonResp({ ok: false, msg: "名称不能为空" }, 400);
    if (!/^https:\/\//i.test(hookUrl)) {
      return jsonResp({ ok: false, msg: "仅支持 HTTPS" }, 400);
    }

    try {
      if (id > 0) {
        if (typeof body.secret === "string" && body.secret !== "") {
          await db.prepare(
            "UPDATE webhooks SET name = ?1, url = ?2, events = ?3, status = ?4, secret = ?5 WHERE id = ?6"
          ).bind(name, hookUrl, events, status, clip(body.secret, 200), id).run();
        } else {
          // 未传 secret → 保留原值（脱敏后前端本来也拿不到原值）
          await db.prepare(
            "UPDATE webhooks SET name = ?1, url = ?2, events = ?3, status = ?4 WHERE id = ?5"
          ).bind(name, hookUrl, events, status, id).run();
        }
      } else {
        await db.prepare(
          "INSERT INTO webhooks (name, url, secret, events, status, fail_count, last_at, created_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6)"
        ).bind(name, hookUrl, clip(String(body.secret || ""), 200), events, status, Date.now()).run();
      }
    } catch (e) {
      return jsonResp({ ok: false, msg: "保存失败：" + clip(String((e && e.message) || e), 120) }, 500);
    }

    await audit(env, me, id > 0 ? "webhook.update" : "webhook.create",
      (id > 0 ? "id:" + id : hookUrl), request, { name, url: hookUrl, events, status });
    return jsonResp({ ok: true, msg: id > 0 ? "已更新" : "已创建" });
  }

  // ---------------- DELETE：删除 webhook 及其投递记录 ----------------
  if (request.method === "DELETE") {
    const body = await readBodySafe(request);
    const id = Number(body.id) || 0;
    if (!id) return jsonResp({ ok: false, msg: "缺少 id" }, 400);

    try {
      await db.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?1").bind(id).run();
    } catch (e) { /* 忽略 */ }
    try {
      await db.prepare("DELETE FROM webhooks WHERE id = ?1").bind(id).run();
    } catch (e) { /* 忽略 */ }

    await audit(env, me, "webhook.delete", "id:" + id, request, {});
    return jsonResp({ ok: true, msg: "已删除" });
  }

  return jsonResp({ ok: false, msg: "方法不允许" }, 405);
}

export async function handleMyNotifications(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true });
  if (!env || !env.DB) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  // me 由 index.js 传入（复用 adminAuth）；未传时本模块自行按 X-Token 解析
  const user = await currentUser(request, env, me);
  if (!user || !user.id) return jsonResp({ ok: false, msg: "请先登录" }, 401);

  // ---------------- GET：自己的最近 50 条 ----------------
  if (request.method === "GET") {
    let list = [];
    let unread = 0;
    try {
      const rs = await env.DB.prepare(
        "SELECT id, type, title, body, link, read_at, created_at FROM notifications " +
        "WHERE user_id = ?1 ORDER BY id DESC LIMIT 50"
      ).bind(user.id).all();
      list = (rs && rs.results) || [];
    } catch (e) {
      list = [];
    }
    try {
      const c = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM notifications WHERE user_id = ?1 AND read_at = 0"
      ).bind(user.id).first();
      unread = Number((c && c.c) || 0);
    } catch (e) {
      unread = 0;
    }
    return jsonResp({ ok: true, data: { list, unread, total: list.length } });
  }

  // ---------------- POST：标记已读（指定 id 或全部）----------------
  if (request.method === "POST") {
    const body = await readBodySafe(request);
    const at = Date.now();
    let changes = 0;
    try {
      if (body.all === true || body.all === 1 || body.all === "1") {
        const r = await env.DB.prepare(
          "UPDATE notifications SET read_at = ?1 WHERE user_id = ?2 AND read_at = 0"
        ).bind(at, user.id).run();
        changes = Number((r && r.meta && r.meta.changes) || 0);
      } else {
        const id = Number(body.id) || 0;
        if (!id) return jsonResp({ ok: false, msg: "缺少 id 或 all" }, 400);
        const r = await env.DB.prepare(
          "UPDATE notifications SET read_at = ?1 WHERE id = ?2 AND user_id = ?3 AND read_at = 0"
        ).bind(at, id, user.id).run();
        changes = Number((r && r.meta && r.meta.changes) || 0);
      }
    } catch (e) {
      return jsonResp({ ok: false, msg: "操作失败" }, 500);
    }
    return jsonResp({ ok: true, msg: "已标记已读", data: { updated: changes } });
  }

  return jsonResp({ ok: false, msg: "方法不允许" }, 405);
}

/* ------------------------------------------------------------------ */
/* 导出：后台站内信管理（实现在上方 handleAdminNotifications）            */
/* 导出：后台 Webhook 管理（实现在上方 handleAdminWebhooks）              */
/* 导出：登录用户站内信（实现在上方 handleMyNotifications）               */
/* ------------------------------------------------------------------ */
