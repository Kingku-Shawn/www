/* ==================================================================
 * 清逸的博客 · 文章修订 / 定时发布 / 重定向 / 后台导出导入
 *      （worker/src/features/content.js）
 * 自包含模块：零依赖、零 import、导入时零副作用
 * ------------------------------------------------------------------
 * 对应《追加补充.md》：
 *   · FR-X9  —— 文章修订与定时发布：修订快照 / 历史列表 / 单条详情 / 回滚 / 定时发布
 *   · FR-X11 —— 重定向管理：后台维护 301/302/307/308；resolveRedirect 在静态兜底前挡旧链接
 *   · 后台导出 / 导入 —— GET /api/admin/export、POST /api/admin/import
 *
 * 硬约束（与 features/moderation.js 同一套）：
 *   1) 本模块不 import 任何模块（避免与 index.js 形成循环依赖），小工具全部内部自定义；
 *   2) 导入时无副作用：不查 D1、不发 fetch；D1 调用全程 try/catch，失败一律降级；
 *   3) 本模块 **不使用任何动态 SQL**（无 IN (...) 拼串），全部 ?n 参数化；
 *      逐条 DELETE 的写法同时避开「D1 单条 SQL 绑定参数上限 100」这条限制；
 *   4) 只用标准 Web API（URL / Headers / Response / crypto.getRandomValues / JSON / Date）；
 *   5) 每个 .bind() 的值都先归一化成 string | number | null —— D1 绑定 undefined / NaN 会直接抛错。
 *
 * 依赖的既有表（extend-schema.js / index.js ensureSchema 内建，本模块不建表、不改表）：
 *   posts(id, title, category_id, summary, content, status, is_top, views, source_file,
 *         created_at TEXT, updated_at TEXT, ... , published_at INTEGER, deleted_at INTEGER)
 *         ⚠ published_at / deleted_at 是 extend-schema.js 的 ALTER 增补列，未部署时定时发布自动降级
 *   article_revisions(id, post_id, title, summary, content, source_file, editor_id, note, created_at) 毫秒
 *   redirects(id, from_path, to_path, code, status, hits, created_at)
 *   tags(id, name UNIQUE, color) / post_tags(post_id, tag_id)
 *   columns(id, name UNIQUE, sort) / post_columns(post_id, column_id)
 *   audit_logs(id, user_id, action, target, method, path, ip, ua, detail, created_at)
 *
 * 由 index.js 接线的入口（精确片段见交付回报）：
 *   GET|POST|DELETE /api/admin/revisions → handleAdminRevisions(request, env, me)
 *   GET             /api/admin/export    → handleAdminExport(request, env, me)
 *   POST            /api/admin/import    → handleAdminImport(request, env, me)
 *   GET|POST|DELETE /api/admin/redirects → handleAdminRedirects(request, env, me)
 *   文章更新前                     → snapshotRevision(env, postId, editorId, note)
 *   后台 dashboard / 文章列表 GET  → applyScheduledPosts(env)
 *   fetch 静态兜底之前             → resolveRedirect(env, path)
 *
 * ⚠ me 是「已通过 adminAuth 鉴权」的后台用户对象（{id, username, role, ...}），
 *   本模块不重复鉴权，但每个写操作仍会校验 me.role，防止未来接线失误。
 * ================================================================== */

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 每篇文章最多保留的修订快照数 */
const REV_KEEP = 20;
/** 修订列表默认 / 最大条数 */
const REV_LIST_DEF = 50;
const REV_LIST_MAX = 200;
/** 快照 note / 其它短文本截断长度 */
const NOTE_MAX = 200;
/** 导出 / 导入单次处理上限（防超时） */
const EXPORT_MAX = 200;
const IMPORT_MAX = 200;
/** 导入错误明细最多回传条数 */
const ERR_MAX = 20;
/** 重定向一次最多列出条数 */
const REDIR_LIST_MAX = 200;
/** 允许的重定向状态码；非法值回落 301 */
const REDIR_CODES = [301, 302, 307, 308];
/** resolveRedirect 的模块级缓存 TTL（60 秒）与容量上限 */
const REDIR_TTL = 60000;
const REDIR_CACHE_MAX = 500;
/** 新建标签的默认颜色（与 index.js setPostLinks 一致） */
const TAG_COLOR = "#58a6ff";
/** DELETE 需要放行的方法头（跨域预检用；index.js 的默认值只有 GET, POST, OPTIONS） */
const DEL_HEADERS = { "access-control-allow-methods": "GET, POST, OPTIONS, DELETE" };

/* ------------------------------------------------------------------ */
/* 基础工具（与 index.js / moderation.js 同名函数同语义，但独立定义）     */
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

/** 非 JSON 响应（导出 Markdown 用）；头与 jsonResp 同源，只是 content-type 不同 */
function textResp(text, contentType, extraHeaders) {
  const headers = {
    "content-type": contentType || "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, X-Token",
  };
  const extra = extraHeaders || {};
  for (const k in extra) headers[k] = extra[k];
  return new Response(String(text === null || text === undefined ? "" : text), { status: 200, headers });
}

function nowMs() {
  return Date.now();
}

/** String(...) + 长度截断：杜绝 undefined.includes 之类的崩溃 */
function clip(v, n) {
  const s = v === null || v === undefined ? "" : String(v);
  return s.length > n ? s.slice(0, n) : s;
}

/** 大正文字段：只做 String 归一化，不截断 */
function str(v) {
  return v === null || v === undefined ? "" : String(v);
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

/** 非负整数（views / status 之类的计数列） */
function toCount(v, d) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return d;
  return n;
}

/** 分页上限：非法 → 默认值，超限 → 上限 */
function clampLimit(v, def, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return n > max ? max : n;
}

