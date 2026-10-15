/* ==================================================================
 * 清逸的博客 · 评论审核队列 / 风控 / 举报（worker/src/features/moderation.js）
 * 自包含模块：零依赖、零 import、导入时零副作用
 * ------------------------------------------------------------------
 * 对应《追加补充.md》：
 *   · FR-X19 —— 评论审核队列：先审后发开关、批量通过 / 拒绝 / 删除、审核备注
 *   · FR-X20 —— 评论风控：敏感词、黑名单（word / ip / ua / email / client）、链接过多
 *   · FR-X21 ——（部分）举报链路：公开举报入口 + 后台举报处理
 *
 * 硬约束：
 *   1) 本模块不 import 任何模块（避免与 index.js 形成循环依赖），小工具全部内部自定义；
 *   2) 导入时无副作用：不查 D1、不发 fetch；D1 调用全程 try/catch，失败降级（宁可放过，不误杀）；
 *   3) 动态 SQL 只允许 IN (...) 占位符这一处，其余一律 ?n 参数化；
 *   4) 只用标准 Web API（URL / Headers / crypto.subtle / TextEncoder / JSON / Date），不用 Node 专有 API。
 *
 * 依赖的既有表（extend-schema.js / index.js 内建，本模块不建表、不改表）：
 *   comments(id, post_id, page_id, root_id, parent_id, author, email, avatar, role,
 *            content, status, zan, cai, created_at, ip_hash, ua, ...)
 *            status：1=展示，0=隐藏或待审
 *   comment_reports(id, comment_id, post_id, reason, detail, client_key, ip_hash,
 *                   status, handled_by, handled_at, created_at)
 *                   status：0=待处理，1=已处理，2=已忽略
 *   comment_blacklist(id, type, value, reason, status, expire_at, created_at)
 *                   type ∈ word / ip / ua / email / client
 *   audit_logs(id, user_id, action, target, method, path, ip, ua, detail, created_at)
 *   settings(key, value) —— 评论配置 key = 'comment'，value 为 JSON 字符串
 *
 * 由 index.js 接线的入口（精确片段见交付回报）：
 *   POST /api/report                             → handleReport(request, env)               公开
 *   POST /api/admin/comments/bulk                → handleAdminCommentsBulk(request, env, me)
 *   GET|POST /api/admin/comments/report          → handleAdminReports(request, env, me)
 *   GET|POST /api/admin/settings/comment         → handleAdminCommentSettings(request, env, me)
 *   GET|POST|DELETE /api/admin/comment-blacklist → handleAdminBlacklist(request, env, me)
 *   评论发布前风险评估（在 handlePinlun 的 case "publish" 内）→ checkCommentRisk(env, input)
 *
 * ⚠ me 是「已通过 adminAuth 鉴权」的后台用户对象（{id, username, role, ...}），
 *   本模块不重复鉴权，但每个写操作仍会校验 me.role，防止未来接线失误。
 * ================================================================== */

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 评论配置默认值（settings.key = 'comment' 的值结构） */
const DEF_SETTINGS = { moderate: false, words: [], linkLimit: 0 };
/** 黑名单允许的 type */
const BL_TYPES = ["word", "ip", "ua", "email", "client"];
/** 批量审核一次最多处理的评论数 */
const BULK_MAX = 100;
/** 敏感词最多保存条数 / 单条截断长度 */
const WORDS_MAX = 500;
const WORD_LEN = 40;
/** DELETE 需要放行的方法头（跨域预检用；index.js 的默认值只有 GET, POST, OPTIONS） */
const DEL_HEADERS = { "access-control-allow-methods": "GET, POST, OPTIONS, DELETE" };

/* ------------------------------------------------------------------ */
/* 基础工具（与 index.js 同名函数同语义，但独立定义）                    */
/* ------------------------------------------------------------------ */

/** 统一 JSON 响应；响应头对齐 index.js 的 json()（NFR-X1 安全头由接线处统一补） */
function jsonResp(obj, status, extraHeaders) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, X-Token",
  };
  const extra = extraHeaders || {};
  for (const k in extra) headers[k] = extra[k];
  return new Response(JSON.stringify(obj), { status: status || 200, headers });
}

function nowMs() {
  return Date.now();
}

