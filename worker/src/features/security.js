/* ==================================================================
 * 清逸的博客 · 安全与可观测（worker/src/features/security.js）
 * 自包含模块：零依赖、零 import、导入时零副作用
 * ------------------------------------------------------------------
 * 对应《追加补充.md》：
 *   · NFR-X2 —— 限流防刷（固定窗口计数，D1 rate_limits 表）
 *   · NFR-X3 —— 审计日志（关键写操作留痕，D1 audit_logs 表）
 *   · NFR-X4 —— 可观测性（X-Request-Id 注入与回传）
 *
 * 硬约束：
 *   1) 本模块不 import 任何模块（避免与 index.js 形成循环依赖），所需小工具全部内部自定义；
 *   2) 导入时零副作用：不查 D1、不发 fetch、不注册定时器；
 *   3) 所有 D1 调用 try/catch：限流表坏了「放行」，审计表坏了「静默」，绝不影响主流程；
 *   4) 只用标准 Web API（crypto.getRandomValues / Response / JSON），不用 Node 专有 API；
 *   5) 动态 SQL 只允许 LIKE ?1 / IN (...) 这类参数化写法，用户输入一律 bind，不拼字符串。
 *
 * 依赖的既有表（worker/src/extend-schema.js，本模块不建表、不改表）：
 *   rate_limits(key TEXT, window_start INTEGER, count INTEGER, expire_at INTEGER,
 *               updated_at INTEGER, PRIMARY KEY (key, window_start))
 *   audit_logs (id, user_id, action, target, method, path, ip, ua, detail, created_at)
 *   settings   (key TEXT PRIMARY KEY, value TEXT)   —— 限流规则存 key = "rate_limits"，值为 JSON
 *
 * 由 index.js 接线的入口：
 *   公共   → checkRateLimit / rateLimitResponse / rateLimitHeaders（各写接口自行调用）
 *   响应头 → newRequestId / withRequestId（fetch() 里生成并回传 X-Request-Id）
 *   后台   → handleAdminAuditLogs（GET /api/admin/audit-logs，super_admin）
 *            handleAdminRateLimits（GET|POST|DELETE /api/admin/rate-limits，super_admin）
 * ================================================================== */

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
/* 常量：默认限流规则（可被 settings.rate_limits 覆盖）                  */
/* ------------------------------------------------------------------ */

/** name → { limit: 次数, windowMs: 窗口毫秒 }；limit <= 0 表示关闭该接口限流 */
const DEFAULT_RATE_RULES = {
  comment: { limit: 5, windowMs: 60000 },      // 评论发布：1 分钟 5 次
  login: { limit: 10, windowMs: 300000 },      // 登录：5 分钟 10 次
  register: { limit: 3, windowMs: 3600000 },   // 注册：1 小时 3 次
  upload: { limit: 20, windowMs: 3600000 },    // 上传：1 小时 20 次
  search: { limit: 30, windowMs: 60000 },      // 搜索：1 分钟 30 次
  view: { limit: 60, windowMs: 60000 },        // 阅读打点：1 分钟 60 次
  report: { limit: 10, windowMs: 3600000 },    // 举报：1 小时 10 次
  subscribe: { limit: 5, windowMs: 60000 },    // 邮件订阅：1 分钟 5 次
  pwreset: { limit: 5, windowMs: 3600000 },    // 密码重置申请：1 小时 5 次
};

/** settings 表里存限流规则的键名 */
const RATE_RULES_KEY = "rate_limits";
/** 规则缓存 TTL（毫秒）：避免每个请求都读一次 settings */
const RULES_CACHE_MS = 30000;
/** 后台审计日志 / 限流管理允许的角色 */
const SUPER_ROLES = ["super_admin"];

/* ------------------------------------------------------------------ */
/* 内部小工具（不导出）                                                */
/* ------------------------------------------------------------------ */

/** 规则名合法性：只允许字母数字下划线短横，最长 40 */
const RULE_NAME_RE = /^[a-z0-9_-]{1,40}$/;

/** 规则名/值缓存：{ at, rules: 合并后规则, overrides: settings 里的原始覆盖项 } */
let rulesCache = { at: 0, rules: null, overrides: null };

/** me 是否为 super_admin（后台两条安全路由都只放开给超管） */
function isSuper(me) {
  return !!(me && SUPER_ROLES.indexOf(String(me.role || "")) >= 0);
}