function pathOf(request) {
  try {
    return new URL(request.url).pathname;
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

/**
 * 写库用的文本时间戳 "YYYY-MM-DD HH:MM:SS"。
 * 口径：**北京时间 UTC+8**（与 index.js 的 nowStr() 一致——后者已从 UTC 改为 UTC+8，
 *   因为博客面向中文用户，文章/评论的发布时间统一按北京时间展示与写入）。
 */
function nowStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
    " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds());
}

/**
 * 毫秒时间戳 → "YYYY-MM-DD HH:MM:SS"（**回显口径：北京时间 UTC+8**，只用于 created_text 等展示字段）。
 * 与上面的 nowStr()（写库口径 UTC）刻意分开：写库要跟既有数据一致，给人看的要跟人的时区一致。
 * 若希望回显也用 UTC，把下面 +8 的小时偏移改成 0 即可。
 */
function fmtMs(ms) {
  const n = numOr(ms, 0);
  if (!n) return "";
  const d = new Date(n + 8 * 3600 * 1000);
  const p = (x) => (x < 10 ? "0" + x : "" + x);
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
    " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds());
}

/** 随机 hex（source_file 用：a_ + 12 字节 hex + .html，与 index.js 既有规则一致） */
function hexOf(bytes) {
  const arr = bytes || new Uint8Array(12);
  let out = "";
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, "0");
  return out;
}

/** 生成文章标识：a_<24 位 hex>.html（crypto.getRandomValues；不可用时退化为时间戳 + Math.random） */
function newSourceFile() {
  try {
    if (globalThis.crypto && crypto.getRandomValues) {
      return "a_" + hexOf(crypto.getRandomValues(new Uint8Array(12))) + ".html";
    }
  } catch (e) { /* 落到下面的降级分支 */ }
  const rnd = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return "a_" + (Date.now().toString(16) + rnd).slice(0, 24) + ".html";
}

/** 是否具备内容管理权限（super_admin / admin） */
function isAdminRole(me) {
  return !!me && (me.role === "super_admin" || me.role === "admin");
}

function noPerm() {
  return jsonResp({ ok: false, msg: "权限不足" }, 403);
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "0.0.0.0";
}

function uaOf(request) {
  return clip(request.headers.get("user-agent") || "", 200);
}

