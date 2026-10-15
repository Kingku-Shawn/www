/* ==================================================================
 * 清逸的博客 · 访问统计（worker/src/features/stats.js）
 * 自包含模块：零依赖、零 import、导入时零副作用
 * ------------------------------------------------------------------
 * 对应《追加补充.md》：
 *   · FR-X(R7) —— 访问统计（visits 明细 / daily_stats 日聚合 / 公开统计 / 后台统计）
 *   · D-X5     —— 隐私友好方案（不存原始 IP，只存 SHA-256 指纹与聚合结果）
 *
 * 硬约束：
 *   1) 本模块不 import 任何模块（避免与 index.js 形成循环依赖），所需小工具全部内部自定义；
 *   2) 导入时零副作用：不查 D1、不发 fetch、不注册定时器；
 *   3) 所有 D1 调用 try/catch：表不存在/查询失败一律静默降级，绝不影响主流程；
 *   4) 只用标准 Web API（crypto.subtle / Response / JSON / URL），不用 Node 专有 API；
 *   5) SQL 一律参数化 bind，不拼用户输入；长 SQL 用数组 join(" ") 拼装便于阅读。
 *   6) 打点绝不阻塞响应：优先 ctx.waitUntil，否则 fire-and-forget（catch 吞掉）。
 *   7) 查询预算：后台区间补算用「区间 GROUP BY」一次拿多天（口径仍是 UTC+8 日窗口），
 *      避免逐日 4 条查询在 days=30/90 时打爆 D1 单次调用配额；逐日窗口补算仅作兜底。
 *
 * 依赖的既有表（worker/src/extend-schema.js，本模块不建表、不改表）：
 *   visits      (id, path, source_file, client_key, ip_hash, ua, referer, country, created_at)
 *               —— created_at 为毫秒整数
 *   daily_stats (id, date, pv, uv, posts, comments, updated_at)
 *               —— date 形如 "2026-10-12"（UTC+8 口径）；updated_at 为毫秒整数；
 *                  ⚠ 该表没有 (date) 唯一约束，不能 ON CONFLICT，只能「先查后 UPDATE/INSERT」
 *   views       (source_file TEXT PRIMARY KEY, count)
 *   posts       (id, title, source_file, status, views, created_at)
 *               —— created_at 为 TEXT "YYYY-MM-DD HH:MM:SS"（字符串比较，不传毫秒！）
 *   comments    (id, status, created_at) —— created_at 为毫秒整数
 *   article_likes (post_id, client_key, created_at)
 *
 * 由 index.js 接线的入口：
 *   打点  → recordVisit(request, env, ctx, meta)     —— 页面响应后调用，不 await 也可
 *   公开  → handlePublicStats(request, env)          —— GET /api/public/stats
 *   后台  → handleAdminStats(request, env, me)       —— GET /api/admin/stats?days=30
 *   聚合  → aggregateDaily(env, dateStr)             —— 日聚合任务/懒聚合调用
 *   工具  → isTrackablePage(path)                    —— 是否值得记录为页面浏览
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
/* 常量与纯函数小工具（全部内部自定义，零 import）                        */
/* ------------------------------------------------------------------ */

/** 本地日口径固定 UTC+8：日界一律按此时区切分 */
const CN_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
/** 打点去重窗口：同一 client_key + path 60 秒内只记一次 */
const DEDUPE_WINDOW_MS = 60000;

/** 不记录的路径前缀（API / 后台 / 静态资源 / 上传 / 代理） */
const SKIP_PREFIXES = [
  "/api/",
  "/api-v1/",
  "/admin",
  "/uploads/",
  "/o/",
  "/js/",
  "/cdn.jsdelivr.net/",
];
/** 带这些扩展名的请求不是页面浏览（.html 除外，单独放行） */
const STATIC_EXT_RE = /\.(css|js|mjs|png|jpe?g|gif|webp|avif|bmp|svg|ico|woff2?|ttf|otf|eot|mp3|wav|ogg|mp4|webm|json|xml|txt|map|zip|gz|pdf|wasm)$/i;

