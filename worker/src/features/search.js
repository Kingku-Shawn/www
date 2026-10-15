/* ============ 清逸的博客 · 全文搜索（FR-X5 / D-X1：D1 FTS5 优先，LIKE 兜底）============
 * 路由接线在 worker/src/index.js 的 fetch 里（本模块不 import 项目内任何模块，也不依赖 Node API）：
 *   GET /api/public/search?q=&page=&pageSize=   → handleSearch(request, env, ctx)
 *   GET /api/public/search/suggest?q=           → handleSuggest(request, env)
 *
 * 三级降级（任何一级失败，搜索都还能用）：
 *   1) FTS5 + tokenize='trigram'（trigram 按 3 个字符切分，对中文子串匹配有效）
 *   2) FTS5 + tokenize='unicode61'（有的 SQLite 未编译 trigram）
 *   3) LIKE '%q%' 全表扫描
 *   建表或查询任一环节抛错 → 模块级标记置为不可用，本 isolate 内全程走 LIKE（新 isolate 冷启动会重试）。
 *
 * 索引同步策略：**不使用 CREATE TRIGGER**（现有执行器按语句逐条执行 SQL，触发器体内部含分号，容易写坏）。
 *   改用 ensureSearchSchema 里的「自愈式整表重建」：建表后比较 posts_fts 与 posts(status=1) 的行数，
 *   不一致就 DELETE FROM posts_fts + INSERT ... SELECT 整表重建。因此后台增删改文章的代码里
 *   **不需要**任何同步调用；本站 57 篇规模，重建就是 2 条 SQL，成本极低。
 *   已知边界：只比对行数 —— 只改标题/正文而文章数不变时索引内容不会自动刷新，
 *   需等行数变化或新 isolate 冷启动时重建（将来要更及时，可在此加内容长度校验或后台「重建索引」入口）。
 *
 * 契约（新接口统一 {ok}，与旧的 {success} 区分）：
 *   搜索：{ ok:true, data:{ q, page, pageSize, total, has_more, list:[...] }, engine:"fts5"|"like" }
 *   建议：{ ok:true, data:{ q, list:[{ text, type:"title"|"history" }] } }
 *   服务不可用：HTTP 200 + { ok:false, msg:"搜索服务暂时不可用" }
 */

const FTS_TABLE = "posts_fts";
const MAX_Q_LEN = 100;             // URL 参数 q 的最大长度（超出截断）
const DEFAULT_PAGE_SIZE = 10;      // pageSize 默认值
const MAX_PAGE_SIZE = 50;          // pageSize 上限
const MAX_PAGE = 1000000;          // page 上限，避免超大 OFFSET 拖垮 D1

/* 模块级状态（isolate 内缓存，跨请求复用；与 index.js 的 _schemaReady 同一思路） */
let _searchSchemaReady = false;    // 建表 + 索引同步是否已完成
let _searchSchemaPromise = null;   // 并发去重：同一 isolate 只建一次表
let _ftsUsable = true;             // FTS 是否可用；一旦确认不可用就恒走 LIKE
let _ftsTokenizer = "";            // "trigram" | "unicode61"，仅作诊断线索

/* ------------------------------------------------------------------ */
/* 响应与工具                                                          */
/* ------------------------------------------------------------------ */

/* 自己构造 Response（不 import index.js 的 json()），但响应头风格与它保持一致，
   只把 cache-control 换成搜索用的 60 秒公共缓存；OPTIONS 预检另行覆盖为 no-store。 */
function searchJson(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, X-Token",
      ...extraHeaders,
    },
  });
}