/** 取 URL 参数（解析失败一律 null） */
function qsOf(request, key) {
  try {
    const u = new URL(request.url);
    const v = u.searchParams.get(key);
    return v === null || v === "" ? null : v;
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 审计日志（best-effort，失败不影响主流程）                             */
/* ------------------------------------------------------------------ */

/** 列顺序：user_id, action, target, method, path, ip, ua, detail, created_at（共 9 个绑定） */
async function writeAudit(db, request, me, action, target, detail) {
  try {
    if (!db) return false;
    await db.prepare(
      "INSERT INTO audit_logs (user_id, action, target, method, path, ip, ua, detail, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
    ).bind(
      toId(me && me.id),
      clip(action, 80),
      clip(target, 200),
      clip(request && request.method, 10),
      clip(pathOf(request), 200),
      clip(request ? clientIp(request) : "", 64),
      clip(request ? uaOf(request) : "", 200),
      clip(detail, 300),
      nowMs()
    ).run();
    return true;
  } catch (e) {
    return false;
  }
}

/* ================================================================== */
/* FR-X9-1 文章修订快照                                                */
/* ================================================================== */

/**
 * 清理某篇文章的历史快照，只保留最近 REV_KEEP(20) 个。
 * 写法说明（为什么不写成 DELETE ... WHERE id NOT IN (SELECT ... LIMIT 20)）：
 *   1) 「子查询 + LIMIT 参与删除」在不同 SQLite/D1 版本上的执行细节不完全一致，
 *      而「先查 id、再按 id 删」是任何版本都成立的确定写法；
 *   2) 逐条 DELETE 每次只绑定 1 个参数，天然避开 D1「单条 SQL 最多 100 个绑定参数」的上限；
 *   3) 最多循环 6 轮（单轮 50 条，共可清理 300 条积压），异常数据也不会死循环。
 * @returns {Promise<number>} 实际删除条数（失败向上抛，由调用方决定是否忽略）
 */
async function trimRevisions(db, postId) {
  let removed = 0;
  for (let round = 0; round < 6; round++) {
    const rows = await db.prepare(
      "SELECT id FROM article_revisions WHERE post_id = ?1 ORDER BY id DESC LIMIT 50 OFFSET ?2"
    ).bind(postId, REV_KEEP).all();
    const ids = (rows && rows.results ? rows.results : []).map((r) => toId(r && r.id)).filter(Boolean);
    if (!ids.length) break;
    for (let i = 0; i < ids.length; i++) {
      await db.prepare("DELETE FROM article_revisions WHERE id = ?1").bind(ids[i]).run();
    }
    removed += ids.length;
    if (ids.length < 50) break;
  }
  return removed;
}

/**
 * 给文章当前内容存一份修订快照（由 index.js 在「文章更新前」调用）。
 * ⚠ 失败绝不抛错：文章更新主流程不能被修订功能拖死。
 * @param {object} env
 * @param {number} postId    文章 id
 * @param {number} editorId  编辑者（me.id），由调用方给
 * @param {string} note      备注（截断 200）
 * @returns {Promise<{ok:boolean,id?:number,note?:string}>}
 */
export async function snapshotRevision(env, postId, editorId, note) {
  const db = env && env.DB;
  const pid = toId(postId);
  if (!db || !pid) return { ok: false };
  let row = null;
  try {
    row = await db.prepare(
      "SELECT title, summary, content, source_file FROM posts WHERE id = ?1"
    ).bind(pid).first();
  } catch (e) {
    return { ok: false, note: "查询文章失败" };
  }
  if (!row) return { ok: false, note: "文章不存在" };

  let newId = 0;
  try {
    const info = await db.prepare(
      "INSERT INTO article_revisions (post_id, title, summary, content, source_file, editor_id, note, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
    ).bind(
      pid,
      clip(row.title, 500),
      clip(row.summary, 2000),
      str(row.content),
      clip(row.source_file, 200),
      toId(editorId),
      clip(note, NOTE_MAX),
      nowMs()
    ).run();
    newId = toId(info && info.meta && info.meta.last_row_id);
  } catch (e) {
    // article_revisions 未创建（扩展表未部署）等：静默降级
    return { ok: false, note: "扩展表未创建" };
  }

  // 保留最近 20 个快照：清理失败只影响快照数量，不能影响本次快照与文章更新
  try {
    await trimRevisions(db, pid);
  } catch (e) { /* 留给下一次快照继续清理 */ }
  return { ok: true, id: newId };
}

/* ================================================================== */
/* FR-X9-2 后台：修订列表 / 详情 / 回滚 / 删除                          */
/* ================================================================== */

/** 修订列表行 → 对外结构（不返回 content 全文，只给 size） */
function revRow(r) {
  const o = r || {};
  return {
    id: toId(o.id),
    post_id: toId(o.post_id),
    title: clip(o.title, 200),
    note: clip(o.note, NOTE_MAX),
    editor_id: toId(o.editor_id),
    created_at: numOr(o.created_at, 0),
    created_text: fmtMs(o.created_at),
    size: numOr(o.size, 0),
  };
}

/** GET|POST|DELETE /api/admin/revisions */
export async function handleAdminRevisions(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true }, 200, DEL_HEADERS);
  if (!isAdminRole(me)) return noPerm();
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500, DEL_HEADERS);
  const method = String(request.method || "GET").toUpperCase();

  // ---- GET：?id= 取单条详情（含 content 全文）/ ?post_id= 过滤列表 / ?post_id=X&current=1 取当前线上内容 ----
  if (method === "GET") {
    const id = toId(qsOf(request, "id"));
    if (id) {
      try {
        const row = await db.prepare(
          "SELECT id, post_id, title, summary, content, source_file, editor_id, note, created_at " +
          "FROM article_revisions WHERE id = ?1"
        ).bind(id).first();
        if (!row) return jsonResp({ ok: false, msg: "快照不存在" }, 404, DEL_HEADERS);
        const data = revRow({ ...row, size: str(row.content).length });
        data.summary = clip(row.summary, 2000);
        data.content = str(row.content);
        data.source_file = clip(row.source_file, 200);
        return jsonResp({ ok: true, data: data }, 200, DEL_HEADERS);
      } catch (e) {
        return jsonResp({ ok: true, data: null, note: "扩展表未创建" }, 200, DEL_HEADERS);
      }
    }

    // FR-X9 版本对比：?post_id=X&current=1 → 返回该文章「当前线上内容」（伪快照，id=0）
    const postIdCurrent = toId(qsOf(request, "post_id"));
    if (postIdCurrent && String(qsOf(request, "current") || "") === "1") {
      try {
        const row = await db.prepare(
          "SELECT id, title, summary, content, updated_at FROM posts WHERE id = ?1"
        ).bind(postIdCurrent).first();
        if (!row) return jsonResp({ ok: false, msg: "文章不存在" }, 404, DEL_HEADERS);
        return jsonResp({
          ok: true,
          data: {
            id: 0, post_id: postIdCurrent, title: str(row.title), note: "当前线上内容",
            editor_id: 0, created_at: 0, created_text: str(row.updated_at),
            size: str(row.content).length, summary: clip(row.summary, 2000),
            content: str(row.content), source_file: "",
          },
        }, 200, DEL_HEADERS);
      } catch (e) {
        return jsonResp({ ok: false, msg: "读取当前内容失败" }, 500, DEL_HEADERS);
      }
    }

    const postId = toId(qsOf(request, "post_id"));
    const limit = clampLimit(qsOf(request, "limit"), REV_LIST_DEF, REV_LIST_MAX);
    try {
      // size 用 SQL 侧 length() 算，避免把正文全文拉回 Worker（省内存、省传输）。
      // post_id 过滤：SQL 恒定不变（无拼串），未传时把 postId 绑两次 0 即全量。
      // ⚠ 这里刻意写成 ?1 / ?2 两个不同的占位符（而不是让 ?1 出现两次），
      //   以免对「同名占位符复用」的绑定行为产生任何依赖。
      const rows = await db.prepare(
        "SELECT id, post_id, title, note, editor_id, created_at, length(content) AS size " +
        "FROM article_revisions WHERE (?1 = 0 OR post_id = ?2) ORDER BY id DESC LIMIT ?3"
      ).bind(postId, postId, limit).all();
      return jsonResp({
        ok: true,
        data: (rows && rows.results ? rows.results : []).map(revRow),
      }, 200, DEL_HEADERS);
    } catch (e) {
      return jsonResp({ ok: true, data: [], note: "扩展表未创建" }, 200, DEL_HEADERS);
    }
  }

  // ---- POST：{action:"restore"|"delete", id} ----
  if (method === "POST") {
    const body = await readJson(request);
    const action = String(body.action === null || body.action === undefined ? "" : body.action).toLowerCase();
    const id = toId(body.id);
    if (action === "restore") return restoreRevision(request, db, me, id);
    if (action === "delete") return deleteRevision(request, db, me, id);
    return jsonResp({ ok: false, msg: "未知操作：" + clip(action, 20) }, 400, DEL_HEADERS);
  }

  // ---- DELETE：body {id} 或 ?id= ----
  if (method === "DELETE") {
    const body = await readJson(request);
    const id = toId(body.id) || toId(qsOf(request, "id"));
    return deleteRevision(request, db, me, id);
  }

  return jsonResp({ ok: false, msg: "仅支持 GET/POST/DELETE" }, 405, DEL_HEADERS);
}

/**
 * 回滚到某个快照。
 * 关键防误操作：**先把 posts 当前内容再存一份快照**，这样「回滚」本身也可再回滚。
 * 不修改 source_file（它是文章 URL 身份，改了会断链）。
 */
