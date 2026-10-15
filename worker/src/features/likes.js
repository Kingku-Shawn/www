/* ==================================================================
 * 清逸的博客 · 文章点赞 / 收藏（worker/src/features/likes.js）
 * 自包含模块：零依赖、零 import、导入时零副作用
 * ------------------------------------------------------------------
 * 对应《追加补充.md》：
 *   · FR-X10 —— 文章点赞（免登录，按指纹去重）与收藏（需登录）
 *   · 详情页按钮组：👍 点赞 / ⭐ 收藏（含实时数量与防重复点击）
 *
 * 硬约束：
 *   1) 本模块不 import 任何模块（避免与 index.js 形成循环依赖），所需小工具函数全部内部自定义；
 *   2) 导入时无副作用：不查 D1、不发 fetch；D1 查询全程 try/catch，失败降级返回 0；
 *   3) 所有拼接进 HTML 的动态值（source_file、数量）一律转义，动态参数走 data-* + 事件委托；
 *   4) 只用标准 Web API（crypto.subtle / TextEncoder / Response / JSON），不用 Node 专有 API。
 *
 * 依赖的既有表（worker/src/extend-schema.js，本模块不建表、不改表）：
 *   article_likes   —— (post_id, client_key, ip_hash, ua, created_at) 主键 (post_id, client_key)
 *   article_bookmarks(post_id, user_id, created_at)                                主键 (post_id, user_id)
 *   posts(id, source_file, ...) / users(id, ...) / sessions(token, user_id, created_at, expire_at)
 *
 * 由 index.js 接线的三个入口：
 *   POST /api/article/like     → handleArticleLike
 *   POST /api/article/bookmark → handleArticleBookmark
 *   详情页服务端渲染            → articleCounts + likeButtonHtml
 *
 * ⚠ 注意：/api/article/* 前缀在 index.js 里有「旧前端契约」分支（articleMock），
 *    接线时必须把这两条精确路径判断放在该分支之前，否则会被吞掉（详见回报的接线片段）。
 * ================================================================== */

/* ------------------------------------------------------------------ */
/* 响应助手（响应头对齐 index.js 的 json()；如需 NFR-X1 安全头由接线处统一补） */
/* ------------------------------------------------------------------ */

/** 统一 JSON 响应；OPTIONS 预检由各入口先返回 jsonResp({ ok: true }) */
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

/** 出错文案：统一 200（前端只认 ok 字段，不因 500 触发红色报错） */
function failResp(msg) {
  return jsonResp({ ok: false, msg: msg || "操作失败，请稍后再试" }, 200);
}

/* ------------------------------------------------------------------ */
/* 指纹 / IP / 会话（口径与 index.js 完全一致）                          */
/* ------------------------------------------------------------------ */

/** 真实 IP：cf-connecting-ip → x-forwarded-for → 0.0.0.0 */
function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "0.0.0.0";
}

/** 客户端指纹：与 index.js 的 clientKey() 完全一致（IP|UA，截断 180） */
function clientKeyOf(request) {
  const ip = clientIp(request);
  const ua = request.headers.get("user-agent") || "";
  return (ip + "|" + ua).slice(0, 180);
}

/** UA 原文（截断 200，只作排查用） */
function uaOf(request) {
  return (request.headers.get("user-agent") || "").slice(0, 200);
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

/** 读取 JSON 请求体（口径同 index.js 的 readBody）；非法/非 JSON 返回 {} */
async function readJson(request) {
  try {
    const ct = request.headers.get("content-type") || "";
    if (!ct.includes("json")) return {};
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text) || {};
  } catch (e) {
    return {};
  }
}

/** Cookie 会话 token：X-Token 头优先，其次 Cookie session（口径同 index.js parseCookie + adminAuth） */
function sessionTokenOf(request) {
  let token = "";
  try {
    token = request.headers.get("X-Token") || "";
  } catch (e) {}
  if (!token) {
    try {
      const raw = request.headers.get("cookie") || "";
      const parts = raw.split(";");
      for (let i = 0; i < parts.length; i++) {
        const kv = parts[i];
        const at = kv.indexOf("=");
        if (at < 0) continue;
        if (kv.slice(0, at).trim() !== "session") continue;
        let v = kv.slice(at + 1).trim();
        try { v = decodeURIComponent(v); } catch (e2) {}
        token = v;
        break;
      }
    } catch (e) {}
  }
  return String(token || "").slice(0, 80);
}