/** HTML 转义（与 index.js 的 escapeHtml 同规则，本模块自带一份，避免跨模块 import） */
export function escapeHtmlForSearch(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** q 消毒：控制字符 → 空格，trim，再截断到 100 字符；FTS 与 LIKE 两侧都只吃这个结果 */
function sanitizeQuery(raw) {
  let s = String(raw == null ? "" : raw).replace(/[\u0000-\u001F\u007F]/g, " ");
  s = s.trim();
  if (s.length > MAX_Q_LEN) s = s.slice(0, MAX_Q_LEN);
  return s;
}

/* FTS5 MATCH 表达式：整体包成短语、内部双引号按 FTS5 规则双写成两个（"" 表示字面量 "）。
   这样 * ( ) : ^ - + AND OR NOT NEAR 等语法字符全部被短语吃掉，用户输入不会被当查询语法解析。 */
function ftsPhrase(q) {
  return '"' + q.replace(/"/g, '""') + '"';
}

/* LIKE 模式 %q%：先把 \ % _ 转义，配合 SQL 里的 ESCAPE '\'，避免用户输入的 _ / % 变成通配符 */
function likePattern(q) {
  const esc = q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  return "%" + esc + "%";
}

/** 正则元字符转义（高亮时把 q 当字面量匹配） */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 标题高亮：标题与 q 各自先做 HTML 转义，再把「已转义的 q」用 <mark> 包起来（大小写不敏感）。
    转义是逐字符映射，所以转义后标题里对应的片段正好等于转义后的 q，不会切坏实体。 */
function highlightTitle(title, q) {
  const safeTitle = escapeHtmlForSearch(title);
  const safeQ = escapeHtmlForSearch(q);
  if (!safeQ) return safeTitle;
  try {
    return safeTitle.replace(new RegExp(escapeRegExp(safeQ), "gi"), function (m) {
      return "<mark>" + m + "</mark>";
    });
  } catch (e) {
    return safeTitle;   // 极端输入导致正则构造失败：退回纯转义标题
  }
}

/** 整数参数：非法值取默认，越界夹到 [min,max] */
function clampInt(raw, def, min, max) {
  const n = parseInt(String(raw == null ? "" : raw).trim(), 10);
  if (!Number.isFinite(n)) return def;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** 一行 → 列表项。text 字段（title/summary/source_file/created_at）一律走 escapeHtmlForSearch；
    title_html 是「已转义 + 已插入 <mark>」的成品，前端可直接 innerHTML；
    id / views 是数值字段，不做 HTML 转义，保持 number 类型。 */
function mapRow(row, q) {
  const sf = row && row.source_file ? String(row.source_file) : "";
  return {
    id: row && row.id != null ? row.id : 0,
    title: escapeHtmlForSearch(row && row.title),
    title_html: highlightTitle(row && row.title, q),
    summary: escapeHtmlForSearch(row && row.summary),
    source_file: escapeHtmlForSearch(sf),
    url: sf ? "/article/" + sf : "",   // source_file 为空则给空串，前端据此渲染成不可点卡片
    created_at: escapeHtmlForSearch(row && row.created_at),
    views: Number(row && row.views) || 0,
  };
}

/** 组装 data 段（page/pageSize/total/has_more/list） */
function buildData(q, page, pageSize, total, list) {
  return {
    q: q,
    page: page,
    pageSize: pageSize,
    total: total,
    has_more: page * pageSize < total,
    list: list,
  };
}

/* ------------------------------------------------------------------ */
/* 引擎一 / 二：FTS5（建表 + 自愈同步 + 查询）                          */
/* ------------------------------------------------------------------ */

/** 幂等建 FTS5 虚表并做自愈式整表重建；返回 "fts5" | "off"。
 *  并发安全：同一 isolate 内多个请求共用 _searchSchemaPromise，只建一次。 */
export async function ensureSearchSchema(db) {
  if (_searchSchemaReady) return _ftsUsable ? "fts5" : "off";
  if (_searchSchemaPromise) return _searchSchemaPromise;
  _searchSchemaPromise = (async () => {
    // 1) 建表：trigram 优先；若该 SQLite 未编译 trigram，退 unicode61 再试一次
    const ddl = [
      "CREATE VIRTUAL TABLE IF NOT EXISTS " + FTS_TABLE +
        " USING fts5(title, summary, content, source_file UNINDEXED, tokenize='trigram')",
      "CREATE VIRTUAL TABLE IF NOT EXISTS " + FTS_TABLE +
        " USING fts5(title, summary, content, source_file UNINDEXED, tokenize='unicode61')",
    ];
    let created = false;
    for (let i = 0; i < ddl.length; i++) {
      try {
        await db.prepare(ddl[i]).run();
        created = true;
        _ftsTokenizer = i === 0 ? "trigram" : "unicode61";
        break;
      } catch (e) { /* 该 tokenizer 不被支持，换下一种 */ }
    }
    if (!created) {
      // 两次都建不出来：本 isolate 内标记 FTS 不可用，全程走 LIKE（新 isolate 冷启动会重试）
      _ftsUsable = false;
      _searchSchemaReady = true;
      return "off";
    }

    // 2) 自愈同步：行数不一致就整表重建。
    //    为什么重建而不是增量同步：
    //    a) 增量需要在后台每处增删改文章的地方都调一次同步，漏一处索引就长期偏离，且和现有
    //       index.js 的创作流程耦合；b) 本站文章 57 篇，DELETE + INSERT ... SELECT 两条 SQL 就完成，
    //       成本远低于维护增量逻辑的出错概率；c) 把同步收敛到搜索请求自己身上，任何人改完文章
    //       下一次搜索就自动对齐，不需要额外的运维步骤。
    try {
      const a = await db.prepare("SELECT COUNT(*) AS c FROM " + FTS_TABLE).first();
      const b = await db.prepare("SELECT COUNT(*) AS c FROM posts WHERE status=1").first();
      const indexed = a ? Number(a.c) || 0 : 0;
      const published = b ? Number(b.c) || 0 : 0;
      if (indexed !== published) {
        await db.prepare("DELETE FROM " + FTS_TABLE).run();
        await db.prepare(
          "INSERT INTO " + FTS_TABLE + "(rowid,title,summary,content,source_file) " +
          "SELECT id,title,summary,content,source_file FROM posts WHERE status=1"
        ).run();
      }
    } catch (e) {
      // 同步失败（含重建中途失败）：索引可能残缺，宁可用 LIKE 也不能返回残缺结果
      _ftsUsable = false;
    }
    _searchSchemaReady = true;
    return _ftsUsable ? "fts5" : "off";
  })().catch((e) => { _searchSchemaPromise = null; throw e; });
  return _searchSchemaPromise;
}

/* FTS5 查询：MATCH 与 ORDER BY rank 都作用在 FTS 表本体上（不给 FTS 表起别名）。
   这是 SQLite 文档里 join + 排序的标准形态：
     FROM posts_fts JOIN posts p ON p.id=posts_fts.rowid WHERE posts_fts MATCH ?1 ORDER BY rank
   rank 是 FTS5 内建的隐藏列（默认 bm25，值越小越相关），posts 表没有同名列，
   所以 ORDER BY rank 不存在歧义；末尾再补 p.id DESC 兜底，保证分值相同时分页顺序稳定。
   注：若某个 SQLite 构建不支持 rank 隐藏列，这里会抛错，由 handleSearch 捕获后永久降级 LIKE（安全）。 */
async function queryFts(db, q, limit, offset) {
  const match = ftsPhrase(q);
  const join = " FROM " + FTS_TABLE + " JOIN posts p ON p.id=" + FTS_TABLE + ".rowid " +
    "WHERE " + FTS_TABLE + " MATCH ?1 AND p.status=1";
  // 计数：只用到 ?1
  const cnt = await db.prepare("SELECT COUNT(*) AS c" + join).bind(match).first();
  // 列表：?1 = MATCH 短语，?2 = LIMIT，?3 = OFFSET
  const rows = await db.prepare(
    "SELECT p.id,p.title,p.summary,p.source_file,p.created_at,p.views" + join +
    " ORDER BY rank, p.id DESC LIMIT ?2 OFFSET ?3"
  ).bind(match, limit, offset).all();
  return { total: cnt ? Number(cnt.c) || 0 : 0, rows: rows.results || [] };
}

/* ------------------------------------------------------------------ */
/* 引擎三：LIKE 全表扫描兜底                                            */
/* ------------------------------------------------------------------ */

/* 四个 LIKE 各用一个独立编号（?1..?4 每个只出现一次），避免「同一编号在同一语句里重复出现」
   时不同驱动对参数个数统计不一致的隐患；ESCAPE '\' 与 likePattern() 的转义配套。 */
const LIKE_WHERE =
  "status=1 AND (title LIKE ?1 ESCAPE '\\' OR summary LIKE ?2 ESCAPE '\\' " +
  "OR content LIKE ?3 ESCAPE '\\' OR source_file LIKE ?4 ESCAPE '\\')";

async function queryLike(db, q, limit, offset) {
  const p = likePattern(q);
  // 计数：?1..?4 各一次
  const cnt = await db.prepare("SELECT COUNT(*) AS c FROM posts WHERE " + LIKE_WHERE)
    .bind(p, p, p, p).first();
  // 列表：?1..?4 + ?5 = LIMIT，?6 = OFFSET
  const rows = await db.prepare(
    "SELECT id,title,summary,source_file,created_at,views FROM posts WHERE " + LIKE_WHERE +
    " ORDER BY is_top DESC, id DESC LIMIT ?5 OFFSET ?6"
  ).bind(p, p, p, p, limit, offset).all();
  return { total: cnt ? Number(cnt.c) || 0 : 0, rows: rows.results || [] };
}

/* ------------------------------------------------------------------ */
/* 搜索词记录（search_queries 属扩展表，可能尚未创建，读写全部 try/catch） */
/* ------------------------------------------------------------------ */

async function recordSearchQuery(env, q) {
  if (!env || !env.DB || !q) return;
  const db = env.DB;
  const now = Date.now();
  // search_queries 的 q 只有普通索引、没有唯一约束，ON CONFLICT 不可用 → 只能先查后写
  const hit = await db.prepare("SELECT id FROM search_queries WHERE q=?1 LIMIT 1").bind(q).first();
  if (hit && hit.id) {
    await db.prepare("UPDATE search_queries SET cnt=cnt+1, last_at=?2 WHERE id=?1")
      .bind(hit.id, now).run();
  } else {
    await db.prepare("INSERT INTO search_queries (q,cnt,last_at) VALUES (?1,1,?2)")
      .bind(q, now).run();
  }
}

/** 记录搜索词但不阻塞响应：有 ctx.waitUntil 就交给它（响应返回后仍会执行完）；
    拿不到 ctx 时退化为 fire-and-forget，一切失败静默忽略（统计而已，不影响搜索本身）。 */
function scheduleRecordSearch(env, q, ctx) {
  const task = () => recordSearchQuery(env, q).catch(() => {});
  try {
    if (ctx && typeof ctx.waitUntil === "function") { ctx.waitUntil(task()); return; }
  } catch (e) { /* ctx 形态异常，继续走 fire-and-forget */ }
  task();
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

/** GET /api/public/search?q=&page=&pageSize= */
export async function handleSearch(request, env, ctx) {
  // CORS 预检：最前面处理
  if (request.method === "OPTIONS") {
    return searchJson({ ok: true }, 200, { "cache-control": "no-store" });
  }

  const url = new URL(request.url);
  const q = sanitizeQuery(url.searchParams.get("q"));
  const page = clampInt(url.searchParams.get("page"), 1, 1, MAX_PAGE);
  const pageSize = clampInt(url.searchParams.get("pageSize"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;

  // q 为空：直接回空结果（engine 记 like 占位，前端按 total=0 显示空态）
  if (!q) {
    return searchJson({ ok: true, data: buildData("", page, pageSize, 0, []), engine: "like" });
  }

  const db = env && env.DB;
  if (!db) return searchJson({ ok: false, msg: "搜索服务暂时不可用" });

  let engine = "like";
  let res = null;

  // 一级 / 二级：FTS5。
  // q 短于 3 个字符时不走 FTS5：trigram 的分词单位就是 3 个字符，更短的查询永远匹配不到；
  // 而这类查询（常见的两字中文关键词）LIKE 完全能命中，所以直接交给 LIKE。
  if (_ftsUsable && q.length >= 3) {
    try {
      await ensureSearchSchema(db);
      if (_ftsUsable) {
        res = await queryFts(db, q, pageSize, offset);
        engine = "fts5";
      }
    } catch (e) {
      _ftsUsable = false;   // 建表或 FTS 查询失败：本 isolate 内改走 LIKE
      res = null;
    }
  }

  // 三级：LIKE 全表扫描
  if (!res) {
    try {
      res = await queryLike(db, q, pageSize, offset);
      engine = "like";
    } catch (e) {
      res = null;
    }
  }

  // 两个引擎都失败：HTTP 200 + ok:false（不要 500，前端只判 ok）
  if (!res) return searchJson({ ok: false, msg: "搜索服务暂时不可用" });

  // 记录搜索词（不阻塞响应）
  scheduleRecordSearch(env, q, ctx);

  const list = (res.rows || []).map((row) => mapRow(row, q));
  return searchJson({ ok: true, data: buildData(q, page, pageSize, res.total, list), engine: engine });
}

/** GET /api/public/search/suggest?q=
 *  text 是原始文本（未转义），前端必须用 textContent 渲染，不能直接拼 HTML。
 *  标题建议最多 5 条；历史词来自 search_queries（扩展表，可能未建）按 cnt 倒序取 5 条，失败即忽略。 */
export async function handleSuggest(request, env) {
  if (request.method === "OPTIONS") {
    return searchJson({ ok: true }, 200, { "cache-control": "no-store" });
  }

  const url = new URL(request.url);
  const q = sanitizeQuery(url.searchParams.get("q"));
  const out = { q: q, list: [] };
  const db = env && env.DB;
  if (!q || !db) return searchJson({ ok: true, data: out });

  const seen = Object.create(null);   // 标题与历史词可能重复，去重后再给前端

  // 1) 标题命中（最多 5 条）
  try {
    const rows = await db.prepare(
      "SELECT title FROM posts WHERE status=1 AND title LIKE ?1 ESCAPE '\\' " +
      "ORDER BY is_top DESC, id DESC LIMIT 5"
    ).bind(likePattern(q)).all();
    for (const r of rows.results || []) {
      const t = String(r.title == null ? "" : r.title).trim();
      if (!t || seen[t]) continue;
      seen[t] = 1;
      out.list.push({ text: t.slice(0, 60), type: "title" });
    }
  } catch (e) { /* posts 查询失败：忽略标题建议 */ }

  // 2) 历史热门搜索词（表可能不存在，失败直接忽略）
  try {
    const rows = await db.prepare(
      "SELECT q FROM search_queries ORDER BY cnt DESC, last_at DESC LIMIT 5"
    ).all();
    for (const r of rows.results || []) {
      const t = String(r.q == null ? "" : r.q).trim();
      if (!t || seen[t]) continue;
      seen[t] = 1;
      out.list.push({ text: t.slice(0, 60), type: "history" });
    }
  } catch (e) { /* 忽略 */ }

  return searchJson({ ok: true, data: out });
}
