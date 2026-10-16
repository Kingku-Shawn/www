/* ==================================================================
 * 清逸的博客 · 认证扩展：密码重置 / 邮箱验证（worker/src/features/auth-ext.js）
 * 自包含模块：零依赖、零 import、导入时零副作用
 * ------------------------------------------------------------------
 * 对应《追加补充.md》：
 *   · FR-X13 —— 密码重置（忘记密码 → 生成一次性令牌 → 重置密码并踢掉全部旧会话）
 *   · FR-X14 —— 邮箱验证（骨架：令牌流程完整跑通，「发信」环节返回明确提示）
 *
 * 当前部署现状（用户已确认）：邮件服务暂未配置（无 env.MAIL_WEBHOOK_URL），
 *   因此本模块只落「接口骨架 + 表」：令牌可生成、可校验、可消费，但不会真正发信，
 *   响应里明确告知 mailConfigured:false 并提示联系站长取令牌。
 *   一旦在 Cloudflare 里配置 MAIL_WEBHOOK_URL，同一套代码自动切换为发信分支。
 *
 * 硬约束：
 *   1) 本模块不 import 任何模块（避免与 index.js 形成循环依赖），所需小工具函数全部内部自定义；
 *   2) 导入时无副作用：不查 D1、不发 fetch、不读 env；
 *   3) 所有 D1 / fetch / crypto 调用全程 try/catch，绝不抛未捕获异常；
 *   4) 只用标准 Web API（crypto.subtle / crypto.getRandomValues / TextEncoder / Response / JSON / fetch），
 *      不用 Node 专有 API；
 *   5) 密码哈希算法与 index.js 的 hashPassword 逐字一致（PBKDF2 / SHA-256 / 100000 轮 / 256 bit，
 *      盐为 8 字节即 16 位 hex），否则重置后的账号无法登录。
 *
 * 依赖的既有表（worker/src/extend-schema.js，本模块不建表、不改表）：
 *   password_resets  (token TEXT PRIMARY KEY, user_id, email, expire_at, used, created_at)
 *   email_verifications(token TEXT PRIMARY KEY, user_id, email, expire_at, used, created_at)
 *   users(id, username, nickname, email, role, status, pass_salt, pass_hash, created_at,
 *         email_verified, last_login_at, last_login_ip, failed_login_count, locked_until,
 *         two_factor_secret, bio, website, social_json)
 *         ⚠ 后 10 列来自扩展 ALTER，线上可能尚未创建 → 相关读写全部 try/catch 降级
 *   sessions(token TEXT PRIMARY KEY, user_id, created_at, expire_at)
 *   audit_logs(id, user_id, action, target, method, path, ip, ua, detail, created_at)
 *
 * 由 index.js 接线的五个入口（接线片段见交付说明，本模块不改 index.js）：
 *   POST /api/auth/password/request    → handlePasswordResetRequest
 *   POST /api/auth/password/confirm    → handlePasswordResetConfirm
 *   POST /api/auth/email/verify/request→ handleEmailVerifyRequest(request, env, me)
 *   POST /api/auth/email/verify/confirm→ handleEmailVerifyConfirm
 *   GET  /api/admin/auth/tokens        → handleAdminResetTokens(request, env, me)  仅 super_admin
 *
 * ⚠ 注意：/api/auth/* 不命中 index.js 里任何既有分支，会被最后的 proxyStaticJson 兜底吞掉；
 *    接线时必须把这几条精确路径判断放在该兜底之前（详见回报的接线片段）。
 * ================================================================== */

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const RESET_TTL_MS = 30 * 60 * 1000;   // 密码重置令牌有效期：30 分钟
const VERIFY_TTL_MS = 30 * 60 * 1000;  // 邮箱验证令牌有效期：30 分钟
const TOKEN_BYTES = 24;                // 24 字节随机 → 48 位 hex
const SALT_BYTES = 8;                  // 8 字节随机 → 16 位 hex（与 index.js 注册逻辑一致）
const MIN_PASSWORD_LEN = 6;
const TOKEN_PREFIX_LEN = 8;            // 排障列表只展示前 8 位
const AUDIT_DETAIL_MAX = 500;
const ADMIN_TOKEN_LIMIT = 50;