/** 按 session token 取登录用户；未登录/过期/禁用返回 null（查询口径同 adminAuth） */
async function userIdOf(request, env) {
  const db = env && env.DB;
  const token = sessionTokenOf(request);
  if (!db || !token) return null;
  try {
    const row = await db.prepare(
      "SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id " +
      "WHERE s.token = ?1 AND s.expire_at > ?2"
    ).bind(token, Date.now()).first();
    return row && row.id ? row.id : null;
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 查询小工具                                                          */
/* ------------------------------------------------------------------ */

/** source_file → posts.id；不存在/查询失败返回 null */
async function postIdByFile(db, sourceFile) {
  const file = String(sourceFile || "").trim();
  if (!file) return null;
  try {
    const row = await db.prepare("SELECT id FROM posts WHERE source_file = ?1").bind(file).first();
    return row && row.id ? row.id : null;
  } catch (e) {
    return null;
  }
}

/** 单条 COUNT 取值；表不存在/查询失败返回 0 */
async function countOne(db, sql, bindArg) {
  try {
    const st = db.prepare(sql);
    const row = await (bindArg == null ? st : st.bind(bindArg)).first();
    return row && row.c != null ? Number(row.c) || 0 : 0;
  } catch (e) {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/* 点赞：免登录，POST /api/article/like                                 */
/* ------------------------------------------------------------------ */

export async function handleArticleLike(request, env) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true }, 200);
  if (request.method !== "POST") return jsonResp({ ok: false, msg: "方法不支持" }, 405);
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const body = await readJson(request);
  const sourceFile = String(body.source_file || "").trim();
  if (!sourceFile) return jsonResp({ ok: false, msg: "缺少参数 source_file" }, 400);

  try {
    const postId = await postIdByFile(db, sourceFile);
    if (postId == null) return jsonResp({ ok: false, msg: "文章不存在" }, 404);

    const sqlCount = "SELECT COUNT(*) AS c FROM article_likes WHERE post_id = ?1";
    const ck = clientKeyOf(request);
    const exist = await db.prepare(
      "SELECT 1 AS x FROM article_likes WHERE post_id = ?1 AND client_key = ?2"
    ).bind(postId, ck).first();

    // 动作解析：action 为 "like"/"unlike"，缺省/非法值 → 切换
    let wantLike = !exist;
    if (body.action === "like") wantLike = true;
    else if (body.action === "unlike") wantLike = false;

    // 已存在且要 like → 幂等，不重复插入
    if (!exist && wantLike) {
      const ipHash = await sha256Hex(clientIp(request));
      // 已登录时记录 user_id，供「我的点赞」按账号查询（未登录则 0）
      let uid = 0;
      try { uid = (await userIdOf(request, env)) || 0; } catch (e) {}
      await db.prepare(
        "INSERT INTO article_likes (post_id, client_key, ip_hash, ua, user_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
        "ON CONFLICT(post_id, client_key) DO NOTHING"
      ).bind(postId, ck, ipHash, uaOf(request), uid, Date.now()).run();
    } else if (exist && !wantLike) {
      await db.prepare("DELETE FROM article_likes WHERE post_id = ?1 AND client_key = ?2").bind(postId, ck).run();
    }

    // 以「数据库真实状态」为准回填，避免并发下客户端状态错乱
    const after = await db.prepare(
      "SELECT 1 AS x FROM article_likes WHERE post_id = ?1 AND client_key = ?2"
    ).bind(postId, ck).first();
    const liked = !!after;
    const likes = await countOne(db, sqlCount, postId);
    return jsonResp({ ok: true, data: { source_file: sourceFile, liked: liked, likes: likes } }, 200);
  } catch (e) {
    return failResp("操作失败，请稍后再试");
  }
}

/* ------------------------------------------------------------------ */
/* 收藏：需登录，POST /api/article/bookmark                              */
/* ------------------------------------------------------------------ */

export async function handleArticleBookmark(request, env) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true }, 200);
  if (request.method !== "POST") return jsonResp({ ok: false, msg: "方法不支持" }, 405);
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const userId = await userIdOf(request, env);
  if (!userId) return jsonResp({ ok: false, msg: "请先登录" }, 401);

  const body = await readJson(request);
  const sourceFile = String(body.source_file || "").trim();
  if (!sourceFile) return jsonResp({ ok: false, msg: "缺少参数 source_file" }, 400);

  try {
    const postId = await postIdByFile(db, sourceFile);
    if (postId == null) return jsonResp({ ok: false, msg: "文章不存在" }, 404);

    const sqlCount = "SELECT COUNT(*) AS c FROM article_bookmarks WHERE post_id = ?1";
    const exist = await db.prepare(
      "SELECT 1 AS x FROM article_bookmarks WHERE post_id = ?1 AND user_id = ?2"
    ).bind(postId, userId).first();

    let wantMark = !exist;
    if (body.action === "bookmark") wantMark = true;
    else if (body.action === "unbookmark") wantMark = false;

    if (!exist && wantMark) {
      await db.prepare(
        "INSERT INTO article_bookmarks (post_id, user_id, created_at) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(post_id, user_id) DO NOTHING"
      ).bind(postId, userId, Date.now()).run();
    } else if (exist && !wantMark) {
      await db.prepare("DELETE FROM article_bookmarks WHERE post_id = ?1 AND user_id = ?2").bind(postId, userId).run();
    }

    const after = await db.prepare(
      "SELECT 1 AS x FROM article_bookmarks WHERE post_id = ?1 AND user_id = ?2"
    ).bind(postId, userId).first();
    const bookmarked = !!after;
    const bookmarks = await countOne(db, sqlCount, postId);
    return jsonResp({ ok: true, data: { source_file: sourceFile, bookmarked: bookmarked, bookmarks: bookmarks } }, 200);
  } catch (e) {
    return failResp("操作失败，请稍后再试");
  }
}