/** String(...) + 长度截断：杜绝 undefined.includes 之类的崩溃 */
function clip(v, n) {
  const s = v === null || v === undefined ? "" : String(v);
  return s.length > n ? s.slice(0, n) : s;
}

function errText(e) {
  return clip((e && e.message) || e || "未知错误", 200);
}

/** 正整数 id：非法一律 0 */
function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 分页上限：非法 → 默认值，超限 → 上限 */
function clampLimit(v, def, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return n > max ? max : n;
}

/** 评论配置里的 linkLimit：限定 0–20 */
function clampLink(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 20 ? 20 : n;
}

/** 过期时间：0=永不过期；接受毫秒时间戳（数字/纯数字串）或 ISO 日期串 */
function toExpireMs(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 0 ? n : 0;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/** 敏感词归一化：去空、去重（不区分大小写）、每条截断 40、最多 500 条 */
function normWords(list) {
  const out = [];
  const seen = {};
  const src = Array.isArray(list) ? list : [];
  for (let i = 0; i < src.length && out.length < WORDS_MAX; i++) {
    const w = clip(src[i], WORD_LEN).trim();
    if (!w) continue;
    const k = w.toLowerCase();
    if (seen[k]) continue;
    seen[k] = 1;
    out.push(w);
  }
  return out;
}

/** 批量 id 归一化：只留正整数、去重、最多 BULK_MAX 条 */
function normIds(list) {
  const out = [];
  const seen = {};
  const src = Array.isArray(list) ? list : [];
  for (let i = 0; i < src.length && out.length < BULK_MAX; i++) {
    const id = toId(src[i]);
    if (!id || seen[id]) continue;
    seen[id] = 1;
    out.push(id);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 指纹 / IP / 请求体（口径与 index.js、features/likes.js 完全一致）      */
/* ------------------------------------------------------------------ */

/** 真实 IP：cf-connecting-ip → x-forwarded-for → 0.0.0.0 */
function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "0.0.0.0";
}

/** UA 原文（截断 200，只作排查用） */
function uaOf(request) {
  return clip(request.headers.get("user-agent") || "", 200);
}

/** 客户端指纹：与 index.js 的 clientKey() 完全一致（IP|UA，截断 180） */
function clientKeyOf(request) {
  return clip(clientIp(request) + "|" + (request.headers.get("user-agent") || ""), 180);
}

/** SHA-256 hex（只哈希 IP，不含 UA）；无 crypto.subtle 时降级空串 */
async function sha256Hex(text) {
  try {
    if (!(globalThis.crypto && crypto.subtle)) return "";
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
    const bytes = new Uint8Array(buf);
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
    return out;
  } catch (e) {
    return "";
  }
}

/** 读取 JSON 请求体（口径同 index.js 的 readBody）；非法 / 非 JSON 返回 {} */
async function readJson(request) {
  try {
    const t = await request.text();
    if (!t) return {};
    const o = JSON.parse(t);
    return o && typeof o === "object" ? o : {};
  } catch (e) {
    return {};
  }
}

function pathOf(request) {
  try {
    return new URL(request.url).pathname;
  } catch (e) {
    return "";
  }
}

/** 是否具备评论管理权限（super_admin / admin） */
function isAdminRole(me) {
  return !!me && (me.role === "super_admin" || me.role === "admin");
}

function noPerm() {
  return jsonResp({ ok: false, msg: "权限不足" }, 403);
}

/* ------------------------------------------------------------------ */
/* 审计日志                                                            */
/* ------------------------------------------------------------------ */

/**
 * 生成审计 INSERT 语句（供 index.js 复用；不执行、不抛异常）。
 * event: { me, action, target, method, path, ip, ua, detail }
 * 列顺序：user_id, action, target, method, path, ip, ua, detail, created_at（共 9 个绑定）
 */
export function auditLogStmt(event) {
  const ev = event || {};
  const me = ev.me || {};
  return {
    sql: "INSERT INTO audit_logs (user_id, action, target, method, path, ip, ua, detail, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    params: [
      toId(me.id),
      clip(ev.action, 80),
      clip(ev.target, 200),
      clip(ev.method, 10),
      clip(ev.path, 200),
      clip(ev.ip, 64),
      clip(ev.ua, 200),
      clip(ev.detail, 300),
      nowMs(),
    ],
  };
}

/** 写审计：失败只吞掉，绝不影响主流程 */
async function writeAudit(db, event) {
  try {
    if (!db) return false;
    const ev = event || {};
    const req = ev.request;
    const stmt = auditLogStmt({
      me: ev.me,
      action: ev.action,
      target: ev.target,
      detail: ev.detail,
      method: req ? req.method : ev.method,
      path: req ? pathOf(req) : ev.path,
      ip: req ? clientIp(req) : ev.ip,
      ua: req ? uaOf(req) : ev.ua,
    });
    await db.prepare(stmt.sql).bind(...stmt.params).run();
    return true;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 评论配置读取（settings.key = 'comment'）                             */
/* ------------------------------------------------------------------ */

/** 默认配置的浅拷贝（words 必须每次新数组，避免被调用方改动污染常量） */
function defSettings() {
  return { moderate: DEF_SETTINGS.moderate, words: [], linkLimit: DEF_SETTINGS.linkLimit };
}

/** 读评论配置：查询失败 / 解析失败一律回落默认值（moderate:false, words:[], linkLimit:0） */
async function readCommentSettings(env) {
  const def = defSettings();
  const db = env && env.DB;
  if (!db) return def;
  let raw = null;
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = ?1").bind("comment").first();
    raw = row ? row.value : null;
  } catch (e) {
    return def;
  }
  if (raw === null || raw === undefined || raw === "") return def;
  let o = null;
  try {
    o = JSON.parse(String(raw));
  } catch (e) {
    return def;
  }
  if (!o || typeof o !== "object") return def;
  return {
    moderate: o.moderate === true,
    words: normWords(o.words),
    linkLimit: clampLink(o.linkLimit),
  };
}

/* ------------------------------------------------------------------ */
/* 1. 风控判定（FR-X20 核心）                                           */
/* ------------------------------------------------------------------ */

/**
 * 黑名单匹配：命中返回给用户看的（类型化）文案，未命中返回 ""。
 * 注意：不回显黑名单原文，避免被用来探测词库 / IP 段。
 */
function matchBlacklist(rows, ctx) {
  const list = Array.isArray(rows) ? rows : [];
  const content = ctx.content.toLowerCase();
  const ck = ctx.clientKey.toLowerCase();
  const uaL = ctx.ua.toLowerCase();
  const mailL = ctx.email.toLowerCase();
  for (let i = 0; i < list.length; i++) {
    const r = list[i] || {};
    const type = String(r.type === null || r.type === undefined ? "" : r.type).toLowerCase();
    const val = clip(r.value, 200);
    if (!val) continue;
    const v = val.toLowerCase();
    if (type === "word") {
      if (content.indexOf(v) >= 0) return "评论包含被禁止的内容，请修改后重试";
      continue;
    }
    if (type === "ip") {
      // ip_hash 相等 / 前缀命中；value 为哈希片段时用 clientKey 包含兜底
      if (ctx.ipHash && (ctx.ipHash === v || ctx.ipHash.indexOf(v) === 0)) {
        return "当前网络环境已被限制发言，请联系站长";
      }
      if (ck && ck.indexOf(v) >= 0) return "当前网络环境已被限制发言，请联系站长";
      continue;
    }
    if (type === "ua") {
      if (uaL && uaL.indexOf(v) >= 0) return "当前浏览器环境已被限制发言，请联系站长";
      continue;
    }
    if (type === "email") {
      if (mailL && mailL.indexOf(v) >= 0) return "该邮箱已被限制发言，请联系站长";
      continue;
    }
    if (type === "client") {
      if (ck && ck.indexOf(v) >= 0) return "当前设备已被限制发言，请联系站长";
    }
  }
  return "";
}

/**
 * 评论风控判定（纯函数式：只查库，不写库、不决定 status，由 index.js 决定）。
 * @param {object} env   Worker 环境（env.DB）
 * @param {object} input { content, clientKey, ipHash, ua, email, pageId }
 * @returns {Promise<{blocked:boolean, needAudit:boolean, reason:string}>}
 *   blocked=true   → 直接拒绝（黑名单命中）
 *   needAudit=true → 写 status=0（先审后发 / 敏感词 / 链接过多 / 黑名单查询失败）
 */
export async function checkCommentRisk(env, input) {
  const it = input || {};
  const content = clip(it.content, 4000);
  const clientKey = clip(it.clientKey, 200);
  const ipHash = clip(it.ipHash, 200).toLowerCase();
  const ua = clip(it.ua, 200);
  const email = clip(it.email, 200);
  // pageId 目前不参与判定，保留参数位给后续频率限制（rate_limits）接线
  const res = { blocked: false, needAudit: false, reason: "" };
  const soft = [];
  const cfg = await readCommentSettings(env);
  const db = env && env.DB;

  // ---- 1) 黑名单：命中即拦；查询失败绝不能判 blocked（宁可放过，转人工审核）----
  if (!db) {
    soft.push("数据库未绑定，转人工审核");
  } else {
    try {
      const rows = await db.prepare(
        "SELECT type, value FROM comment_blacklist WHERE status = 1 " +
        "AND (expire_at = 0 OR expire_at > ?1) LIMIT 500"
      ).bind(nowMs()).all();
      const hit = matchBlacklist(rows && rows.results, { content, clientKey, ipHash, ua, email });
      if (hit) {
        res.blocked = true;
        res.reason = hit;
        return res;
      }
    } catch (e) {
      soft.push("黑名单校验失败，转人工审核（" + errText(e) + "）");
    }
  }

  // ---- 2) 敏感词（settings.words）命中 → 进审核队列，不直接拒绝 ----
  const hits = [];
  for (let i = 0; i < cfg.words.length; i++) {
    const w = cfg.words[i];
    if (w && content.toLowerCase().indexOf(w.toLowerCase()) >= 0) hits.push(clip(w, 20));
    if (hits.length >= 3) break;
  }
  if (hits.length) soft.push("命中敏感词：" + hits.join("、"));

  // ---- 3) 先审后发总开关 ----
  if (cfg.moderate === true) soft.push("先审后发已开启");

  // ---- 4) 链接过多 ----
  const links = (content.match(/https?:\/\//gi) || []).length;
  if (cfg.linkLimit > 0 && links > cfg.linkLimit) {
    soft.push("链接过多（" + links + " > " + cfg.linkLimit + "）");
  }

  if (soft.length) {
    res.needAudit = true;
    res.reason = clip(soft.join("；"), 200);
  }
  return res;
}

/* ------------------------------------------------------------------ */
/* 2. 公开举报（FR-X20 / FR-X21）                                       */
/* ------------------------------------------------------------------ */

/** POST /api/report   body: { id, reason, detail }（id = 评论 id） */
export async function handleReport(request, env) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true });
  if (request.method !== "POST") return jsonResp({ ok: false, msg: "仅支持 POST" }, 405);
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const body = await readJson(request);
  const id = toId(body.id !== undefined ? body.id : (body.comment_id !== undefined ? body.comment_id : body.commentId));
  if (!id) return jsonResp({ ok: false, msg: "缺少评论 id" }, 400);
  const reason = clip(body.reason, 200).trim() || "其他";
  const detail = clip(body.detail !== undefined ? body.detail : body.msg, 500).trim();
  const clientKey = clientKeyOf(request);

  // 1) 评论必须存在
  let row = null;
  try {
    row = await db.prepare("SELECT id, post_id FROM comments WHERE id = ?1").bind(id).first();
  } catch (e) {
    return jsonResp({ ok: false, msg: "举报提交失败，请稍后再试" }, 500);
  }
  if (!row) return jsonResp({ ok: false, msg: "评论不存在" }, 404);
  const postId = toId(row.post_id);

  // 2) 幂等：同一指纹对同一评论已有待处理举报 → 直接成功，不重复插入
  try {
    const dup = await db.prepare(
      "SELECT id FROM comment_reports WHERE comment_id = ?1 AND client_key = ?2 AND status = 0 LIMIT 1"
    ).bind(id, clientKey).first();
    if (dup) return jsonResp({ ok: true, msg: "已收到你的举报，我们会尽快处理" });
  } catch (e) {
    // 扩展表未创建等情况：不阻断，交给下面插入的 catch 统一兜底
  }

  const ipHash = await sha256Hex(clientIp(request));
  try {
    await db.prepare(
      "INSERT INTO comment_reports (comment_id, post_id, reason, detail, client_key, ip_hash, " +
      "status, handled_by, handled_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, 0, ?7)"
    ).bind(id, postId, reason, detail, clientKey, ipHash, nowMs()).run();
  } catch (e) {
    return jsonResp({ ok: false, msg: "举报功能暂不可用，请稍后再试（" + errText(e) + "）" }, 500);
  }
  return jsonResp({ ok: true, msg: "举报已提交，感谢反馈" });
}

/* ------------------------------------------------------------------ */
/* 3. 后台：批量审核 / 批量删除（FR-X19）                                */
/* ------------------------------------------------------------------ */

/** POST /api/admin/comments/bulk   body: { ids:[], action:"approve"|"reject"|"delete", note? } */
export async function handleAdminCommentsBulk(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true });
  if (!isAdminRole(me)) return noPerm();
  if (request.method !== "POST") return jsonResp({ ok: false, msg: "仅支持 POST" }, 405);
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const body = await readJson(request);
  const action = String(body.action === null || body.action === undefined ? "" : body.action).toLowerCase();
  const note = clip(body.note !== undefined ? body.note : body.remark, 200).trim();
  if (action !== "approve" && action !== "reject" && action !== "delete") {
    return jsonResp({ ok: false, msg: "未知操作：" + clip(action, 20) }, 400);
  }
  const ids = normIds(body.ids);
  if (!ids.length) return jsonResp({ ok: false, msg: "未选择评论" });

  // 动态占位符（本模块唯一允许的动态 SQL）：?1,?2,... 与 ids 一一对应
  const ph = ids.map((_, i) => "?" + (i + 1)).join(",");
  let sql = "";
  if (action === "approve") sql = "UPDATE comments SET status = 1 WHERE id IN (" + ph + ")";
  else if (action === "reject") sql = "UPDATE comments SET status = 0 WHERE id IN (" + ph + ")";
  else sql = "DELETE FROM comments WHERE id IN (" + ph + ")";

  let affected = 0;
  try {
    const info = await db.prepare(sql).bind(...ids).run();
    affected = numOr(info && info.meta && info.meta.changes, ids.length);
  } catch (e) {
    return jsonResp({ ok: false, msg: "操作失败：" + errText(e) }, 500);
  }

  await writeAudit(db, {
    me: me,
    request: request,
    action: "comment.bulk." + action,
    target: clip(ids.join(","), 200),
    detail: clip((note ? "note=" + note + " " : "") + "affected=" + affected, 300),
  });

  const suffix = action === "delete" ? "（物理删除，不可恢复）" : "";
  return jsonResp({
    ok: true,
    msg: "已处理 " + affected + " 条" + suffix,
    data: { affected: affected, action: action },
  });
}