async function restoreRevision(request, db, me, revId) {
  if (!revId) return jsonResp({ ok: false, msg: "缺少快照 id" }, 400, DEL_HEADERS);
  let rev = null;
  try {
    rev = await db.prepare(
      "SELECT id, post_id, title, summary, content FROM article_revisions WHERE id = ?1"
    ).bind(revId).first();
  } catch (e) {
    return jsonResp({ ok: false, msg: "扩展表未创建" }, 500, DEL_HEADERS);
  }
  if (!rev) return jsonResp({ ok: false, msg: "快照不存在" }, 404, DEL_HEADERS);
  const pid = toId(rev.post_id);
  if (!pid) return jsonResp({ ok: false, msg: "快照未关联文章" }, 400, DEL_HEADERS);

  // 1) 回滚前的自动备份（note 显式标明来源，便于在列表里识别）
  await snapshotRevision(envOf(db), pid, toId(me && me.id), "回滚前自动备份（快照 #" + revId + "）");

  // 2) 覆盖 posts：updated_at 用 nowStr() 的 "YYYY-MM-DD HH:MM:SS"（UTC，口径同 index.js）
  try {
    await db.prepare(
      "UPDATE posts SET title = ?1, summary = ?2, content = ?3, updated_at = ?4 WHERE id = ?5"
    ).bind(
      clip(rev.title, 500),
      clip(rev.summary, 2000),
      str(rev.content),
      nowStr(),
      pid
    ).run();
  } catch (e) {
    return jsonResp({ ok: false, msg: "回滚失败：" + errText(e) }, 500, DEL_HEADERS);
  }

  await writeAudit(db, request, me, "post.revision.restore", "post:" + pid,
    clip("revision=" + revId + " title=" + clip(rev.title, 80), 300));
  return jsonResp({
    ok: true,
    msg: "已回滚到该版本",
    data: { post_id: pid, revision_id: revId },
  }, 200, DEL_HEADERS);
}

/** 删除单个快照 */
async function deleteRevision(request, db, me, revId) {
  if (!revId) return jsonResp({ ok: false, msg: "缺少快照 id" }, 400, DEL_HEADERS);
  try {
    const row = await db.prepare(
      "SELECT id, post_id, title FROM article_revisions WHERE id = ?1"
    ).bind(revId).first();
    if (!row) return jsonResp({ ok: false, msg: "快照不存在" }, 404, DEL_HEADERS);
    await db.prepare("DELETE FROM article_revisions WHERE id = ?1").bind(revId).run();
    await writeAudit(db, request, me, "post.revision.delete", "revision:" + revId,
      clip("post_id=" + toId(row.post_id) + " title=" + clip(row.title, 80), 300));
  } catch (e) {
    return jsonResp({ ok: false, msg: "删除失败：" + errText(e) }, 500, DEL_HEADERS);
  }
  return jsonResp({ ok: true, msg: "快照已删除" }, 200, DEL_HEADERS);
}

/**
 * 把 db 包一层假的 env 传给 snapshotRevision（该函数签名是 env，内部只取 env.DB）。
 * 只有一个键，成本可忽略；好处是快照逻辑只有一份实现，不会分叉。
 */
function envOf(db) {
  return { DB: db };
}

/* ================================================================== */
/* FR-X9-3 定时发布                                                    */
/* ================================================================== */

/**
 * 把到期的定时文章置为已发布（status=1）。
 * 建议在后台 dashboard 分支 或 后台文章列表 GET 开头调用（低频、幂等，无需 cron）。
 * @returns {Promise<{ok:boolean,published:number,note?:string}>}
 */
export async function applyScheduledPosts(env) {
  const db = env && env.DB;
  if (!db) return { ok: false, published: 0, note: "数据库未绑定" };
  try {
    const info = await db.prepare(
      "UPDATE posts SET status = 1 WHERE status = 0 AND published_at > 0 " +
      "AND published_at <= ?1 AND deleted_at = 0"
    ).bind(nowMs()).run();
    const n = toCount(info && info.meta && info.meta.changes, 0);
    return { ok: true, published: n };
  } catch (e) {
    // published_at / deleted_at 未部署（ALTER 未执行）时会走到这里：静默降级
    return { ok: false, published: 0, note: errText(e) };
  }
}

/**
 * 设置/取消定时发布（供后台「定时发布」表单项调用）。
 * publishAtMs <= 0 → 只把文章转为草稿（status=0）且清掉定时；
 * publishAtMs > 0  → status=0 + published_at=毫秒；到期由 applyScheduledPosts 转正。
 * published_at 是 INTEGER 毫秒列（口径见《数据库设计文档.md》§3.17.1）。
 */
export async function schedulePost(env, postId, publishAtMs) {
  const db = env && env.DB;
  const pid = toId(postId);
  if (!db || !pid) return { ok: false, msg: "参数不合法" };
  const at = numOr(publishAtMs, 0);
  const ts = Number.isFinite(at) && at > 0 ? Math.trunc(at) : 0;
  try {
    await db.prepare(
      "UPDATE posts SET status = 0, published_at = ?1 WHERE id = ?2"
    ).bind(ts, pid).run();
    return { ok: true, post_id: pid, published_at: ts };
  } catch (e) {
    return { ok: false, msg: "定时设置失败：" + errText(e) };
  }
}

/* ================================================================== */
/* 后台导出（GET /api/admin/export）                                   */
/* ================================================================== */

/** YAML 双引号字符串：转义 \ 与 "，并把换行压成空格（front-matter 必须单行） */
function yamlStr(v) {
  const s = str(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
  return '"' + s + '"';
}

/** YAML 里的日期类裸标量：压掉换行；空值写成 ""，避免出现 `date:` 空标量 */
function yamlRaw(v) {
  const s = str(v).replace(/[\r\n]+/g, " ").trim();
  return s ? s : '""';
}

/** 名称数组 → YAML 流式数组 `[a, b]`；元素含 YAML 敏感字符（, " [ ] # : { }）时用双引号包裹 */
function yamlList(items) {
  const list = Array.isArray(items) ? items : [];
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    const s = str(list[i]).replace(/[\r\n]+/g, " ").trim();
    if (!s) continue;
    parts.push(/[,"\[\]#:{}]/.test(s) ? yamlStr(s) : s);
  }
  return "[" + parts.join(", ") + "]";
}

/**
 * 一次性聚合 post_id → [name]（两次查询搞定，不做逐篇子查询）。
 * singleId 有值时按 post_id 过滤（只绑定 1 个参数），否则全量聚合（与 index.js 的
 * `/api/posts` GET 同口径；不按 200 个 id 做 IN 过滤是为了避开 D1 的 100 绑定参数上限）。
 */
async function aggNames(db, sqlAll, sqlOne, singleId) {
  const map = new Map();
  try {
    const rows = singleId
      ? await db.prepare(sqlOne).bind(singleId).all()
      : await db.prepare(sqlAll).all();
    const list = rows && rows.results ? rows.results : [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i] || {};
      const pid = toId(r.post_id);
      const name = clip(r.name, 60);
      if (!pid || !name) continue;
      if (!map.has(pid)) map.set(pid, []);
      map.get(pid).push(name);
    }
  } catch (e) { /* tags/columns 表异常：导出照常，名称留空数组 */ }
  return map;
}

/** 一篇（或多篇）文章 → Markdown 文本（YAML front-matter + 正文 HTML 原样） */
function toMarkdown(rows, tagMap, colMap) {
  const parts = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const pid = toId(r.id);
    parts.push(
      "---\n" +
      "title: " + yamlStr(r.title) + "\n" +
      "date: " + yamlRaw(r.created_at) + "\n" +
      "updated: " + yamlRaw(r.updated_at) + "\n" +
      "source_file: " + yamlStr(r.source_file) + "\n" +
      "tags: " + yamlList(tagMap.get(pid) || []) + "\n" +
      "columns: " + yamlList(colMap.get(pid) || []) + "\n" +
      "---\n\n" +
      str(r.content) + "\n\n---\n\n"
    );
  }
  return parts.join("");
}