/* 发信后用户点击的落地页路径（前端页面若改名，只改这两处）。
 * ⚠ 未在仓库中确认这两个页面是否存在，见交付说明「无法确认的点」。 */
const RESET_LINK_PATH = "/user/reset.html?token=";
const VERIFY_LINK_PATH = "/user/verify.html?token=";

/* ------------------------------------------------------------------ */
/* 响应助手（响应头对齐 index.js 的 json()：content-type / no-store / CORS 三头） */
/* ------------------------------------------------------------------ */

function jsonResp(obj, status = 200, extraHeaders = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, X-Token",
    ...extraHeaders,
  };
  return new Response(JSON.stringify(obj), { status, headers });
}

/* 统一的 OPTIONS 预检响应（各入口第一行调用） */
function preflight(request) {
  if (request && request.method === "OPTIONS") return jsonResp({ ok: true });
  return null;
}

/* ------------------------------------------------------------------ */
/* 内部小工具：hex / 密码哈希 / 请求体 / IP / UA（全部与 index.js 对齐）  */
/* ------------------------------------------------------------------ */

/* 逐字对齐 index.js 的 hexEncode */
function hexEncode(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* 逐字对齐 index.js 的 hexToBytes */
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/* 逐字对齐 index.js 的 hashPassword：PBKDF2 / SHA-256 / 100000 轮 / 256 bit。
 * ⚠ 参数任何一处改动都会导致老账号重置后无法登录，请勿「顺手优化」。 */
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

/* 新盐：16 位 hex（与注册时的 hexEncode(getRandomValues(8)) 完全同口径） */
function newSaltHex() {
  return hexEncode(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/* 新令牌：48 位 hex */
function newTokenHex() {
  return hexEncode(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/* 排障用掩码：只保留前 8 位，避免完整令牌外泄 */
function maskToken(token) {
  const t = String(token || "");
  if (!t) return "";
  return t.length <= TOKEN_PREFIX_LEN ? t + "…" : t.slice(0, TOKEN_PREFIX_LEN) + "…";
}

/* 内联 index.js 的 readBody（本模块不 import，故复制一份最小实现） */
async function readBody(request) {
  try {
    const ct = (request && request.headers.get("content-type")) || "";
    if (!ct.includes("json")) return {};
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function clientIp(request) {
  try {
    return (
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("x-forwarded-for") ||
      ""
    ).slice(0, 64);
  } catch (e) {
    return "";
  }
}

function clientUa(request) {
  try {
    return (request.headers.get("user-agent") || "").slice(0, 200);
  } catch (e) {
    return "";
  }
}

/* 安全执行：任何 D1 / crypto 异常都降级为 null，绝不冒泡 */
async function safe(fn, fallback = null) {
  try {
    const r = await fn();
    return r === undefined ? fallback : r;
  } catch (e) {
    return fallback;
  }
}

/* 从 query string 取 token（方便邮件里的链接直接 GET 过来；解析失败返回空串） */
function queryToken(request) {
  try {
    return new URL(request.url).searchParams.get("token") || "";
  } catch (e) {
    return "";
  }
}

/* 当前毫秒时间戳（与扩展表列口径一致：一律用毫秒整数） */
function nowMs() {
  return Date.now();
}

/* 毫秒 → "YYYY-MM-DD HH:mm:ss"（北京时间 UTC+8，与 index.js 的 fmtTime 同口径） */
function fmtTime(ms) {
  const n = Number(ms);
  if (!n) return "";
  const d = new Date(n + 8 * 3600 * 1000);
  if (isNaN(d.getTime())) return "";
  const p = (x) => (x < 10 ? "0" + x : "" + x);
  return (
    d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
    " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds())
  );
}

/* ------------------------------------------------------------------ */
/* 审计（best-effort，表可能不存在）                                    */
/* ------------------------------------------------------------------ */

/* 字段与 extend-schema.js 的 audit_logs 完全一致：
 * user_id, action, target, method, path, ip, ua, detail, created_at
 * ⚠ audit_logs 可能尚未创建 → 全程 try/catch，失败静默（绝不影响主流程返回） */
async function audit(env, request, info) {
  return safe(async () => {
    const db = env && env.DB;
    if (!db) return null;
    const detail = String(info && info.detail ? info.detail : "").slice(0, AUDIT_DETAIL_MAX);
    await db.prepare(
      "INSERT INTO audit_logs (user_id, action, target, method, path, ip, ua, detail, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
    ).bind(
      Number(info && info.userId) || 0,
      String((info && info.action) || ""),
      String((info && info.target) || ""),
      String((request && request.method) || ""),
      String((info && info.path) || ""),
      clientIp(request),
      clientUa(request),
      detail,
      nowMs()
    ).run();
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* 邮件发送：优先 Cloudflare 原生 Email Service（send_email binding = EMAIL），
 * 否则回退 MAIL_WEBHOOK_URL；两者都没有即骨架分支（mailConfigured:false）   */
/* ------------------------------------------------------------------ */

/* 统一返回 { configured, delivered }：
 *   configured=false → 未配置邮件服务（当前线上即此分支，响应里明确提示）
 *   configured=true, delivered=false → 配置了但发送失败（不影响主流程，用户仍可找站长取令牌）
 * 全程 try/catch，绝不抛错 */
async function sendMail(env, mail) {
  const to = String(mail.to || "");
  const subject = String(mail.subject || "");
  const text = String(mail.text || "");

  // ① Cloudflare 原生发信（send_email binding）
  if (env && env.EMAIL && typeof env.EMAIL.send === "function") {
    return safe(async () => {
      const from = String((env && env.MAIL_FROM) || "清逸的博客 <noreply@qingyi.dpdns.org>");
      await env.EMAIL.send({ to: to, from: from, subject: subject, text: text });
      return { configured: true, delivered: true };
    }, { configured: true, delivered: false });
  }

  // ② Resend 直连（方案 B：第三方邮件服务，无需 Cloudflare 验证发件域）
  const resendKey = env && env.RESEND_API_KEY;
  if (resendKey) {
    return safe(async () => {
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
    }, { configured: true, delivered: false });
  }

  // ③ 回退：MAIL_WEBHOOK_URL 转发
  const url = env && env.MAIL_WEBHOOK_URL;
  if (!url) return { configured: false, delivered: false };
  return safe(async () => {
    const res = await fetch(String(url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: to,
        subject: subject,
        text: text,
        token: String(mail.token || ""),
        link: String(mail.link || ""),
      }),
    });
    return { configured: true, delivered: !!(res && res.ok) };
  }, { configured: true, delivered: false });
}

/* 站点根（用于拼重置/验证链接）：从 request.url 推导，失败退回空串 */
function siteOrigin(request) {
  try {
    return new URL(request.url).origin;
  } catch (e) {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* 额外导出（接线辅助）：轻量 token → 登录用户查询                        */
/* ------------------------------------------------------------------ */

/* 供 index.js 的 fetch 在处理 /api/auth/email/verify/request 前取「登录用户」。
 * 只读 sessions JOIN users，只取最小字段（与 adminAuth / handleMe 的判定同口径：
 * s.expire_at > now 为有效会话，users.status === 1 为启用），失败一律返回 null。 */
export async function resolveMe(request, env) {
  return safe(async () => {
    const db = env && env.DB;
    if (!db) return null;
    const token = (request.headers.get("X-Token") || "").slice(0, 80);
    if (!token) return null;
    const row = await db.prepare(
      "SELECT u.id, u.username, u.nickname, u.email, u.role, u.status " +
      "FROM sessions s JOIN users u ON u.id = s.user_id " +
      "WHERE s.token = ?1 AND s.expire_at > ?2"
    ).bind(token, nowMs()).first();
    if (!row) return null;
    if (row.status !== undefined && row.status !== null && row.status !== 1) return null;
    return { id: row.id, username: row.username, nickname: row.nickname, email: row.email, role: row.role || "user" };
  }, null);
}

/* ------------------------------------------------------------------ */
/* 导出入口 1/5：POST /api/auth/password/request —— 申请密码重置          */
/* ------------------------------------------------------------------ */
export async function handlePasswordResetRequest(request, env) {
  const opt = preflight(request);
  if (opt) return opt;
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const body = (await readBody(request)) || {};
  const email = String(body.email || "").trim().slice(0, 120);
  const username = String(body.username || "").trim().slice(0, 32);
  if (!email && !username) return jsonResp({ ok: false, msg: "请填写邮箱或用户名" }, 400);

  const now = nowMs();
  const mailReady = !!(env && env.MAIL_WEBHOOK_URL);
  let delivered = false;
  let tokenPrefix = ""; // 只用于审计留痕（8 位前缀），完整令牌只写服务端日志

  // 查用户：邮箱或用户名任一命中（缺失值填空串，保证 ?1/?2 都有绑定值）。
  // ⚠ 注意加了 `?N <> '' AND` 守卫：users.email 的默认值是空串（注册时不写 email），
  //    若只传 username 而无守卫，`email=''` 会命中任意一个没填邮箱的账号 → 给错人发令牌。
  const user = await safe(async () => db.prepare(
    "SELECT id, username, email FROM users " +
    "WHERE (?1 <> '' AND email=?1) OR (?2 <> '' AND username=?2) LIMIT 1"
  ).bind(email, username).first(), null);

  // ⚠ 无论是否查到用户，最终响应体完全一致（防账号枚举）；差异只在审计与服务端日志
  if (user) {
    const token = newTokenHex();
    const expireAt = now + RESET_TTL_MS;
    const target = String(user.email || email || "");
    tokenPrefix = token.slice(0, TOKEN_PREFIX_LEN);

    // 先作废该用户旧的未使用令牌，再插入新令牌；表不存在时 safe → false
    const wrote = await safe(async () => {
      await db.prepare(
        "UPDATE password_resets SET used=1 WHERE user_id=?1 AND used=0"
      ).bind(user.id).run();
      await db.prepare(
        "INSERT INTO password_resets (token, user_id, email, expire_at, used, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, 0, ?5)"
      ).bind(token, user.id, target, expireAt, now).run();
      return true;
    }, false);

    if (wrote) {
      // 完整令牌只进服务端日志（wrangler tail / 控制台可见）与站长渠道，绝不进响应体
      console.log("[auth-ext] password reset token generated", JSON.stringify({
        userId: user.id, username: user.username, token, expireAt,
      }));

      if (mailReady) {
        const m = await sendMail(env, {
          to: target,
          subject: "【清逸的博客】密码重置",
          text: "您好，我们收到了密码重置请求。请在 30 分钟内点击链接完成重置；如非本人操作，请忽略本邮件。令牌：" + token,
          token,
          link: siteOrigin(request) + RESET_LINK_PATH + token,
        });
        delivered = !!(m && m.delivered);
      }
    } else {
      // 令牌没写进去（扩展表未创建 / D1 异常）：对外仍返回同样的成功文案以防枚举
      console.log("[auth-ext] password_resets write failed (扩展表未创建？)", JSON.stringify({ userId: user.id }));
    }
  }

  // 审计留痕：只记 8 位令牌前缀，不落完整令牌；audit_logs 不存在时静默失败
  await audit(env, request, {
    userId: user ? user.id : 0,
    action: "auth.password.request",
    target: user ? String(user.id) : (email || username),
    path: "/api/auth/password/request",
    detail: JSON.stringify({ found: !!user, mailConfigured: mailReady, delivered, tokenPrefix }),
  });

  return jsonResp({
    ok: true,
    msg: mailReady
      ? "如果该账号存在，重置链接已发送，请查收邮箱；未收到请联系站长。"
      : "如果该账号存在，重置链接已生成；当前未配置邮件服务，请联系站长获取重置令牌。",
    data: mailReady ? { mailConfigured: true, delivered } : { mailConfigured: false },
  });
}

/* ------------------------------------------------------------------ */
/* 导出入口 2/5：POST /api/auth/password/confirm —— 凭令牌重置密码        */
/* ------------------------------------------------------------------ */
export async function handlePasswordResetConfirm(request, env) {
  const opt = preflight(request);
  if (opt) return opt;
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const body = (await readBody(request)) || {};
  const token = String(body.token || "").trim().slice(0, 128);
  const password = String(body.password == null ? "" : body.password);
  if (!token) return jsonResp({ ok: false, msg: "重置链接无效或已过期" }, 400);
  if (password.length < MIN_PASSWORD_LEN) {
    return jsonResp({ ok: false, msg: "密码至少 6 位" }, 400);
  }

  const now = nowMs();
  // 查令牌：表不存在 / 查询异常 → row=null → 统一按「无效或已过期」处理
  const row = await safe(async () => db.prepare(
    "SELECT token, user_id, email, expire_at, used, created_at FROM password_resets WHERE token=?1"
  ).bind(token).first(), null);
  if (!row || Number(row.used) === 1 || Number(row.expire_at) < now) {
    return jsonResp({ ok: false, msg: "重置链接无效或已过期" }, 400);
  }

  // 生成新盐与新哈希（算法与注册/登录完全同口径）
  const saltHex = newSaltHex();
  const passHash = await safe(async () => hashPassword(password, saltHex), null);
  if (!passHash) return jsonResp({ ok: false, msg: "密码重置失败，请稍后重试" }, 500);

  // 注意：本项目 users 表的列名是 pass_salt / pass_hash（没有 password_hash / salt）
  const changed = await safe(async () => {
    await db.prepare(
      "UPDATE users SET pass_salt=?1, pass_hash=?2 WHERE id=?3"
    ).bind(saltHex, passHash, row.user_id).run();
    return true;
  }, false);
  // 改密失败（用户被删 / D1 异常）时不消费令牌，便于用户重试
  if (!changed) return jsonResp({ ok: false, msg: "密码重置失败，请稍后重试" }, 500);

  // 令牌置为已用（一次性）；即便这一步失败，密码已改成功，不再回滚
  await safe(async () => db.prepare(
    "UPDATE password_resets SET used=1 WHERE token=?1"
  ).bind(token).run(), null);

  // 安全：踢掉该用户全部旧会话（含可能被盗用的会话），best-effort
  const kicked = await safe(async () => {
    const r = await db.prepare("DELETE FROM sessions WHERE user_id=?1").bind(row.user_id).run();
    return true;
  }, false);

  await audit(env, request, {
    userId: row.user_id,
    action: "auth.password.confirm",
    target: String(row.user_id),
    path: "/api/auth/password/confirm",
    detail: JSON.stringify({ email: String(row.email || ""), sessionsCleared: !!kicked }),
  });

  return jsonResp({ ok: true, msg: "密码已重置，请用新密码登录" });
}

/* 读用户的邮箱与验证状态：email_verified 列来自扩展 ALTER，可能尚未创建 →
 * 先按两列查，抛错则降级为只查 email（验证状态按 0 处理）。 */
async function loadUserEmail(db, userId) {
  const both = await safe(async () => db.prepare(
    "SELECT email, email_verified FROM users WHERE id=?1"
  ).bind(userId).first(), null);
  if (both) return { email: String(both.email || ""), email_verified: Number(both.email_verified) || 0 };
  const only = await safe(async () => db.prepare(
    "SELECT email FROM users WHERE id=?1"
  ).bind(userId).first(), null);
  if (!only) return null;
  return { email: String(only.email || ""), email_verified: 0 };
}

/* ------------------------------------------------------------------ */
/* 导出入口 3/5：POST /api/auth/email/verify/request —— 申请邮箱验证      */
/* me 由 index.js 传入（形如 { id, username, role }）                    */
/* ------------------------------------------------------------------ */
export async function handleEmailVerifyRequest(request, env, me) {
  const opt = preflight(request);
  if (opt) return opt;
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const myId = me && me.id;
  if (!myId) return jsonResp({ ok: false, msg: "请先登录" }, 401);

  const now = nowMs();
  const mailReady = !!(env && env.MAIL_WEBHOOK_URL);
  let delivered = false;

  const user = await loadUserEmail(db, myId);
  if (!user) return jsonResp({ ok: false, msg: "用户不存在" }, 404);
  const target = user.email || String((me && me.email) || "");
  if (!target) return jsonResp({ ok: false, msg: "请先在个人资料里填写邮箱" }, 400);
  if (user.email_verified === 1) return jsonResp({ ok: true, msg: "邮箱已验证" });

  const token = newTokenHex();
  const expireAt = now + VERIFY_TTL_MS;
  // 先作废旧的未使用令牌，再插入新令牌（表不存在 → false）
  const wrote = await safe(async () => {
    await db.prepare(
      "UPDATE email_verifications SET used=1 WHERE user_id=?1 AND used=0"
    ).bind(myId).run();
    await db.prepare(
      "INSERT INTO email_verifications (token, user_id, email, expire_at, used, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, 0, ?5)"
    ).bind(token, myId, target, expireAt, now).run();
    return true;
  }, false);

  if (!wrote) {
    console.log("[auth-ext] email_verifications write failed (扩展表未创建？)", JSON.stringify({ userId: myId }));
    return jsonResp({ ok: false, msg: "验证令牌生成失败，请确认扩展表已创建", note: "扩展表未创建" }, 500);
  }

  // 完整令牌只进服务端日志，绝不进响应体
  console.log("[auth-ext] email verify token generated", JSON.stringify({
    userId: myId, email: target, token, expireAt,
  }));

  if (mailReady) {
    const m = await sendMail(env, {
      to: target,
      subject: "【清逸的博客】邮箱验证",
      text: "您好，请在 30 分钟内点击链接完成邮箱验证。令牌：" + token,
      token,
      link: siteOrigin(request) + VERIFY_LINK_PATH + token,
    });
    delivered = !!(m && m.delivered);
  }

  await audit(env, request, {
    userId: myId,
    action: "auth.email.verify.request",
    target: String(myId),
    path: "/api/auth/email/verify/request",
    detail: JSON.stringify({ email: target, mailConfigured: mailReady, delivered, tokenPrefix: token.slice(0, TOKEN_PREFIX_LEN) }),
  });

  return jsonResp({
    ok: true,
    msg: mailReady ? "验证邮件已发送，请查收邮箱。" : "验证邮件已生成；当前未配置邮件服务，请联系站长。",
    data: mailReady ? { mailConfigured: true, delivered } : { mailConfigured: false },
  });
}

/* ------------------------------------------------------------------ */
/* 导出入口 4/5：POST /api/auth/email/verify/confirm —— 凭令牌确认邮箱     */
/* ------------------------------------------------------------------ */
export async function handleEmailVerifyConfirm(request, env) {
  const opt = preflight(request);
  if (opt) return opt;
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const body = (await readBody(request)) || {};
  const token = String(body.token || queryToken(request) || "").trim().slice(0, 128);
  if (!token) return jsonResp({ ok: false, msg: "验证链接无效或已过期" }, 400);

  const now = nowMs();
  const row = await safe(async () => db.prepare(
    "SELECT token, user_id, email, expire_at, used, created_at FROM email_verifications WHERE token=?1"
  ).bind(token).first(), null);
  if (!row || Number(row.used) === 1 || Number(row.expire_at) < now) {
    return jsonResp({ ok: false, msg: "验证链接无效或已过期" }, 400);
  }

  // email_verified 列可能尚未创建 → 失败时不消费令牌，便于修好表结构后用同一令牌重试
  const marked = await safe(async () => {
    await db.prepare("UPDATE users SET email_verified=1 WHERE id=?1").bind(row.user_id).run();
    return true;
  }, false);

  await audit(env, request, {
    userId: row.user_id,
    action: "auth.email.verify.confirm",
    target: String(row.user_id),
    path: "/api/auth/email/verify/confirm",
    detail: JSON.stringify({ email: String(row.email || ""), columnUpdated: !!marked }),
  });

  if (!marked) {
    return jsonResp({ ok: false, msg: "邮箱验证失败，请确认扩展表已创建", note: "email_verified 列未创建" }, 500);
  }

  await safe(async () => db.prepare(
    "UPDATE email_verifications SET used=1 WHERE token=?1"
  ).bind(token).run(), null);

  return jsonResp({ ok: true, msg: "邮箱验证成功" });
}

/* ------------------------------------------------------------------ */
/* 导出入口 5/5：GET /api/admin/auth/tokens —— 排障用令牌列表（super_admin） */
/* ------------------------------------------------------------------ */
export async function handleAdminResetTokens(request, env, me) {
  const opt = preflight(request);
  if (opt) return opt;
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const role = (me && me.role) || "";
  if (role !== "super_admin") return jsonResp({ ok: false, msg: "权限不足" }, 403);
  if (String(request.method || "GET").toUpperCase() !== "GET") {
    return jsonResp({ ok: false, msg: "方法不允许" }, 405);
  }

  // 两类令牌各取最近 N 条；表不存在 → null（下面统一降级）
  const [resets, verifies] = await Promise.all([
    safe(async () => (await db.prepare(
      "SELECT token, user_id, email, expire_at, used, created_at FROM password_resets " +
      "ORDER BY created_at DESC LIMIT ?1"
    ).bind(ADMIN_TOKEN_LIMIT).all()).results || [], null),
    safe(async () => (await db.prepare(
      "SELECT token, user_id, email, expire_at, used, created_at FROM email_verifications " +
      "ORDER BY created_at DESC LIMIT ?1"
    ).bind(ADMIN_TOKEN_LIMIT).all()).results || [], null),
  ]);

  if (resets === null && verifies === null) {
    return jsonResp({ ok: true, data: [], note: "扩展表未创建" });
  }

  const now = nowMs();
  const mapped = [];
  const push = (rows, type, pathBase) => {
    (rows || []).forEach((r) => {
      mapped.push({
        type,
        token: maskToken(r.token),                 // 只给前 8 位 + …，完整令牌只存服务端日志
        tokenPrefix: String(r.token || "").slice(0, TOKEN_PREFIX_LEN),
        user_id: Number(r.user_id) || 0,
        email: String(r.email || ""),
        used: Number(r.used) || 0,
        expired: Number(r.expire_at) < now,
        expire_at: Number(r.expire_at) || 0,
        created_at: Number(r.created_at) || 0,
        created_text: fmtTime(r.created_at),
        path: pathBase,
      });
    });
  };
  push(resets, "password_reset", "/api/auth/password/confirm");
  push(verifies, "email_verify", "/api/auth/email/verify/confirm");
  mapped.sort((a, b) => b.created_at - a.created_at);

  return jsonResp({
    ok: true,
    data: mapped.slice(0, ADMIN_TOKEN_LIMIT),
    total: mapped.length,
    note: "令牌仅展示前 8 位；完整令牌请查服务端日志（wrangler tail）",
  });
}