/* ------------------------------------------------------------------ */
/* 详情页：数量统计 + 按钮组 HTML                                        */
/* ------------------------------------------------------------------ */

/** 文章点赞/收藏总数（供服务端渲染）；任何失败降级 { likes: 0, bookmarks: 0, liked: false } */
export async function articleCounts(env, sourceFile, request) {
  const out = { likes: 0, bookmarks: 0, liked: false };
  const db = env && env.DB;
  if (!db) return out;
  try {
    const postId = await postIdByFile(db, sourceFile);
    if (postId == null) return out;
    out.likes = await countOne(db, "SELECT COUNT(*) AS c FROM article_likes WHERE post_id = ?1", postId);
    out.bookmarks = await countOne(db, "SELECT COUNT(*) AS c FROM article_bookmarks WHERE post_id = ?1", postId);
    // 当前访客是否已赞（首屏即高亮，避免刷新后状态丢失看起来像“没同步”）
    if (request) {
      const ck = clientKeyOf(request);
      const row = await db.prepare(
        "SELECT 1 AS x FROM article_likes WHERE post_id = ?1 AND client_key = ?2"
      ).bind(postId, ck).first();
      out.liked = !!row;
    }
  } catch (e) {}
  return out;
}

/** HTML 转义（模块内自带，避免依赖 index.js 的 escapeHtml/esc） */
function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/**
 * 详情页点赞/收藏按钮组（自包含：内联 <style> + 内联 <script>，零外链）
 * 建议插入位置：文章正文卡片之后、评论区之前（即模板里 `<h3>评论</h3>` 所在 <div class="comments"> 之前）
 * @param {string} sourceFile 文章 source_file
 * @param {{likes?:number, bookmarks?:number}} counts articleCounts() 的返回值
 */