/**
 * GET /api/admin/export（兼容 POST：参数可放 query，也可放 JSON body）
 * 参数：format=json|markdown（默认 json）、id=<单篇>、all=1（全量，上限 200 篇）
 * 说明：不传 id 也不传 all 时按「全量（≤200 篇）」处理，避免误以为导出空文件。
 * ⚠ 只导出 posts 的基础列 + tags/columns，绝不触碰 uploads.data_b64 之类的二进制字段。
 * 返回的 json：{ok:true,data:[{id,title,summary,content,source_file,created_at,updated_at,
 *                          status,is_top,views,tags:[],columns:[]}]}
 */
export async function handleAdminExport(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true });
  if (!isAdminRole(me)) return noPerm();
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const method = String(request.method || "GET").toUpperCase();
  let body = {};
  if (method !== "GET" && method !== "HEAD") body = await readJson(request);
  const arg = (k) => {
    const v = qsOf(request, k);
    if (v !== null && v !== undefined) return v;
    return body[k];
  };

  const format = String(arg("format") || "json").toLowerCase();
  const singleId = toId(arg("id"));
  const rawAll = String(arg("all") === undefined || arg("all") === null ? "" : arg("all")).toLowerCase();
  const wantAll = rawAll === "1" || rawAll === "true" || rawAll === "yes" || !singleId;
  if (format !== "json" && format !== "markdown" && format !== "md") {
    return jsonResp({ ok: false, msg: "format 只能是 json 或 markdown" }, 400);
  }

  // ---- 取数据（基础列，全部是 posts 的既有列，不依赖任何 ALTER 增补列）----
  let rows = [];
  let totalRows = 0;
  try {
    if (!wantAll && singleId) {
      const one = await db.prepare(
        "SELECT id, title, summary, content, source_file, created_at, updated_at, status, is_top, views " +
        "FROM posts WHERE id = ?1"
      ).bind(singleId).first();
      if (!one) return jsonResp({ ok: false, msg: "文章不存在" }, 404);
      rows = [one];
      totalRows = 1;
    } else {
      const rs = await db.prepare(
        "SELECT id, title, summary, content, source_file, created_at, updated_at, status, is_top, views " +
        "FROM posts ORDER BY id DESC LIMIT ?1"
      ).bind(EXPORT_MAX).all();
      rows = rs && rs.results ? rs.results : [];
      totalRows = rows.length;
      // 再取一次总数，只为了把 truncated 报准（拿不到就按「打满上限」保守判断）
      try {
        const c = await db.prepare("SELECT COUNT(*) AS c FROM posts").first();
        totalRows = toCount(c && c.c, rows.length);
      } catch (e) { /* 忽略，沿用 rows.length */ }
    }
  } catch (e) {
    return jsonResp({ ok: false, msg: "导出失败：" + errText(e) }, 500);
  }

  // ---- tags / columns：两次聚合查询做映射（单篇时只查该篇）----
  const oneId = rows.length === 1 ? toId(rows[0].id) : 0;
  const tagMap = await aggNames(db,
    "SELECT pt.post_id, t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id ORDER BY t.id",
    "SELECT pt.post_id, t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = ?1 ORDER BY t.id",
    oneId);
  const colMap = await aggNames(db,
    "SELECT pc.post_id, c.name FROM post_columns pc JOIN columns c ON c.id = pc.column_id ORDER BY c.id",
    "SELECT pc.post_id, c.name FROM post_columns pc JOIN columns c ON c.id = pc.column_id WHERE pc.post_id = ?1 ORDER BY c.id",
    oneId);

  await writeAudit(db, request, me, "post.export", "format:" + format,
    clip("count=" + rows.length + (singleId ? " id=" + singleId : " all=1"), 300));

  // ---- markdown：整文件下载 ----
  if (format === "markdown" || format === "md") {
    const md = toMarkdown(rows, tagMap, colMap);
    const date = nowStr().slice(0, 10);
    return textResp(md, "text/markdown; charset=utf-8", {
      "content-disposition": 'attachment; filename="posts-' + date + '.md"',
    });
  }

  // ---- json ----
  const data = rows.map((r) => {
    const pid = toId(r.id);
    return {
      id: pid,
      title: str(r.title),
      summary: str(r.summary),
      content: str(r.content),
      source_file: str(r.source_file),
      created_at: str(r.created_at),
      updated_at: str(r.updated_at),
      status: toCount(r.status, 1),
      is_top: toCount(r.is_top, 0),
      views: toCount(r.views, 0),
      tags: tagMap.get(pid) || [],
      columns: colMap.get(pid) || [],
    };
  });
  return jsonResp({
    ok: true,
    data: data,
    total: data.length,
    truncated: data.length < totalRows,
  });
}

/* ================================================================== */
/* 后台导入（POST /api/admin/import）                                  */
/* ================================================================== */