/** 安全转数字：D1 可能给 null / 字符串 / 大整数 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 取本地日字符串（UTC+8）；不传则取「现在」 */
function cnDateStr(ms) {
  const t = ms === undefined || ms === null ? Date.now() : ms;
  return new Date(t + CN_OFFSET_MS).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" → 次日 "YYYY-MM-DD"（纯日期算术，与本地时区无关） */
function nextDateStr(dateStr) {
  const t = Date.parse(dateStr + "T00:00:00Z");
  if (!Number.isFinite(t)) return dateStr;
  return new Date(t + DAY_MS).toISOString().slice(0, 10);
}

/** 该日（UTC+8）的毫秒窗口 [start, end)：用于 visits / comments 等毫秒列 */
function dayWindowMs(dateStr) {
  const t = Date.parse(dateStr + "T00:00:00Z");
  if (!Number.isFinite(t)) return null;
  const start = t - CN_OFFSET_MS;
  return { start, end: start + DAY_MS };
}

/** 该日（UTC+8）的字符串窗口 [start, end)：用于 posts.created_at（TEXT） */
function dayWindowText(dateStr) {
  return { start: dateStr + " 00:00:00", end: nextDateStr(dateStr) + " 00:00:00" };
}

/** 最近 n 天（UTC+8）的日期数组，含今天，升序 */
function lastNDates(n) {
  const today = Date.parse(cnDateStr() + "T00:00:00Z");
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(today - i * DAY_MS).toISOString().slice(0, 10));
  }
  return out;
}

/** 归一化 path：完整 URL → pathname；去 query / fragment；补前导 / */
function normalizePath(input) {
  try {
    if (typeof input !== "string") return "";
    let p = input.trim();
    if (!p) return "";
    if (/^https?:\/\//i.test(p)) {
      try {
        p = new URL(p).pathname;
      } catch (e) {
        return "";
      }
    } else {
      const q = p.indexOf("?");
      if (q >= 0) p = p.slice(0, q);
      const h = p.indexOf("#");
      if (h >= 0) p = p.slice(0, h);
    }
    if (!p) return "";
    if (p.charAt(0) !== "/") p = "/" + p;
    return p;
  } catch (e) {
    return "";
  }
}