/** 客户端 IP（与 index.js 的 clientKey 取值口径保持一致） */
function clientIp(request) {
  try {
    return String(request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "").slice(0, 60);
  } catch (e) {
    return "";
  }
}

/** 安全读 JSON body：非 JSON / 空 body 一律返回 {}，绝不抛 */
async function readJsonBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch (e) {
    return {};
  }
}

/** 整数裁剪：非法值回落到 def，并夹在 [min, max] */
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** 规范化单条规则（limit 0–10000 整数 / windowMs 1000–86400000 整数）；非法返回 null */
function normRule(limit, windowMs) {
  const l = Number(limit);
  const w = Number(windowMs);
  if (!Number.isInteger(l) || l < 0 || l > 10000) return null;
  if (!Number.isInteger(w) || w < 1000 || w > 86400000) return null;
  return { limit: l, windowMs: w };
}

/**
 * 合并规则：以 base 为底，over 里合法的条目覆盖之。
 * 兼容两种写法：{ comment: { limit, windowMs } } 与 { comment: 5 }（只给次数，窗口沿用原值）。
 */
function mergeRules(base, over) {
  const out = {};
  const src = base && typeof base === "object" ? base : {};
  for (const k of Object.keys(src)) {
    const r = normRule(src[k] && src[k].limit, src[k] && src[k].windowMs);
    if (r) out[k] = r;
  }
  if (!over || typeof over !== "object") return out;
  for (const rawKey of Object.keys(over)) {
    const key = String(rawKey).toLowerCase();
    if (!RULE_NAME_RE.test(key)) continue;
    const v = over[rawKey];
    const prev = out[key] || DEFAULT_RATE_RULES[key] || null;
    // 简写：数字即 limit，窗口沿用旧值/默认 60s
    if (typeof v === "number") {
      const r = normRule(v, prev ? prev.windowMs : 60000);
      if (r) out[key] = r;
      continue;
    }
    if (!v || typeof v !== "object") continue;
    const limit = Number(v.limit);
    // limit <= 0 视为「关闭该接口限流」，允许省略 windowMs
    if (Number.isInteger(limit) && limit <= 0) {
      const w = v.windowMs === undefined || v.windowMs === null
        ? (prev ? prev.windowMs : 60000)
        : Number(v.windowMs);
      out[key] = { limit: 0, windowMs: Number.isInteger(w) && w >= 1000 && w <= 86400000 ? w : 60000 };
      continue;
    }
    const r = normRule(limit, v.windowMs === undefined || v.windowMs === null ? (prev ? prev.windowMs : 60000) : v.windowMs);
    if (r) out[key] = r;
  }
  return out;
}

/**
 * 默认规则 + settings("rate_limits") 覆盖；缓存 30s 降低 D1 读压力。
 * 读表失败（表不存在 / JSON 坏了）退回默认规则，不影响限流可用性。
 */
async function loadRateRules(env) {
  const now = Date.now();
  if (rulesCache.rules && now - rulesCache.at < RULES_CACHE_MS) {
    return { rules: rulesCache.rules, overrides: rulesCache.overrides || {} };
  }
  let overrides = {};
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1").bind(RATE_RULES_KEY).first();
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // 键名统一小写，便于 checkRateLimit 判断「该接口是否被管理员显式配置过」
        for (const rawKey of Object.keys(parsed)) {
          const k = String(rawKey).toLowerCase();
          if (RULE_NAME_RE.test(k)) overrides[k] = parsed[rawKey];
        }
      }
    }
  } catch (e) {
    // settings 表缺失或 JSON 非法：只用默认规则
  }
  const rules = mergeRules(DEFAULT_RATE_RULES, overrides);
  rulesCache = { at: now, rules, overrides };
  return { rules, overrides };
}

/** 主动清空规则缓存（管理员改完规则后立即生效） */
function invalidateRulesCache() {
  rulesCache = { at: 0, rules: null, overrides: null };
}

/* ------------------------------------------------------------------ */
/* NFR-X4：X-Request-Id                                                */
/* ------------------------------------------------------------------ */

/** 生成 16 位十六进制请求 ID（crypto 不可用时退化为 Math.random） */
export function newRequestId() {
  try {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    let s = "";
    for (let i = 0; i < buf.length; i++) s += buf[i].toString(16).padStart(2, "0");
    return s;
  } catch (e) {
    let s = "";
    for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }
}

/**
 * 给 Headers 实例或普通对象设置 X-Request-Id（已有则不改写，保持上游/回源透传值）。
 * @returns 传入的 headers 本身（headers 为空时返回一个含该头的新对象）
 */