/** 名称集合 → id 集合；tagCache/colCache 为本次导入的进程内缓存（避免同名重复查库） */
async function linkTags(db, pid, tags, cache) {
  for (let i = 0; i < tags.length; i++) {
    const name = clip(tags[i], 30).replace(/^#/, "").trim();
    if (!name) continue;
    let tid = 0;
    if (cache.has(name)) {
      tid = cache.get(name);
    } else {
      const row = await db.prepare("SELECT id FROM tags WHERE name = ?1").bind(name).first();
      if (row) {
        tid = toId(row.id);
      } else {
        // 标签不存在则创建（color 默认 #58a6ff，与 index.js setPostLinks 一致）
        const info = await db.prepare(
          "INSERT INTO tags (name, color) VALUES (?1, ?2)"
        ).bind(name, TAG_COLOR).run();
        tid = toId(info && info.meta && info.meta.last_row_id);
      }
      cache.set(name, tid);
    }
    if (tid) {
      await db.prepare(
        "INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?1, ?2)"
      ).bind(pid, tid).run();
    }
  }
}

/** 名称（或数字 id）集合 → 专栏关联；专栏不存在则创建（columns.sort 默认 0） */
async function linkColumns(db, pid, columns, cache) {
  for (let i = 0; i < columns.length; i++) {
    const raw = columns[i];
    let cid = 0;
    // 兼容两种入参：数字/纯数字串 = 专栏 id；其它 = 专栏名称
    if (typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw.trim()))) {
      cid = toId(raw);
    } else {
      const name = clip(raw, 30).trim();
      if (!name) continue;
      if (cache.has(name)) {
        cid = cache.get(name);
      } else {
        const row = await db.prepare("SELECT id FROM columns WHERE name = ?1").bind(name).first();
        if (row) {
          cid = toId(row.id);
        } else {
          const info = await db.prepare(
            "INSERT INTO columns (name, sort) VALUES (?1, 0)"
          ).bind(name).run();
          cid = toId(info && info.meta && info.meta.last_row_id);
        }
        cache.set(name, cid);
      }
    }
    if (cid) {
      await db.prepare(
        "INSERT OR IGNORE INTO post_columns (post_id, column_id) VALUES (?1, ?2)"
      ).bind(pid, cid).run();
    }
  }
}

/**
 * 先删后插（思路参考 index.js 的 setPostLinks）。
 * ⚠ 两点刻意设计：
 *   1) 只有当对应字段**显式传了数组**时才动关联表：tags 没传就绝不清空既有标签，
 *      避免「只想改正文」的导入把标签洗掉；
 *   2) 关联表自身异常只吞掉：文章已经写入成功了，不能因为标签/专栏写失败就把这条记成 error
 *      （否则重试 create 会产生重复文章）。
 */
async function setImportLinks(db, pid, item, caches) {
  if (Array.isArray(item.tags)) {
    try {
      await db.prepare("DELETE FROM post_tags WHERE post_id = ?1").bind(pid).run();
      await linkTags(db, pid, item.tags, caches.tags);
    } catch (e) { /* 关联表异常：文章保留，标签跳过 */ }
  }
  if (Array.isArray(item.columns)) {
    try {
      await db.prepare("DELETE FROM post_columns WHERE post_id = ?1").bind(pid).run();
      await linkColumns(db, pid, item.columns, caches.cols);
    } catch (e) { /* 关联表异常：文章保留，专栏跳过 */ }
  }
}

/** 单条导入 → {created|updated|skipped|error}；抛错由调用方记进 errors */
async function importOne(db, item, mode, caches) {
  const title = clip(item.title, 200).trim();
  if (!title) return { kind: "error", msg: "缺少 title" };
  const summary = clip(item.summary, 2000);
  const content = str(item.content);
  // 更新模式不生成 source_file（否则会拿一个随机值去匹配，必然匹配不到还徒增困惑）
  let sourceFile = clip(item.source_file, 200).trim();
  if (!sourceFile && mode === "create") sourceFile = newSourceFile();
  const createdAt = clip(item.created_at, 40).trim() || nowStr();
  const updatedAt = clip(item.updated_at, 40).trim() || nowStr();
  const status = toCount(item.status, 1) ? 1 : 0;
  const isTop = toCount(item.is_top, 0) ? 1 : 0;
  const views = toCount(item.views, 0);
  const catId = item.category_id === null || item.category_id === undefined || item.category_id === ""
    ? null : toId(item.category_id);

  if (mode === "update") {
    // 匹配顺序：source_file 优先（导入导出的天然主键），其次 id
    let target = null;
    if (sourceFile) {
      target = await db.prepare("SELECT id FROM posts WHERE source_file = ?1").bind(sourceFile).first();
    }
    if (!target) {
      const fallbackId = toId(item.id);
      if (fallbackId) target = await db.prepare("SELECT id FROM posts WHERE id = ?1").bind(fallbackId).first();
    }
    if (!target) return { kind: "skipped", msg: "未匹配到文章（source_file / id 均无对应）" };
    const pid = toId(target.id);
    // 不覆盖 views（运行时统计）与 source_file（URL 身份），只更新内容类字段
    await db.prepare(
      "UPDATE posts SET title = ?1, summary = ?2, content = ?3, status = ?4, is_top = ?5, " +
      "updated_at = ?6 WHERE id = ?7"
    ).bind(title, summary, content, status, isTop, updatedAt, pid).run();
    await setImportLinks(db, pid, item, caches);
    return { kind: "updated", id: pid };
  }

  const info = await db.prepare(
    "INSERT INTO posts (title, category_id, summary, content, status, is_top, views, source_file, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
  ).bind(title, catId, summary, content, status, isTop, views, sourceFile, createdAt, updatedAt).run();
  const pid = toId(info && info.meta && info.meta.last_row_id);
  await setImportLinks(db, pid, item, caches);
  return { kind: "created", id: pid };
}