/** 从 /article/<file> 里提取 source_file（无则返回 ""） */
function extractSourceFile(path) {
  try {
    const m = /^\/article\/([^/?#]+)/i.exec(String(path || ""));
    if (!m) return "";
    let f = m[1];
    try {
      f = decodeURIComponent(f);
    } catch (e) {
      /* 非法百分号编码：保持原样 */
    }
    return f.slice(0, 120);
  } catch (e) {
    return "";
  }
}

/**
 * D-X5 隐私友好：只存 IP 的 SHA-256 十六进制指纹，不落库原始 IP。
 * 失败（无 crypto.subtle 等）返回 ""，绝不影响打点。
 */
async function sha256Hex(text) {
  try {
    const data = new TextEncoder().encode(String(text == null ? "" : text));
    const buf = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(buf);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    }
    return hex;
  } catch (e) {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* 打点：页面浏览判定                                                  */
/* ------------------------------------------------------------------ */

/** 请求的原始 IP（与 index.js 的 clientKey() 同口径，仅内部使用，不落库明文） */
function rawIp(request) {
  try {
    const h = request && request.headers;
    if (!h || typeof h.get !== "function") return "0.0.0.0";
    return h.get("cf-connecting-ip") || h.get("x-forwarded-for") || "0.0.0.0";
  } catch (e) {
    return "0.0.0.0";
  }
}

/** 客户端指纹：IP + UA，截断 180（与 index.js 的 clientKey() 逐字对齐） */
function clientKeyOf(request) {
  try {
    const ua = (request && request.headers && request.headers.get("user-agent")) || "";
    return (rawIp(request) + "|" + ua).slice(0, 180);
  } catch (e) {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* SQL 片段（长语句用数组拼装，避免超长单行；全部参数化 ?N 绑定）          */
/* ------------------------------------------------------------------ */

const SQL = {
  // 60 秒内同 client_key + path 去重
  dupVisit: [
    "SELECT id FROM visits",
    "WHERE client_key = ?1 AND path = ?2 AND created_at > ?3",
    "LIMIT 1",
  ].join(" "),
  insertVisit: [
    "INSERT INTO visits",
    "(path, source_file, client_key, ip_hash, ua, referer, country, created_at)",
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  ].join(" "),
  // 毫秒窗口：visits / comments
  pvMs: [
    "SELECT COUNT(*) AS c FROM visits",
    "WHERE created_at >= ?1 AND created_at < ?2",
  ].join(" "),
  uvMs: [
    "SELECT COUNT(DISTINCT client_key) AS u FROM visits",
    "WHERE created_at >= ?1 AND created_at < ?2",
  ].join(" "),
  commentsMs: [
    "SELECT COUNT(*) AS c FROM comments",
    "WHERE created_at >= ?1 AND created_at < ?2",
  ].join(" "),
  // ⚠ 字符串窗口：posts.created_at 是 TEXT "YYYY-MM-DD HH:MM:SS"
  postsText: [
    "SELECT COUNT(*) AS c FROM posts",
    "WHERE created_at >= ?1 AND created_at < ?2",
  ].join(" "),
  findDayStat: "SELECT id FROM daily_stats WHERE date = ?1 LIMIT 1",
  updateDayStat: [
    "UPDATE daily_stats",
    "SET pv = ?1, uv = ?2, posts = ?3, comments = ?4, updated_at = ?5",
    "WHERE id = ?6",
  ].join(" "),
  insertDayStat: [
    "INSERT INTO daily_stats (date, pv, uv, posts, comments, updated_at)",
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ].join(" "),
  selDayStat: "SELECT date, pv, uv, posts, comments FROM daily_stats WHERE date = ?1 LIMIT 1",
  selDayStatsRange: [
    "SELECT date, pv, uv, posts, comments FROM daily_stats",
    "WHERE date >= ?1 ORDER BY date ASC",
  ].join(" "),
  last7: [
    "SELECT date, pv, uv FROM daily_stats",
    "ORDER BY date DESC LIMIT 7",
  ].join(" "),
  countPostsPub: "SELECT COUNT(*) AS c FROM posts WHERE status = 1",
  countCommentsPub: "SELECT COUNT(*) AS c FROM comments WHERE status = 1",
  sumViewCount: 'SELECT COALESCE(SUM("count"), 0) AS s FROM views',
  sumPostViews: "SELECT COALESCE(SUM(views), 0) AS s FROM posts",
  countLikes: "SELECT COUNT(*) AS c FROM article_likes",
  topPages: [
    "SELECT path, COUNT(*) AS pv FROM visits",
    "WHERE created_at >= ?1",
    "GROUP BY path ORDER BY pv DESC LIMIT 20",
  ].join(" "),
  topPosts: [
    "SELECT source_file, COUNT(*) AS pv FROM visits",
    "WHERE created_at >= ?1 AND source_file != ''",
    "GROUP BY source_file ORDER BY pv DESC LIMIT 20",
  ].join(" "),
  totalsRange: [
    "SELECT COUNT(*) AS c, COUNT(DISTINCT client_key) AS u FROM visits",
    "WHERE created_at >= ?1",
  ].join(" "),
  // 区间按天分组（口径与 dayWindowMs 完全一致：毫秒 → 秒 → +8h → 'YYYY-MM-DD'）
  // 用于一次补齐多天，避免「每天 4 条查询」把 D1 单次调用配额打爆
  groupVisits: [
    "SELECT date(created_at / 1000 + 28800, 'unixepoch') AS d,",
    "COUNT(*) AS pv, COUNT(DISTINCT client_key) AS uv FROM visits",
    "WHERE created_at >= ?1 AND created_at < ?2 GROUP BY d",
  ].join(" "),
  groupComments: [
    "SELECT date(created_at / 1000 + 28800, 'unixepoch') AS d, COUNT(*) AS c FROM comments",
    "WHERE created_at >= ?1 AND created_at < ?2 GROUP BY d",
  ].join(" "),
  groupPosts: [
    "SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS c FROM posts",
    "WHERE created_at >= ?1 AND created_at < ?2 GROUP BY d",
  ].join(" "),
};

/* ------------------------------------------------------------------ */
/* 打点落库（在 waitUntil 里执行；内部全 try/catch，永不 reject）         */
/* ------------------------------------------------------------------ */

/**
 * 写一条 visits。表不存在 / 去重命中 / 任何异常都只是静默返回 false。
 * ip 明文只在本函数栈内使用，入库前转 SHA-256 指纹（D-X5）。
 */
async function writeVisit(db, row, ip) {
  try {
    const since = row.created_at - DEDUPE_WINDOW_MS;
    const dup = await db.prepare(SQL.dupVisit).bind(row.client_key, row.path, since).first();
    if (dup && dup.id != null) return false;
    const ipHash = await sha256Hex(ip);
    await db
      .prepare(SQL.insertVisit)
      .bind(
        row.path,
        row.source_file,
        row.client_key,
        ipHash,
        row.ua,
        row.referer,
        row.country,
        row.created_at
      )
      .run();
    return true;
  } catch (e) {
    return false; // 表未创建 / 约束冲突 / D1 抖动：静默
  }
}

/* ------------------------------------------------------------------ */
/* 入口 1：recordVisit —— 只记页面浏览，绝不阻塞响应                     */
/* ------------------------------------------------------------------ */

/**
 * @param {Request} request 页面请求
 * @param {Object}  env     Worker env（需 env.DB）
 * @param {Object}  ctx     ExecutionContext（可为 null → fire-and-forget）
 * @param {Object}  meta    { path, sourceFile? }
 * @returns {boolean} 是否「接受」了这次打点（不代表已落库）
 */
export async function recordVisit(request, env, ctx, meta) {
  try {
    const db = env && env.DB;
    if (!db || typeof db.prepare !== "function") return false;
    const m = meta || {};

    let path = normalizePath(m.path);
    if (!path) {
      try {
        path = normalizePath(new URL(request.url).pathname);
      } catch (e) {
        return false;
      }
    }
    if (!isTrackablePage(path)) return false;

    const sourceFile = String(m.sourceFile || "").slice(0, 120) || extractSourceFile(path);
    let referer = "";
    let ua = "";
    let country = "";
    try {
      const h = request && request.headers;
      ua = (h && typeof h.get === "function" && h.get("user-agent")) || "";
      referer = (h && typeof h.get === "function" && h.get("referer")) || "";
    } catch (e) {
      /* 头部不可读：留空 */
    }
    try {
      country = (request && request.cf && request.cf.country) || "";
    } catch (e) {
      country = "";
    }

    // 同步把行准备好，随后只把「一次库写」交给 waitUntil
    const row = {
      path: path.slice(0, 200),
      source_file: sourceFile,
      client_key: clientKeyOf(request),
      ua: String(ua).slice(0, 200),
      referer: String(referer).slice(0, 200),
      country: String(country).slice(0, 8),
      created_at: Date.now(),
    };
    const ip = rawIp(request);

    const task = writeVisit(db, row, ip).catch(() => false);
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(task);
    } else {
      task.catch(() => {});
    }
    return true;
  } catch (e) {
    return false; // 打点永不抛
  }
}

/* ------------------------------------------------------------------ */
/* 入口 2：handlePublicStats —— GET /api/public/stats                   */
/* ------------------------------------------------------------------ */

/**
 * 公开统计（不含任何 IP / client_key / referer 明细）。
 * 返回 { ok:true, data:{ posts, comments, totalViews, likes, today:{pv,uv}, last7:[{date,pv,uv}] } }
 * 全部子查询 try/catch，任何失败都降级为 0 / 空数组，永远 200。
 */
export async function handlePublicStats(request, env) {
  try {
    if (request && request.method === "OPTIONS") return jsonResp({ ok: true });
  } catch (e) {
    /* 忽略 */
  }

  const data = {
    posts: 0,
    comments: 0,
    totalViews: 0,
    likes: 0,
    today: { pv: 0, uv: 0 },
    last7: [],
  };

  try {
    const db = env && env.DB;
    if (db && typeof db.prepare === "function") {
      try {
        const r = await db.prepare(SQL.countPostsPub).first();
        data.posts = num(r && r.c);
      } catch (e) {
        data.posts = 0;
      }
      try {
        const r = await db.prepare(SQL.countCommentsPub).first();
        data.comments = num(r && r.c);
      } catch (e) {
        data.comments = 0;
      }
      // totalViews：优先 views 汇总表，表不存在则退化到 posts.views 求和
      try {
        const r = await db.prepare(SQL.sumViewCount).first();
        data.totalViews = num(r && r.s);
      } catch (e) {
        try {
          const r2 = await db.prepare(SQL.sumPostViews).first();
          data.totalViews = num(r2 && r2.s);
        } catch (e2) {
          data.totalViews = 0;
        }
      }
      try {
        const r = await db.prepare(SQL.countLikes).first();
        data.likes = num(r && r.c);
      } catch (e) {
        data.likes = 0;
      }

      // today：先读 daily_stats 今天的行，缺失则用 visits 实时按 UTC+8 当天窗口算
      const today = cnDateStr();
      try {
        const r = await db.prepare(SQL.selDayStat).bind(today).first();
        if (r && r.pv != null) {
          data.today = { pv: num(r.pv), uv: num(r.uv) };
        } else {
          const live = await realtimeDayCounts(db, today);
          data.today = { pv: live.pv, uv: live.uv };
        }
      } catch (e) {
        try {
          const live = await realtimeDayCounts(db, today);
          data.today = { pv: live.pv, uv: live.uv };
        } catch (e2) {
          data.today = { pv: 0, uv: 0 };
        }
      }

      // last7：daily_stats 最近 7 行，反转为升序
      try {
        const rs = await db.prepare(SQL.last7).all();
        const rows = (rs && rs.results) || [];
        data.last7 = rows
          .slice()
          .reverse()
          .map((r) => ({ date: String((r && r.date) || ""), pv: num(r && r.pv), uv: num(r && r.uv) }));
      } catch (e) {
        data.last7 = [];
      }
    }
  } catch (e) {
    // 兜底：返回默认零值
  }

  return jsonResp({ ok: true, data }, 200, { "cache-control": "public, max-age=120" });
}

/* ------------------------------------------------------------------ */
/* 入口 3：handleAdminStats —— GET /api/admin/stats?days=30             */
/* ------------------------------------------------------------------ */

/**
 * 后台统计（需 admin / super_admin）。
 * data = { range:{from,to}, daily:[{date,pv,uv,posts,comments}],
 *          topPages:[{path,pv}], topPosts:[{source_file,title,pv}],
 *          totals:{pv,uv,visits} }
 * 表不存在时返回空结构并附 note:"扩展表未创建"。
 */
export async function handleAdminStats(request, env, me) {
  try {
    if (request && request.method === "OPTIONS") return jsonResp({ ok: true });
  } catch (e) {
    /* 忽略 */
  }

  const role = me && me.role;
  if (role !== "super_admin" && role !== "admin") {
    return jsonResp({ ok: false, msg: "权限不足" }, 403);
  }

  // days 夹在 1–90，默认 30
  let days = 30;
  try {
    const raw = new URL(request.url).searchParams.get("days");
    const n = parseInt(raw == null ? "" : String(raw), 10);
    if (Number.isFinite(n)) days = n;
  } catch (e) {
    days = 30;
  }
  if (!Number.isFinite(days)) days = 30;
  days = Math.max(1, Math.min(90, days));

  const dates = lastNDates(days);
  const from = dates[0];
  const to = dates[dates.length - 1];
  const win = dayWindowMs(from);
  const fromMs = win ? win.start : 0;

  const base = {
    range: { from, to },
    daily: dates.map((d) => ({ date: d, pv: 0, uv: 0, posts: 0, comments: 0 })),
    topPages: [],
    topPosts: [],
    totals: { pv: 0, uv: 0, visits: 0 },
  };

  const db = env && env.DB;
  if (!db || typeof db.prepare !== "function") {
    return jsonResp({ ok: true, data: base, note: "扩展表未创建" });
  }

  let note = "";
  const data = {
    range: { from, to },
    daily: [],
    topPages: [],
    topPosts: [],
    totals: { pv: 0, uv: 0, visits: 0 },
  };

  // daily：优先读 daily_stats，缺失的日期用 visits 实时补算
  const dayMap = Object.create(null);
  try {
    const rs = await db.prepare(SQL.selDayStatsRange).bind(from).all();
    const rows = (rs && rs.results) || [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r && r.date) dayMap[String(r.date)] = r;
    }
  } catch (e) {
    note = "扩展表未创建";
  }

  // 缺行日期：先用 3 条区间查询一次补齐（分桶口径与逐日窗口完全一致）；
  // 若区间补算一行都没拿到（老 SQLite 不支持该 date() 写法等），再退回逐日窗口补算，
  // 但只在缺行较少（<= 14 天）时执行，避免 days=30/90 时 4×N 条查询打爆 D1 单次调用配额。
  const missing = [];
  for (let i = 0; i < dates.length; i++) {
    if (!dayMap[dates[i]]) missing.push(dates[i]);
  }
  const liveMap = Object.create(null);
  if (missing.length) {
    const ranged = await realtimeRangeCounts(db, from, to);
    let covered = 0;
    for (let i = 0; i < missing.length; i++) {
      const b = ranged[missing[i]];
      if (b) {
        liveMap[missing[i]] = b;
        covered++;
      }
    }
    if (covered === 0 && missing.length <= 14) {
      for (let i = 0; i < missing.length; i++) {
        liveMap[missing[i]] = await realtimeDayCounts(db, missing[i]);
      }
    }
  }

  const ZERO = { pv: 0, uv: 0, posts: 0, comments: 0 };
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const hit = dayMap[d];
    const live = liveMap[d] || ZERO;
    data.daily.push({
      date: d,
      pv: hit ? num(hit.pv) : live.pv,
      uv: hit ? num(hit.uv) : live.uv,
      posts: hit ? num(hit.posts) : live.posts,
      comments: hit ? num(hit.comments) : live.comments,
    });
  }

  // topPages
  try {
    const rs = await db.prepare(SQL.topPages).bind(fromMs).all();
    const rows = (rs && rs.results) || [];
    data.topPages = rows.map((r) => ({ path: String((r && r.path) || ""), pv: num(r && r.pv) }));
  } catch (e) {
    data.topPages = [];
  }

  // topPosts：先按 source_file 聚合，再用第二次查询映射标题（避免 JOIN 写法出错）
  try {
    const rs = await db.prepare(SQL.topPosts).bind(fromMs).all();
    const rows = (rs && rs.results) || [];
    const files = rows.map((r) => String((r && r.source_file) || "")).filter((f) => f !== "");
    const titleMap = Object.create(null);
    if (files.length) {
      try {
        const holders = files.map((_, i) => "?" + (i + 1)).join(", ");
        const sql =
          "SELECT source_file, title FROM posts WHERE source_file IN (" + holders + ")";
        const rs2 = await db.prepare(sql).bind(...files).all();
        const rows2 = (rs2 && rs2.results) || [];
        for (let i = 0; i < rows2.length; i++) {
          const p = rows2[i];
          if (p && p.source_file != null) titleMap[String(p.source_file)] = String(p.title || "");
        }
      } catch (e) {
        /* 标题映射失败：标题留空 */
      }
    }
    data.topPosts = rows.map((r) => {
      const f = String((r && r.source_file) || "");
      return { source_file: f, title: titleMap[f] || "", pv: num(r && r.pv) };
    });
  } catch (e) {
    data.topPosts = [];
  }

  // totals：pv 用 daily 求和（与上面表格口径一致）；
  // uv 是整个区间的「去重访客数」（不是每日 uv 之和），visits 是区间内明细行数
  let pvSum = 0;
  for (let i = 0; i < data.daily.length; i++) pvSum += num(data.daily[i].pv);
  try {
    const r = await db.prepare(SQL.totalsRange).bind(fromMs).first();
    const visits = num(r && r.c);
    data.totals = { pv: pvSum, uv: num(r && r.u), visits };
  } catch (e) {
    data.totals = { pv: pvSum, uv: 0, visits: 0 };
    if (!note) note = "扩展表未创建"; // visits 表不可用 → 一并提示
  }

  const out = { ok: true, data };
  if (note) out.note = note;
  return jsonResp(out);
}

/* ------------------------------------------------------------------ */
/* 日内计数（实时补算）：毫秒窗口算 visits/comments，字符串窗口算 posts    */
/* ------------------------------------------------------------------ */

/**
 * 实时统计某一天（UTC+8）的 { pv, uv, posts, comments }。
 * 每个子查询各自 try/catch，失败给 0；表不存在也不会抛。
 */
async function realtimeDayCounts(db, dateStr) {
  const out = { pv: 0, uv: 0, posts: 0, comments: 0 };
  const win = dayWindowMs(dateStr);
  if (!win) return out;
  const txt = dayWindowText(dateStr);
  try {
    const r = await db.prepare(SQL.pvMs).bind(win.start, win.end).first();
    out.pv = num(r && r.c);
  } catch (e) {
    out.pv = 0;
  }
  try {
    const r = await db.prepare(SQL.uvMs).bind(win.start, win.end).first();
    out.uv = num(r && r.u);
  } catch (e) {
    out.uv = 0;
  }
  try {
    // ⚠ posts.created_at 是 TEXT，绑定字符串而不是毫秒
    const r = await db.prepare(SQL.postsText).bind(txt.start, txt.end).first();
    out.posts = num(r && r.c);
  } catch (e) {
    out.posts = 0;
  }
  try {
    const r = await db.prepare(SQL.commentsMs).bind(win.start, win.end).first();
    out.comments = num(r && r.c);
  } catch (e) {
    out.comments = 0;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 区间补算：一次拿回 [fromDate, toDate] 每天的计数（UTC+8 分桶）          */
/* ------------------------------------------------------------------ */

/**
 * 区间 [fromDate, toDate]（含两端，UTC+8 日期字符串）逐日
 * { pv, uv, posts, comments }。分桶口径与 realtimeDayCounts 完全一致，
 * 但只用 3 条查询（每天 4 条会在 days=30/90 时打爆 D1 单次调用配额）。
 * 任何子查询失败 → 该指标留 0；返回对象可能缺行，由调用方兜底。
 */
async function realtimeRangeCounts(db, fromDate, toDate) {
  const map = Object.create(null);
  const get = (d) => {
    const k = String(d == null ? "" : d);
    if (!k) return null;
    if (!map[k]) map[k] = { pv: 0, uv: 0, posts: 0, comments: 0 };
    return map[k];
  };
  const win = dayWindowMs(fromDate);
  const endWin = dayWindowMs(toDate);
  if (!win || !endWin) return map;

  try {
    const rs = await db.prepare(SQL.groupVisits).bind(win.start, endWin.end).all();
    const rows = (rs && rs.results) || [];
    for (let i = 0; i < rows.length; i++) {
      const b = get(rows[i] && rows[i].d);
      if (b) {
        b.pv = num(rows[i].pv);
        b.uv = num(rows[i].uv);
      }
    }
  } catch (e) {
    /* 区间 visits 补算失败：留 0 */
  }
  try {
    const rs = await db.prepare(SQL.groupComments).bind(win.start, endWin.end).all();
    const rows = (rs && rs.results) || [];
    for (let i = 0; i < rows.length; i++) {
      const b = get(rows[i] && rows[i].d);
      if (b) b.comments = num(rows[i].c);
    }
  } catch (e) {
    /* 留 0 */
  }
  try {
    // ⚠ posts.created_at 是 TEXT，这里绑定字符串窗口（不是毫秒）
    const txt = dayWindowText(fromDate);
    const txtEnd = dayWindowText(toDate).end;
    const rs = await db.prepare(SQL.groupPosts).bind(txt.start, txtEnd).all();
    const rows = (rs && rs.results) || [];
    for (let i = 0; i < rows.length; i++) {
      const b = get(rows[i] && rows[i].d);
      if (b) b.posts = num(rows[i].c);
    }
  } catch (e) {
    /* 留 0 */
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* 入口 4：aggregateDaily —— 把某天 visits/posts/comments 聚合成一行     */
/* ------------------------------------------------------------------ */

/**
 * @param {Object} env
 * @param {string} [dateStr] "YYYY-MM-DD"（UTC+8 口径）；缺省为「今天（UTC+8）」
 * @returns {Object|null} { date, pv, uv, posts, comments }；失败 null
 */
export async function aggregateDaily(env, dateStr) {
  try {
    const db = env && env.DB;
    if (!db || typeof db.prepare !== "function") return null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || "")) ? String(dateStr) : cnDateStr();
    if (!dayWindowMs(date)) return null;

    const counts = await realtimeDayCounts(db, date);

    // ⚠ daily_stats 无 (date) 唯一约束，不能 ON CONFLICT → 先查后 UPDATE / INSERT
    try {
      const hit = await db.prepare(SQL.findDayStat).bind(date).first();
      const now = Date.now();
      if (hit && hit.id != null) {
        await db
          .prepare(SQL.updateDayStat)
          .bind(counts.pv, counts.uv, counts.posts, counts.comments, now, hit.id)
          .run();
      } else {
        await db
          .prepare(SQL.insertDayStat)
          .bind(date, counts.pv, counts.uv, counts.posts, counts.comments, now)
          .run();
      }
    } catch (e) {
      // 聚合表未创建 / 写失败：仍然返回算出来的数字，便于调用方记录
    }

    return {
      date,
      pv: counts.pv,
      uv: counts.uv,
      posts: counts.posts,
      comments: counts.comments,
    };
  } catch (e) {
    return null;
  }
}

/**
 * 是否值得记录为「页面浏览」：
 *   放行 → 以 / 结尾的目录页（/piano/）、以 .html 结尾的静态页（/article/a_xxx.html）、无扩展名的路径（/about）
 *   排除 → /api/、/api-v1/、/admin、/uploads/、/o/、/js/、/cdn.jsdelivr.net/，
 *          以及带扩展名但不是 .html 的静态资源（.css/.js/.png/.../.json/.txt/.map）
 */
export function isTrackablePage(path) {
  try {
    const p = normalizePath(path);
    if (!p) return false;
    const lower = p.toLowerCase();
    if (lower === "/api" || lower === "/api-v1" || lower === "/admin") return false;
    for (let i = 0; i < SKIP_PREFIXES.length; i++) {
      if (lower.indexOf(SKIP_PREFIXES[i]) === 0) return false;
    }
    if (lower.charAt(lower.length - 1) === "/") return true; // 目录页
    if (/\.html$/.test(lower)) return true;                  // 静态文章/页面
    const seg = lower.slice(lower.lastIndexOf("/") + 1);
    if (!seg) return false;
    if (STATIC_EXT_RE.test(seg)) return false; // 明确是静态资源
    return seg.indexOf(".") === -1;            // 无扩展名 → 视作页面
  } catch (e) {
    return false;
  }
}