export function withRequestId(headers, id) {
  const rid = String(id || "").slice(0, 64);
  if (!rid) return headers || {};
  if (!headers) return { "X-Request-Id": rid };
  // Headers 实例
  if (typeof headers.get === "function" && typeof headers.set === "function") {
    try {
      if (!headers.get("x-request-id")) headers.set("X-Request-Id", rid);
    } catch (e) {
      // 只读 / 不可变 headers：忽略
    }
    return headers;
  }
  // 普通对象：键名大小写不敏感判重
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "x-request-id") return headers;
  }
  headers["X-Request-Id"] = rid;
  return headers;
}

/* ------------------------------------------------------------------ */
/* NFR-X2：固定窗口限流                                                */
/* ------------------------------------------------------------------ */

/**
 * 固定窗口限流计数。
 * @param {object} env  Worker env（需要 env.DB）
 * @param {object} opts { name, key, limit, windowMs }
 * @returns {Promise<{allowed:boolean, limit:number, remaining:number, resetAt:number, count:number,
 *                    name?:string, degraded?:boolean}>}
 *   规则不存在或 limit<=0 → allowed:true（不锁死没配规则的接口）
 *   D1 报错 / 表不存在   → allowed:true 且 degraded:true（限流表坏了不能打死站点）
 */
export async function checkRateLimit(env, opts) {
  const o = opts || {};
  const name = String(o.name || "").slice(0, 40).toLowerCase();
  const key = String(o.key || "anon").slice(0, 180);
  const now = Date.now();

  // 1) 解析规则，优先级：settings 覆盖 > 调用方显式传入 > 默认规则表
  let rule = null;
  let overrides = {};
  if (env && env.DB && name) {
    try {
      const loaded = await loadRateRules(env);
      overrides = loaded.overrides || {};
      rule = loaded.rules[name] || null;
    } catch (e) {
      // 规则读取失败：继续用调用方显式参数兜底
    }
  }
  const explicitLimit = Number(o.limit);
  const overriddenByAdmin = !!(overrides && Object.prototype.hasOwnProperty.call(overrides, name));
  if (!overriddenByAdmin && Number.isInteger(explicitLimit)) {
    const w = o.windowMs === undefined || o.windowMs === null ? 60000 : Number(o.windowMs);
    const r = normRule(explicitLimit, Number.isInteger(w) && w >= 1000 && w <= 86400000 ? w : 60000);
    if (r) rule = r;
  }

  // 2) 规则不存在或 limit <= 0 → 直接放行，绝不锁死没配规则的接口
  if (!rule || !(Number(rule.limit) > 0)) {
    return { allowed: true, limit: 0, remaining: 0, resetAt: now + 60000, count: 0, name, reason: "no_rule" };
  }

  const limit = Math.floor(Number(rule.limit));
  const windowMs = Math.max(1000, Math.floor(Number(rule.windowMs) || 60000));
  const windowStart = Math.floor(now / windowMs) * windowMs; // 固定窗口起点
  const resetAt = windowStart + windowMs;

  // 3) 计数：UPSERT 自增，再读回最新值（主键 (key, window_start) 天然按窗口分桶）
  if (!env || !env.DB) {
    return { allowed: true, limit, remaining: 0, resetAt, count: 0, name, degraded: true };
  }
  try {
    const db = env.DB;
    const upsertSql = [
      "INSERT INTO rate_limits (key, window_start, count, expire_at, updated_at)",
      "VALUES (?1, ?2, 1, ?3, ?4)",
      "ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1, updated_at = ?4",
    ].join(" ");
    await db.prepare(upsertSql).bind(key, windowStart, resetAt, now).run();

    const row = await db.prepare(
      "SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2"
    ).bind(key, windowStart).first();
    const count = Math.max(1, Math.floor(Number(row && row.count) || 1));

    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt,
      count,
      name,
    };
  } catch (e) {
    // 限流表不存在 / SQL 失败：降级放行，绝不因为限流坏了打死站点
    return { allowed: true, limit, remaining: 0, resetAt, count: 0, name, degraded: true };
  }
}

/** X-RateLimit-* 三件套（值一律字符串） */
export function rateLimitHeaders(limit, remaining, resetAt) {
  const l = Math.max(0, Math.floor(Number(limit) || 0));
  const r = Math.max(0, Math.floor(Number(remaining) || 0));
  const reset = Number(resetAt) > 0 ? Math.floor(Number(resetAt)) : Date.now() + 60000;
  return {
    "X-RateLimit-Limit": String(l),
    "X-RateLimit-Remaining": String(r),
    "X-RateLimit-Reset": String(reset),
  };
}