/**
 * POST /api/admin/import
 * body: { format:"json", data:[...], mode:"create"|"update" }（mode 默认 create）
 * - 每条必须有 title；source_file 为空时自动生成 a_<24 hex>.html
 * - 单条失败不影响其它条（逐条 try/catch，错误只记前 20 条）
 * - data 长度 > 200 → 只处理前 200 条，返回 truncated:true
 * 返回：{ok:true,data:{created,updated,skipped,errors:[{index,msg}],truncated}}
 */
export async function handleAdminImport(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true });
  if (!isAdminRole(me)) return noPerm();
  if (request.method !== "POST") return jsonResp({ ok: false, msg: "仅支持 POST" }, 405);
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const body = await readJson(request);
  const format = String(body.format || "json").toLowerCase();
  if (format !== "json") {
    return jsonResp({ ok: false, msg: "暂不支持 format=" + clip(format, 20) + "，目前只支持 json" }, 400);
  }
  const mode = String(body.mode || "create").toLowerCase();
  if (mode !== "create" && mode !== "update") {
    return jsonResp({ ok: false, msg: "mode 只能是 create 或 update" }, 400);
  }
  const all = Array.isArray(body.data) ? body.data : null;
  if (!all) return jsonResp({ ok: false, msg: "data 必须是数组" }, 400);
  const truncated = all.length > IMPORT_MAX;
  const list = truncated ? all.slice(0, IMPORT_MAX) : all;
  if (!list.length) return jsonResp({ ok: false, msg: "data 为空，没有可导入的内容" }, 400);

  const caches = { tags: new Map(), cols: new Map() };
  const errors = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== "object") {
      if (errors.length < ERR_MAX) errors.push({ index: i, msg: "元素不是对象" });
      continue;
    }
    try {
      // 计数口径：created/updated = 落库成功；skipped = update 模式匹配不到；errors = 校验失败 / 抛错
      const r = await importOne(db, item, mode, caches);
      if (r.kind === "created") created++;
      else if (r.kind === "updated") updated++;
      else if (r.kind === "skipped") {
        skipped++;
        if (errors.length < ERR_MAX) errors.push({ index: i, msg: clip(r.msg, 120) });
      } else {
        if (errors.length < ERR_MAX) errors.push({ index: i, msg: clip(r.msg, 120) });
      }
    } catch (e) {
      // 单条失败不影响其它条
      if (errors.length < ERR_MAX) errors.push({ index: i, msg: errText(e) });
    }
  }

  await writeAudit(db, request, me, "post.import", "mode:" + mode,
    clip("created=" + created + " updated=" + updated + " skipped=" + skipped +
      " errors=" + errors.length + (truncated ? " truncated=1" : ""), 300));

  return jsonResp({
    ok: true,
    msg: "导入完成：新增 " + created + " 篇，更新 " + updated + " 篇，跳过 " + skipped + " 篇",
    data: {
      created: created,
      updated: updated,
      skipped: skipped,
      errors: errors,
      truncated: truncated,
    },
  });
}

/* ================================================================== */
/* FR-X11 重定向管理                                                   */
/* ================================================================== */

/** 路径归一化：from_path 必须 "/" 开头；to_path 必须 "/" 或 "http" 开头 */
function normFromPath(v) {
  const s = clip(v, 300).trim();
  return s.startsWith("/") ? s : "";
}

function normToPath(v) {
  const s = clip(v, 500).trim();
  if (s.startsWith("/") || s.startsWith("http://") || s.startsWith("https://")) return s;
  return "";
}

function normCode(v) {
  const n = parseInt(v, 10);
  return REDIR_CODES.indexOf(n) >= 0 ? n : 301;
}

/** GET|POST|DELETE /api/admin/redirects */
export async function handleAdminRedirects(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true }, 200, DEL_HEADERS);
  if (!isAdminRole(me)) return noPerm();
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500, DEL_HEADERS);
  const method = String(request.method || "GET").toUpperCase();

  // ---- GET：全部（≤200，按 id 倒序），含 hits ----
  if (method === "GET") {
    const limit = clampLimit(qsOf(request, "limit"), REDIR_LIST_MAX, REDIR_LIST_MAX);
    try {
      const rows = await db.prepare(
        "SELECT id, from_path, to_path, code, status, hits, created_at FROM redirects " +
        "ORDER BY id DESC LIMIT ?1"
      ).bind(limit).all();
      return jsonResp({
        ok: true,
        data: (rows && rows.results ? rows.results : []).map((r) => ({
          id: toId(r.id),
          from_path: clip(r.from_path, 300),
          to_path: clip(r.to_path, 500),
          code: normCode(r.code),
          status: toCount(r.status, 1) ? 1 : 0,
          hits: toCount(r.hits, 0),
          created_at: numOr(r.created_at, 0),
          created_text: fmtMs(r.created_at),
        })),
      }, 200, DEL_HEADERS);
    } catch (e) {
      return jsonResp({ ok: true, data: [], note: "扩展表未创建" }, 200, DEL_HEADERS);
    }
  }

  // ---- DELETE：body {id} 或 ?id= ----
  if (method === "DELETE") {
    const body = await readJson(request);
    const id = toId(body.id) || toId(qsOf(request, "id"));
    if (!id) return jsonResp({ ok: false, msg: "缺少 id" }, 400, DEL_HEADERS);
    try {
      const row = await db.prepare("SELECT id, from_path FROM redirects WHERE id = ?1").bind(id).first();
      if (!row) return jsonResp({ ok: false, msg: "重定向不存在" }, 404, DEL_HEADERS);
      await db.prepare("DELETE FROM redirects WHERE id = ?1").bind(id).run();
      await writeAudit(db, request, me, "redirect.delete", "redirect:" + id,
        clip("from=" + clip(row.from_path, 200), 300));
    } catch (e) {
      return jsonResp({ ok: false, msg: "删除失败：" + errText(e) }, 500, DEL_HEADERS);
    }
    return jsonResp({ ok: true, msg: "重定向已删除" }, 200, DEL_HEADERS);
  }

  if (method !== "POST") return jsonResp({ ok: false, msg: "仅支持 GET/POST/DELETE" }, 405, DEL_HEADERS);

  // ---- POST：{id?, from_path, to_path, code?, status?}；from_path 重复则更新那条 ----
  const body = await readJson(request);
  const fromPath = normFromPath(body.from_path !== undefined ? body.from_path : body.from);
  const toPath = normToPath(body.to_path !== undefined ? body.to_path : body.to);
  if (!fromPath) return jsonResp({ ok: false, msg: "from_path 必须以 / 开头" }, 400, DEL_HEADERS);
  if (!toPath) return jsonResp({ ok: false, msg: "to_path 必须以 / 或 http 开头" }, 400, DEL_HEADERS);
  if (fromPath === toPath) return jsonResp({ ok: false, msg: "from_path 与 to_path 不能相同" }, 400, DEL_HEADERS);
  const code = normCode(body.code);
  const status = body.status === undefined || body.status === null
    ? 1 : (toCount(body.status, 1) ? 1 : 0);

  let existId = toId(body.id);
  try {
    if (existId) {
      const byId = await db.prepare("SELECT id FROM redirects WHERE id = ?1").bind(existId).first();
      if (!byId) existId = 0;
    }
    if (!existId) {
      const byFrom = await db.prepare(
        "SELECT id FROM redirects WHERE from_path = ?1 LIMIT 1"
      ).bind(fromPath).first();
      existId = toId(byFrom && byFrom.id);
    }

    if (existId) {
      await db.prepare(
        "UPDATE redirects SET from_path = ?1, to_path = ?2, code = ?3, status = ?4 WHERE id = ?5"
      ).bind(fromPath, toPath, code, status, existId).run();
      await writeAudit(db, request, me, "redirect.update", "redirect:" + existId,
        clip(fromPath + " -> " + toPath + " code=" + code + " status=" + status, 300));
      return jsonResp({
        ok: true, msg: "重定向已更新",
        data: { id: existId, from_path: fromPath, to_path: toPath, code: code, status: status },
      }, 200, DEL_HEADERS);
    }

    const info = await db.prepare(
      "INSERT INTO redirects (from_path, to_path, code, status, hits, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, 0, ?5)"
    ).bind(fromPath, toPath, code, status, nowMs()).run();
    const nid = toId(info && info.meta && info.meta.last_row_id);
    await writeAudit(db, request, me, "redirect.create", "redirect:" + nid,
      clip(fromPath + " -> " + toPath + " code=" + code + " status=" + status, 300));
    return jsonResp({
      ok: true, msg: "重定向已添加",
      data: { id: nid, from_path: fromPath, to_path: toPath, code: code, status: status },
    }, 200, DEL_HEADERS);
  } catch (e) {
    return jsonResp({ ok: false, msg: "保存失败：" + errText(e) }, 500, DEL_HEADERS);
  }
}