/* ------------------------------------------------------------------ */
/* 4. 后台：举报处理（FR-X20 / FR-X21）                                 */
/* ------------------------------------------------------------------ */

/** GET|POST /api/admin/comments/report */
export async function handleAdminReports(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true });
  if (!isAdminRole(me)) return noPerm();
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);
  let url = null;
  try {
    url = new URL(request.url);
  } catch (e) {
    url = null;
  }

  // ---- GET：待处理举报列表（默认 50 条，JOIN 评论摘要）----
  if (request.method === "GET") {
    const limit = clampLimit(url ? url.searchParams.get("limit") : 0, 50, 200);
    try {
      const rows = await db.prepare(
        "SELECT r.id, r.comment_id, r.post_id, r.reason, r.detail, r.status, r.created_at, " +
        "substr(c.content, 1, 80) AS content, c.author AS author, c.page_id AS page_id " +
        "FROM comment_reports r LEFT JOIN comments c ON c.id = r.comment_id " +
        "WHERE r.status = 0 ORDER BY r.id DESC LIMIT ?1"
      ).bind(limit).all();
      return jsonResp({ ok: true, data: rows.results || [] });
    } catch (e) {
      return jsonResp({ ok: true, data: [], note: "扩展表未创建" });
    }
  }

  if (request.method !== "POST") return jsonResp({ ok: false, msg: "仅支持 GET/POST" }, 405);

  // ---- POST：{ id, status:1|2, note?, hide? } ----
  const body = await readJson(request);
  const id = toId(body.id);
  const status = parseInt(body.status, 10);
  const note = clip(body.note !== undefined ? body.note : body.remark, 200).trim();
  const hide = body.hide === true;
  if (!id) return jsonResp({ ok: false, msg: "缺少举报 id" }, 400);
  if (status !== 1 && status !== 2) {
    return jsonResp({ ok: false, msg: "status 只能是 1（举报成立）或 2（忽略）" }, 400);
  }

  let commentId = 0;
  try {
    const row = await db.prepare("SELECT comment_id FROM comment_reports WHERE id = ?1").bind(id).first();
    if (!row) return jsonResp({ ok: false, msg: "举报记录不存在" }, 404);
    commentId = toId(row.comment_id);
  } catch (e) {
    return jsonResp({ ok: false, msg: "扩展表未创建" }, 500);
  }

  let hidden = false;
  try {
    await db.prepare(
      "UPDATE comment_reports SET status = ?1, handled_by = ?2, handled_at = ?3 WHERE id = ?4"
    ).bind(status, toId(me.id), nowMs(), id).run();
    // 举报成立且显式 hide=true 时才隐藏评论，避免误伤
    if (status === 1 && hide && commentId) {
      await db.prepare("UPDATE comments SET status = 0 WHERE id = ?1").bind(commentId).run();
      hidden = true;
    }
  } catch (e) {
    return jsonResp({ ok: false, msg: "处理失败：" + errText(e) }, 500);
  }

  await writeAudit(db, {
    me: me,
    request: request,
    action: "comment.report.handle",
    target: "report:" + id,
    detail: clip("status=" + status + " comment_id=" + commentId + (hide ? " hide=1" : "") +
      (note ? " note=" + note : ""), 300),
  });
  return jsonResp({
    ok: true,
    msg: status === 1 ? "举报已处理" : "举报已忽略",
    data: { id: id, status: status, comment_id: commentId, hidden: hidden },
  });
}