export function likeButtonHtml(sourceFile, counts) {
  const file = String(sourceFile == null ? "" : sourceFile);
  const c = counts || {};
  const likes = Number(c.likes) || 0;
  const bookmarks = Number(c.bookmarks) || 0;
  const liked = !!c.liked;
  const a = [];

  a.push('<div class="al-bar" id="alBar" data-file="' + esc(file) + '">');
  a.push('  <button type="button" class="al-btn' + (liked ? " on" : "") + '" data-act="like" aria-pressed="' + (liked ? "true" : "false") + '">');
  a.push('    <span class="al-ico">👍</span><span class="al-txt">' + (liked ? "已赞" : "点赞") + '</span><span class="al-cnt">' + likes + '</span>');
  a.push('  </button>');
  a.push('  <button type="button" class="al-btn" data-act="bookmark" aria-pressed="false">');
  a.push('    <span class="al-ico">⭐</span><span class="al-txt">收藏</span><span class="al-cnt">' + bookmarks + '</span>');
  a.push('  </button>');
  a.push('  <span class="al-tip">点赞无需登录，收藏需先登录</span>');
  a.push('</div>');

  a.push('<style>');
  a.push('.al-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#fff;border:1px solid #e4e9f0;');
  a.push('border-radius:18px;padding:16px 28px;box-shadow:0 10px 30px rgba(15,23,42,.05);margin-bottom:20px}');
  a.push('.al-btn{display:inline-flex;align-items:center;gap:7px;border:1px solid #d0d7de;background:#f6f8fa;');
  a.push('color:#334155;border-radius:999px;padding:8px 18px;font-size:14px;font-weight:600;cursor:pointer;transition:.15s}');
  a.push('.al-btn .al-ico{font-size:15px;line-height:1}');
  a.push('.al-btn .al-cnt{min-width:14px;text-align:center;font-size:12.5px;color:#64748b}');
  a.push('.al-btn:hover{border-color:#bfdbfe;color:#2563eb}');
  a.push('.al-btn.on{background:linear-gradient(135deg,#2563eb,#0ea5e9);border-color:transparent;color:#fff}');
  a.push('.al-btn.on .al-cnt{color:#e0f2fe}');
  a.push('.al-btn[disabled]{opacity:.6;cursor:not-allowed}');
  a.push('.al-tip{font-size:12.5px;color:#94a3b8}');
  a.push('@media(max-width:640px){.al-bar{padding:14px 16px;border-radius:14px}.al-tip{display:none}}');
  a.push('</style>');

  a.push('<script>');
  a.push('/* FR-X10 点赞/收藏：data-* + 事件委托，动态值已转义；IIFE 避免污染详情页全局 */');
  a.push('(function(){');
  a.push('var bar=document.getElementById("alBar");if(!bar)return;');
  a.push('function escJs(s){return String(s==null?"":s).replace(/[&<>"\']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c];});}');
  a.push('var FILE=escJs(bar.getAttribute("data-file")||"");if(!FILE)return;');
  a.push('var btns=bar.querySelectorAll(".al-btn");');
  a.push('var BUSY=false;');
  a.push('function token(){try{return localStorage.getItem("xw_token")||localStorage.getItem("shawn_admin_token")||"";}catch(e){return "";}}');
  a.push('function paint(btn,on,cnt,onText,offText){btn.classList[on?"add":"remove"]("on");btn.setAttribute("aria-pressed",on?"true":"false");');
  a.push('  var t=btn.querySelector(".al-txt");if(t)t.textContent=on?onText:offText;');
  a.push('  var c=btn.querySelector(".al-cnt");if(c&&typeof cnt==="number"&&isFinite(cnt))c.textContent=String(cnt);}');
  a.push('function lock(on){BUSY=on;for(var i=0;i<btns.length;i++)btns[i].disabled=on;}');
  a.push('function pick(act){for(var i=0;i<btns.length;i++){if(btns[i].getAttribute("data-act")===act)return btns[i];}return null;}');
  a.push('function call(url,act){');
  a.push('  if(BUSY)return;lock(true);');                       // 防重复点击：请求期间两个按钮都禁用
  a.push('  var body={source_file:FILE};');
  a.push('  fetch(url,{method:"POST",headers:{"Content-Type":"application/json","X-Token":token()},body:JSON.stringify(body)})');
  a.push('    .then(function(r){return r.json();})');
  a.push('    .then(function(j){');
  a.push('      if(!j||!j.ok){alert((j&&j.msg)||"操作失败，请稍后再试");return;}');
  a.push('      var d=j.data||{};');
  a.push('      if(act==="like")paint(pick("like"),!!d.liked,d.likes,"已赞","点赞");');
  a.push('      else paint(pick("bookmark"),!!d.bookmarked,d.bookmarks,"已收藏","收藏");');
  a.push('    })');
  a.push('    .catch(function(){alert("网络异常，请稍后再试");})');
  a.push('    .then(function(){lock(false);});');
  a.push('}');
  a.push('bar.addEventListener("click",function(ev){');
  a.push('  var t=ev.target&&ev.target.closest?ev.target.closest(".al-btn"):null;');
  a.push('  if(!t||!bar.contains(t)||t.disabled)return;');
  a.push('  var act=t.getAttribute("data-act");');
  a.push('  if(act==="like")call("/api/article/like","like");');
  a.push('  else if(act==="bookmark")call("/api/article/bookmark","bookmark");');
  a.push('});');
  a.push('})();');
  a.push('</script>');

  return a.join("\n");
}