/** 429 响应：JSON 体 + Retry-After + X-RateLimit-* */
export function rateLimitResponse(opts) {
  const o = opts || {};
  const now = Date.now();
  const resetAt = Number(o.resetAt) > 0 ? Math.floor(Number(o.resetAt)) : now + 60000;
  const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
  const extra = {
    ...rateLimitHeaders(o.limit, o.remaining, resetAt),
    "retry-after": String(retryAfter),
    // 让浏览器 JS 能读到这几个头（跨域下默认不可见）
    "access-control-expose-headers": "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After, X-Request-Id",
  };
  return jsonResp({ ok: false, msg: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" }, 429, extra);
}

/* ------------------------------------------------------------------ */
/* NFR-X3：审计日志                                                    */
/* ------------------------------------------------------------------ */

/**
 * 写一条审计日志（best-effort：全程 try/catch，失败静默，绝不抛）。
 * @param {object} env
 * @param {object} entry { userId, action, target, method, path, ip, ua, detail }
 */
export async function recordAudit(env, entry) {
  try {
    if (!env || !env.DB) return;
    const e = entry || {};
    const clip = (v, n) => String(v === undefined || v === null ? "" : v).slice(0, n);
    const uid = Number(e.userId);
    const sql = [
      "INSERT INTO audit_logs (user_id, action, target, method, path, ip, ua, detail, created_at)",
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    ].join(" ");
    await env.DB.prepare(sql).bind(
      Number.isFinite(uid) ? Math.floor(uid) : 0,
      clip(e.action, 60),
      clip(e.target, 200),
      clip(e.method, 10),
      clip(e.path, 200),
      clip(e.ip, 60),
      clip(e.ua, 200),
      clip(e.detail, 1000),
      Date.now()
    ).run();
  } catch (e) {
    // best-effort：审计失败静默，绝不影响主流程
  }
}

/** GET /api/admin/audit-logs?limit=&action=&user_id=（仅 super_admin） */
export async function handleAdminAuditLogs(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true });
  if (!isSuper(me)) return jsonResp({ ok: false, msg: "权限不足" }, 403);
  if (request.method !== "GET") return jsonResp({ ok: false, msg: "方法不允许" }, 405);
  try {
    const url = new URL(request.url);
    const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
    const action = String(url.searchParams.get("action") || "").trim().slice(0, 60);
    const userId = parseInt(url.searchParams.get("user_id") || "", 10);

    // 条件全部参数化拼装，用户输入绝不进 SQL 字符串
    const where = [];
    const params = [];
    if (action) { where.push("action = ?" + (params.length + 1)); params.push(action); }
    if (Number.isFinite(userId)) { where.push("user_id = ?" + (params.length + 1)); params.push(userId); }
    const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";

    const listSql = [
      "SELECT id, user_id, action, target, method, path, ip, ua, detail, created_at",
      "FROM audit_logs" + whereSql,
      "ORDER BY id DESC LIMIT ?" + (params.length + 1),
    ].join(" ");
    const rs = await env.DB.prepare(listSql).bind(...params, limit).all();

    const totalSql = "SELECT COUNT(*) AS c FROM audit_logs" + whereSql;
    const totalRow = await env.DB.prepare(totalSql).bind(...params).first();

    return jsonResp({
      ok: true,
      data: {
        list: (rs && rs.results) || [],
        total: Number(totalRow && totalRow.c) || 0,
      },
    });
  } catch (e) {
    // 扩展表未创建：返回空列表而不是 500，后台页面照常渲染
    return jsonResp({ ok: true, data: { list: [], total: 0 }, note: "扩展表未创建" });
  }
}