/* ------------------------------------------------------------------ */
/* 5. 后台：评论配置（FR-X19 先审后发开关）                              */
/* ------------------------------------------------------------------ */

/** GET|POST /api/admin/settings/comment */
export async function handleAdminCommentSettings(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true });
  if (!isAdminRole(me)) return noPerm();
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  if (request.method === "GET") {
    const cur = await readCommentSettings(env);
    return jsonResp({ ok: true, data: cur });
  }
  if (request.method !== "POST") return jsonResp({ ok: false, msg: "仅支持 GET/POST" }, 405);

  const body = await readJson(request);
  const cur = await readCommentSettings(env);
  const next = { moderate: cur.moderate, words: cur.words, linkLimit: cur.linkLimit };

  if (body.moderate !== undefined && body.moderate !== null) {
    next.moderate = body.moderate === true || body.moderate === 1 ||
      body.moderate === "1" || body.moderate === "true";
  }
  if (body.words !== undefined && body.words !== null) {
    // 兼容字符串（按换行/逗号/分号切分）与数组两种入参
    next.words = normWords(typeof body.words === "string" ? body.words.split(/[\n,，;；]+/) : body.words);
  }
  if (body.linkLimit !== undefined && body.linkLimit !== null) {
    next.linkLimit = clampLink(body.linkLimit);
  }

  try {
    await db.prepare(
      "INSERT INTO settings (key, value) VALUES ('comment', ?1) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(JSON.stringify(next)).run();
  } catch (e) {
    return jsonResp({ ok: false, msg: "保存失败：" + errText(e) }, 500);
  }

  await writeAudit(db, {
    me: me,
    request: request,
    action: "comment.settings",
    target: "comment",
    detail: JSON.stringify(next),
  });
  return jsonResp({ ok: true, msg: "评论设置已保存", data: next });
}