/* ================================================================== */
/* FR-X11 resolveRedirect（在静态兜底之前调用，必须极快且绝不抛错）       */
/* ================================================================== */

/**
 * 模块级缓存：path → { exp: 过期毫秒, val: {to_path,code} | null }
 * 目的：命中旧链接的请求不再每个都查 D1（60 秒内直接内存返回）。
 * 副作用说明：
 *   · 新增/修改重定向最多 60 秒后才在当前 isolate 生效（缓存未主动失效，保持实现简单）；
 *   · hits 只在「查库那一次」+1（缓存命中不写库），否则每次请求都写 D1 会造成写放大，
 *     反而抵消了这个缓存的意义；需要精确 hit 统计时把 TTL 调成 0 即可。
 *   · 容量超过 REDIR_CACHE_MAX 时整体清空（冷启动重建成本低，不需要 LRU）。
 */
const REDIR_CACHE = new Map();

function cacheGet(path, now) {
  const hit = REDIR_CACHE.get(path);
  if (!hit) return undefined;
  if (hit.exp <= now) {
    REDIR_CACHE.delete(path);
    return undefined;
  }
  return hit.val;
}

function cachePut(path, val, now) {
  if (REDIR_CACHE.size >= REDIR_CACHE_MAX) REDIR_CACHE.clear();
  REDIR_CACHE.set(path, { exp: now + REDIR_TTL, val: val });
}

/**
 * 命中重定向则返回 {to_path, code}，否则 null。
 * 调用位置：handleFetch 里、最后的 proxyStatic 兜底之前，且只对
 * 非 /api/、非 /admin 的路径调用（本函数内部也再挡一次，双保险）。
 * @param {object} env
 * @param {string} path  形如 "/old-page.html"
 */
export async function resolveRedirect(env, path) {
  try {
    const p = clip(path, 300).trim();
    if (!p || p.charAt(0) !== "/") return null;
    // 双保险：绝不把 API / 后台路径交出去（防止误配重定向劫持接口或暴露后台）
    if (p.startsWith("/api/") || p.startsWith("/api-v1/") || p === "/api" || p.startsWith("/admin")) {
      return null;
    }

    const now = nowMs();
    const cached = cacheGet(p, now);
    if (cached !== undefined) {
      return cached ? { to_path: cached.to_path, code: cached.code } : null;
    }

    const db = env && env.DB;
    if (!db) return null;
    const row = await db.prepare(
      "SELECT from_path, to_path, code FROM redirects WHERE status = 1 AND from_path = ?1 LIMIT 1"
    ).bind(p).first();
    if (!row) {
      cachePut(p, null, now);
      return null;
    }

    const toPath = clip(row.to_path, 500);
    // 目标非法（既不是站内绝对路径也不是 http(s)）时按未命中处理，避免开放重定向 / 死循环
    if (!toPath || (toPath.charAt(0) !== "/" && toPath.indexOf("http://") !== 0 && toPath.indexOf("https://") !== 0)) {
      cachePut(p, null, now);
      return null;
    }
    if (toPath === p) {
      cachePut(p, null, now);
      return null;
    }
    const code = normCode(row.code);
    const val = { to_path: toPath, code: code };
    cachePut(p, val, now);

    // hits 自增：best-effort，失败绝不影响跳转（按 from_path 命中，与查询同一条件）
    try {
      await db.prepare("UPDATE redirects SET hits = hits + 1 WHERE from_path = ?1").bind(p).run();
    } catch (e) { /* 忽略 */ }
    return { to_path: toPath, code: code };
  } catch (e) {
    return null;
  }
}