/** GET|POST|DELETE /api/admin/rate-limits（仅 super_admin） */
export async function handleAdminRateLimits(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true });
  if (!isSuper(me)) return jsonResp({ ok: false, msg: "权限不足" }, 403);
  const method = request.method;
  const ip = clientIp(request);
  const ua = request.headers.get("user-agent") || "";

  // ---- 查看：合并后的规则 + 最近 1 小时的窗口计数 Top50 ----
  if (method === "GET") {
    let rules = mergeRules(DEFAULT_RATE_RULES, null);
    try {
      const loaded = await loadRateRules(env);
      rules = loaded.rules;
    } catch (e) { /* 规则读取失败：退回默认规则 */ }
    let current = [];
    try {
      const since = Date.now() - 3600000;
      const rs = await env.DB.prepare(
        [
          "SELECT key, window_start, count FROM rate_limits",
          "WHERE window_start > ?1 ORDER BY count DESC LIMIT 50",
        ].join(" ")
      ).bind(since).all();
      current = (rs && rs.results) || [];
    } catch (e) {
      current = []; // 限流表未创建
    }
    return jsonResp({ ok: true, data: { rules, current } });
  }

  // ---- 修改：body { rules: { comment: { limit, windowMs }, ... } } 合并后落 settings ----
  if (method === "POST") {
    const body = await readJsonBody(request);
    const incoming = body.rules && typeof body.rules === "object" ? body.rules : null;
    if (!incoming) return jsonResp({ ok: false, msg: "规则格式错误：需要 { rules: { 名称: { limit, windowMs } } }" }, 400);
    const names = Object.keys(incoming);
    if (!names.length) return jsonResp({ ok: false, msg: "规则为空" }, 400);

    const patch = {};
    for (const rawName of names) {
      const name = String(rawName).toLowerCase();
      if (!RULE_NAME_RE.test(name)) return jsonResp({ ok: false, msg: "规则名非法（只允许字母数字_ -）：" + name.slice(0, 40) }, 400);
      const v = incoming[rawName] && typeof incoming[rawName] === "object" ? incoming[rawName] : {};
      const limit = Number(v.limit);
      const windowMs = v.windowMs === undefined || v.windowMs === null ? 60000 : Number(v.windowMs);
      if (!Number.isInteger(limit) || limit < 0 || limit > 10000) {
        return jsonResp({ ok: false, msg: "limit 必须是 0-10000 的整数：" + name }, 400);
      }
      if (!Number.isInteger(windowMs) || windowMs < 1000 || windowMs > 86400000) {
        return jsonResp({ ok: false, msg: "windowMs 必须是 1000-86400000 的整数：" + name }, 400);
      }
      patch[name] = { limit, windowMs };
    }

    try {
      const loaded = await loadRateRules(env);
      const merged = mergeRules(loaded.rules, patch);
      const sql = [
        "INSERT INTO settings (key, value) VALUES (?1, ?2)",
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ].join(" ");
      await env.DB.prepare(sql).bind(RATE_RULES_KEY, JSON.stringify(merged)).run();
      invalidateRulesCache(); // 立刻生效，不等 30s 缓存过期

      await recordAudit(env, {
        userId: me && me.id,
        action: "security.rate_limits",
        target: RATE_RULES_KEY,
        method: "POST",
        path: "/api/admin/rate-limits",
        ip,
        ua,
        detail: JSON.stringify(patch),
      });
      return jsonResp({ ok: true, msg: "限流规则已保存", data: { rules: merged } });
    } catch (e) {
      return jsonResp({ ok: false, msg: "保存失败：" + String(e && e.message || e).slice(0, 120) }, 500);
    }
  }

  // ---- 清理：body { all: true } 清空计数；否则 { key: "comment" } 按前缀删 ----
  if (method === "DELETE") {
    const body = await readJsonBody(request);
    const all = body.all === true;
    const key = String(body.key || "").trim().slice(0, 180);
    if (!all && !key) return jsonResp({ ok: false, msg: "需要 key 或 all:true" }, 400);

    let changes = 0;
    let note = "";
    try {
      const rs = all
        ? await env.DB.prepare("DELETE FROM rate_limits").run()
        : await env.DB.prepare("DELETE FROM rate_limits WHERE key LIKE ?1").bind(key + "%").run();
      changes = Number(rs && rs.meta && rs.meta.changes) || 0;
    } catch (e) {
      note = "扩展表未创建";
    }

    await recordAudit(env, {
      userId: me && me.id,
      action: "security.rate_limits.clear",
      target: all ? "*" : key,
      method: "DELETE",
      path: "/api/admin/rate-limits",
      ip,
      ua,
      detail: JSON.stringify({ all, key, changes }),
    });
    const data = { changes };
    return note
      ? jsonResp({ ok: true, msg: "限流表不可用（已忽略）", data, note })
      : jsonResp({ ok: true, msg: all ? "已清空限流计数" : "已清理指定维度计数", data });
  }

  return jsonResp({ ok: false, msg: "方法不允许" }, 405);
}