/* ------------------------------------------------------------------ */
/* 6. 后台：黑名单 CRUD（FR-X20）                                       */
/* ------------------------------------------------------------------ */

/** GET|POST|DELETE /api/admin/comment-blacklist */
export async function handleAdminBlacklist(request, env, me) {
  if (request.method === "OPTIONS") {
    return jsonResp({ ok: true }, 200, DEL_HEADERS);
  }
  if (!isAdminRole(me)) return noPerm();
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const method = String(request.method || "GET").toUpperCase();
  let url = null;
  try {
    url = new URL(request.url);
  } catch (e) {
    url = null;
  }
  const body = method === "GET" ? {} : await readJson(request);
  const wantDelete = method === "DELETE" ||
    String(body.action !== undefined ? body.action : (body.op || "")).toLowerCase() === "delete";

  // ---- GET：列出全部（默认 / 最多 200 条，按 id 倒序）----
  if (method === "GET") {
    const limit = clampLimit(url ? url.searchParams.get("limit") : 0, 200, 200);
    try {
      const rows = await db.prepare(
        "SELECT id, type, value, reason, status, expire_at, created_at FROM comment_blacklist " +
        "ORDER BY id DESC LIMIT ?1"
      ).bind(limit).all();
      return jsonResp({ ok: true, data: rows.results || [] });
    } catch (e) {
      return jsonResp({ ok: true, data: [], note: "扩展表未创建" });
    }
  }

  // ---- DELETE：真删（?id=1 或 body.id；也支持 POST {action:"delete", id}）----
  if (wantDelete) {
    const id = toId(body.id !== undefined ? body.id : (url ? url.searchParams.get("id") : 0));
    if (!id) return jsonResp({ ok: false, msg: "缺少 id" }, 400, DEL_HEADERS);
    try {
      const row = await db.prepare("SELECT id FROM comment_blacklist WHERE id = ?1").bind(id).first();
      if (!row) return jsonResp({ ok: false, msg: "记录不存在" }, 404, DEL_HEADERS);
      await db.prepare("DELETE FROM comment_blacklist WHERE id = ?1").bind(id).run();
    } catch (e) {
      return jsonResp({ ok: false, msg: "删除失败：" + errText(e) }, 500, DEL_HEADERS);
    }
    await writeAudit(db, {
      me: me, request: request, action: "comment.blacklist.delete",
      target: "blacklist:" + id, detail: "",
    });
    return jsonResp({ ok: true, msg: "已删除" }, 200, DEL_HEADERS);
  }

  // ---- POST：新增或（同 type+value）更新 ----
  if (method === "POST") {
    const type = clip(body.type, 20).trim().toLowerCase();
    const value = clip(body.value, 200).trim();
    const reason = clip(body.reason, 200).trim();
    if (BL_TYPES.indexOf(type) < 0) {
      return jsonResp({ ok: false, msg: "type 只能是 " + BL_TYPES.join(" / ") }, 400);
    }
    if (!value) return jsonResp({ ok: false, msg: "value 不能为空" }, 400);
    const expireAt = toExpireMs(body.expire_at !== undefined ? body.expire_at : body.expireAt);
    try {
      const ex = await db.prepare(
        "SELECT id FROM comment_blacklist WHERE type = ?1 AND value = ?2 LIMIT 1"
      ).bind(type, value).first();
      if (ex) {
        await db.prepare(
          "UPDATE comment_blacklist SET reason = ?1, expire_at = ?2, status = 1 WHERE id = ?3"
        ).bind(reason, expireAt, toId(ex.id)).run();
        await writeAudit(db, {
          me: me, request: request, action: "comment.blacklist.update",
          target: "blacklist:" + toId(ex.id), detail: clip(type + "=" + value, 300),
        });
        return jsonResp({
          ok: true, msg: "黑名单已更新",
          data: { id: toId(ex.id), type: type, value: value, expire_at: expireAt },
        });
      }
      const info = await db.prepare(
        "INSERT INTO comment_blacklist (type, value, reason, status, expire_at, created_at) " +
        "VALUES (?1, ?2, ?3, 1, ?4, ?5)"
      ).bind(type, value, reason, expireAt, nowMs()).run();
      const nid = toId(info && info.meta && info.meta.last_row_id);
      await writeAudit(db, {
        me: me, request: request, action: "comment.blacklist.create",
        target: "blacklist:" + nid, detail: clip(type + "=" + value, 300),
      });
      return jsonResp({
        ok: true, msg: "已加入黑名单",
        data: { id: nid, type: type, value: value, expire_at: expireAt },
      });
    } catch (e) {
      return jsonResp({ ok: false, msg: "保存失败：" + errText(e) }, 500);
    }
  }

  return jsonResp({ ok: false, msg: "不支持的方法：" + method }, 405, DEL_HEADERS);
}
