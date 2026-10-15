/**
 * users-ext.js —— FR-X15 用户资料与头像 / FR-X16 会话管理 / FR-X17 2FA 骨架 /
 *                 FR-X18 第三方登录骨架(OAuth) / FR-X22 评论增强
 *
 * 设计约定（与 features/moderation.js 保持一致）：
 *  - 零 import、自包含，只用标准 Web API（fetch / crypto / TextEncoder / URL 等）。
 *  - 每个导出函数第一步处理 OPTIONS 预检，返回 {ok:true} 200。
 *  - 所有 D1 调用包 try/catch，避免一处 SQL 失败导致整体 500。
 *  - 写操作 best-effort 写审计表 audit_logs。
 *  - 本模块只依赖已存在的表：users / user_profiles / sessions / oauth_accounts /
 *    comments / uploads。
 */

/* ------------------------------------------------------------------ *
 * 统一响应工具
 * ------------------------------------------------------------------ */

/**
 * 构造 JSON 响应，响应头与 index.js 的 json() 保持一致。
 * @param {any} obj 响应体
 * @param {number} status HTTP 状态码
 * @param {Object} extraHeaders 额外/覆盖的响应头
 */
function jsonResp(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign(
      {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Content-Type, X-Token",
      },
      extraHeaders || {}
    ),
  });
}

/* ------------------------------------------------------------------ *
 * 通用小工具（内部，不导出）
 * ------------------------------------------------------------------ */

/* 当前时间戳（毫秒），与 index.js 的 nowMs 同口径 */
function nowMs() {
  return Date.now();
}

/* 截断字符串，避免写库超长 / 超长响应 */
function clip(v, n) {
  const s = v === undefined || v === null ? "" : String(v);
  return s.length > n ? s.slice(0, n) : s;
}

/* 读取 JSON 请求体：任何异常都退回 {}（与 index.js readBody 行为一致） */
async function readBody(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    const obj = JSON.parse(text);
    return obj && typeof obj === "object" ? obj : {};
  } catch (e) {
    return {};
  }
}

/* ---- 密码哈希（逐字对齐 index.js / auth-ext.js 的 PBKDF2 口径，勿改动参数） ---- */
function hexEncode(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
async function hashPassword(password, saltHex) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations: 100000 },
    keyMaterial, 256
  );
  return hexEncode(bits);
}
function newSaltHex() {
  return hexEncode(crypto.getRandomValues(new Uint8Array(8)));
}

/* 当前请求路径（审计用） */
function pathOf(request) {
  try {
    return new URL(request.url).pathname;
  } catch (e) {
    return "";
  }
}

/* 客户端 IP（Cloudflare 头优先，best-effort） */
function clientIp(request) {
  try {
    return clip(
      request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "",
      64
    );
  } catch (e) {
    return "";
  }
}

/* User-Agent（审计用） */
function uaOf(request) {
  try {
    return clip(request.headers.get("user-agent") || "", 200);
  } catch (e) {
    return "";
  }
}

/* Cookie 解析，与 index.js 的 parseCookie 同口径 */
function parseCookie(request) {
  const out = {};
  let raw = "";
  try {
    raw = request.headers.get("cookie") || "";
  } catch (e) {
    return out;
  }
  raw.split(";").forEach(function (kv) {
    const i = kv.indexOf("=");
    if (i < 0) return;
    const k = kv.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(kv.slice(i + 1).trim());
    } catch (e) {
      out[k] = kv.slice(i + 1).trim();
    }
  });
  return out;
}

/* 当前请求所用会话 token：X-Token 优先，其次 Cookie `session`
 * （与 index.js 的 adminAuth / 会话口径保持一致） */
function currentToken(request) {
  try {
    const h = (request.headers.get("X-Token") || "").trim();
    if (h) return h.slice(0, 80);
  } catch (e) {
    /* ignore */
  }
  const c = parseCookie(request);
  return clip(c.session, 80);
}

/* 随机 hex 字符串（用于 OAuth state / 会话 token） */
function randHex(bytes) {
  const n = Math.max(1, Math.min(64, parseInt(bytes, 10) || 16));
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    out += (buf[i] < 16 ? "0" : "") + buf[i].toString(16);
  }
  return out;
}

/* Base32（RFC4648 字母表，无填充）—— 用于生成 TOTP 密钥。
 * 20 字节随机数正好编码为 32 个字符，无需 `=` 填充。 */
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | (bytes[i] & 0xff);
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1; /* 防止 value 无限膨胀 */
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/* 生成 TOTP 密钥（20 字节 = 160 bit，RFC4226 推荐长度），Base32 无填充 */
function genTotpSecret() {
  const buf = new Uint8Array(20);
  crypto.getRandomValues(buf);
  return base32Encode(buf);
}

/* Base32 解码（配合上面的 base32Encode；容忍小写与空格，供 TOTP 校验把 secret 还原为字节） */
function base32Decode(str) {
  const s = String(str || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const v = B32_ALPHABET.indexOf(s[i]);
    if (v < 0) continue;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return new Uint8Array(out);
}

/* 计算某个时间步的 TOTP 动态码（RFC6238：HMAC-SHA1，6 位，30 秒步长） */
async function totpCodeAt(secret, counter) {
  const key = base32Decode(secret);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const ck = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", ck, msg));
  const off = sig[sig.length - 1] & 0x0f;
  const bin = ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
  return String(bin % 1000000).padStart(6, "0");
}

/* 校验 TOTP：允许 ±1 个时间窗（共 3 个 30 秒步）以容忍时钟偏移 */
async function verifyTotp(secret, code) {
  if (!secret) return false;
  const c = String(code || "").replace(/\D/g, "");
  if (c.length !== 6) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let d = -1; d <= 1; d++) {
    if (await totpCodeAt(secret, step + d) === c) return true;
  }
  return false;
}

/* 时间格式化：按 UTC+8 输出可读文本（博客面向中文用户） */
function fmtTime(ms) {
  const n = Number(ms);
  if (!n) return "";
  const d = new Date(n + 8 * 3600 * 1000);
  const p = function (x) {
    return (x < 10 ? "0" : "") + x;
  };
  return (
    d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
    " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds())
  );
}

/* 写审计日志（best-effort：表不存在/字段不符都只吞掉，绝不影响主流程）。
 * 列顺序与 moderation.js 的 auditLogStmt 一致：
 * user_id, action, target, method, path, ip, ua, detail, created_at */
async function writeAudit(env, me, request, action, target, detail) {
  try {
    const db = env && env.DB;
    if (!db) return false;
    await db
      .prepare(
        "INSERT INTO audit_logs (user_id, action, target, method, path, ip, ua, detail, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
      )
      .bind(
        me && me.id !== undefined && me.id !== null ? me.id : null,
        clip(action, 80),
        clip(target, 200),
        clip(request ? request.method : "", 10),
        clip(pathOf(request), 200),
        clientIp(request),
        uaOf(request),
        clip(detail, 300),
        nowMs()
      )
      .run();
    return true;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 内置极简 MD5
 * ------------------------------------------------------------------ *
 * 说明：这是「为 Gravatar 兼容而内置的极简 MD5」，只用于把邮箱算成头像 URL 里的
 * 哈希；Web Crypto（crypto.subtle）不提供 MD5，且它是异步 API 而 gravatarUrl 需要
 * 同步返回。**该实现不用于任何安全用途**（不做签名、不做口令哈希）。
 * 输入按 UTF-8 编码，输出 32 位小写 hex。 */

/* 32 位整数 → 小端 hex（8 字符） */
function leHex(v) {
  let s = "";
  for (let i = 0; i < 4; i++) {
    const b = (v >>> (8 * i)) & 0xff;
    s += (b < 16 ? "0" : "") + b.toString(16);
  }
  return s;
}

function md5Hex(input) {
  const bytes = new TextEncoder().encode(String(input === undefined || input === null ? "" : input));
  const n = bytes.length;
  /* 填充：0x80 + 若干 0x00，使 (长度 + 8) 为 64 的倍数 */
  const paddedLen = (((n + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes, 0);
  buf[n] = 0x80;
  /* 末尾 8 字节写入比特长度（小端；支持 >32bit 长度） */
  const bitLen = n * 8;
  const hi = Math.floor(bitLen / 4294967296);
  const lo = bitLen >>> 0;
  for (let i = 0; i < 4; i++) {
    buf[paddedLen - 8 + i] = (lo >>> (8 * i)) & 0xff;
  }
  for (let i = 0; i < 4; i++) {
    buf[paddedLen - 4 + i] = (hi >>> (8 * i)) & 0xff;
  }

  /* K[i] = floor(abs(sin(i + 1)) * 2^32) */
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  }
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let off = 0; off < paddedLen; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      const p = off + 4 * i;
      M[i] = (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0;
    }
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F;
      let g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      const s = S[i];
      B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }
  return leHex(a0) + leHex(b0) + leHex(c0) + leHex(d0);
}

/* ------------------------------------------------------------------ *
 * FR-X15 用户资料与头像
 * ------------------------------------------------------------------ */

/* 邮箱基础格式校验（不做严格 RFC 校验，够用即可） */
function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || "").trim());
}

/* 头像地址白名单：
 *  - 站内上传路径 /api/uploads/<id>（推荐：头像复用 uploads 表存 base64）
 *  - https:// 开头的外部图片
 * 其它（javascript: / data: / http: 明文外链）一律拒绝，防 XSS 与外链注入 */
function isSafeAvatar(v) {
  const s = String(v || "").trim();
  if (!s) return false;
  if (s.indexOf("/api/uploads/") === 0) return true;
  return /^https:\/\/[^\s"']+$/i.test(s);
}

/* 个人站点地址：必须是 http(s):// 开头 */
function isSafeWebsite(v) {
  return /^https?:\/\/[^\s"']+$/i.test(String(v || "").trim());
}

/* social_json → 对象；解析失败给 {} */
function parseSocial(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const obj = JSON.parse(String(raw));
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
    return {};
  } catch (e) {
    return {};
  }
}

/* 合并 users 与 user_profiles：user_profiles 优先（非空值），缺失/为空时退回 users */
function pickStr(primary, fallback) {
  if (primary !== undefined && primary !== null && String(primary) !== "") return String(primary);
  if (fallback !== undefined && fallback !== null) return String(fallback);
  return "";
}

/* 读取 users 行（宽表，缺列时由调用方降级） */
async function loadUserRow(db, userId) {
  try {
    return await db.prepare("SELECT * FROM users WHERE id = ?1").bind(userId).first();
  } catch (e) {
    return null;
  }
}

/* 读取 user_profiles 行（表/列不存在时返回 null，属于「降级」路径） */
async function loadProfileRow(db, userId) {
  try {
    return await db
      .prepare("SELECT * FROM user_profiles WHERE user_id = ?1")
      .bind(userId)
      .first();
  } catch (e) {
    return null;
  }
}

/* 组装对外资料结构（user_profiles 优先） */
function buildProfileOut(user, profile) {
  const p = profile || {};
  const u = user || {};
  const social = parseSocial(
    (p.social_json !== undefined && p.social_json !== null && String(p.social_json) !== "")
      ? p.social_json
      : u.social_json
  );
  return {
    username: u.username || "",
    nickname: pickStr(p.nickname, u.nickname) || u.username || "",
    email: pickStr(p.email, u.email),
    role: u.role || "user",
    email_verified: u.email_verified === undefined || u.email_verified === null
      ? 0
      : Number(u.email_verified) || 0,
    avatar: pickStr(p.avatar, u.avatar),
    bio: pickStr(p.bio, u.bio),
    website: pickStr(p.website, u.website),
    location: pickStr(p.location, ""),
    social: social,
  };
}

/**
 * GET|POST /api/my/profile —— FR-X15 我的资料（含头像）
 * 头像走「复用 uploads 表 + /api/uploads/<id> 路径」的方案，本接口只校验与保存路径。
 */
export async function handleMyProfile(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true }, 200);
  if (!me || me.id === undefined || me.id === null) {
    return jsonResp({ ok: false, msg: "请先登录" }, 401);
  }
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  /* ---------------- GET：读取合并后的资料 ---------------- */
  if (request.method === "GET") {
    const user = await loadUserRow(db, me.id);
    if (!user) return jsonResp({ ok: false, msg: "用户不存在" }, 404);
    const profile = await loadProfileRow(db, me.id);
    return jsonResp({ ok: true, data: buildProfileOut(user, profile) }, 200);
  }

  if (request.method !== "POST") {
    return jsonResp({ ok: false, msg: "不支持的请求方法" }, 405);
  }

  /* ---------------- POST：校验 + 保存 ---------------- */
  const body = await readBody(request);
  const user = await loadUserRow(db, me.id);
  if (!user) return jsonResp({ ok: false, msg: "用户不存在" }, 404);

  const patch = {};

  if (body.nickname !== undefined) {
    const nickname = String(body.nickname || "").trim();
    if (nickname.length > 40) return jsonResp({ ok: false, msg: "昵称最长 40 个字符" }, 400);
    patch.nickname = nickname;
  }
  if (body.email !== undefined) {
    const email = String(body.email || "").trim().slice(0, 120);
    if (!isEmail(email)) return jsonResp({ ok: false, msg: "邮箱格式不正确" }, 400);
    patch.email = email;
  }
  if (body.avatar !== undefined) {
    const avatar = String(body.avatar || "").trim().slice(0, 300);
    /* 空字符串 = 清除头像（合法）；非空必须命中白名单 */
    if (avatar !== "" && !isSafeAvatar(avatar)) {
      return jsonResp(
        { ok: false, msg: "头像地址不合法：只允许 /api/uploads/ 站内路径或 https:// 图片" },
        400
      );
    }
    patch.avatar = avatar;
  }
  if (body.bio !== undefined) {
    const bio = String(body.bio || "").trim();
    if (bio.length > 300) return jsonResp({ ok: false, msg: "简介最长 300 个字符" }, 400);
    patch.bio = bio;
  }
  if (body.website !== undefined) {
    const website = String(body.website || "").trim().slice(0, 200);
    if (website !== "" && !isSafeWebsite(website)) {
      return jsonResp({ ok: false, msg: "个人站点必须以 http:// 或 https:// 开头" }, 400);
    }
    patch.website = website;
  }
  if (body.location !== undefined) {
    const location = String(body.location || "").trim();
    if (location.length > 60) return jsonResp({ ok: false, msg: "所在地最长 60 个字符" }, 400);
    patch.location = location;
  }
  if (body.social !== undefined) {
    let socialObj = body.social;
    if (typeof socialObj === "string") {
      try {
        socialObj = JSON.parse(socialObj);
      } catch (e) {
        return jsonResp({ ok: false, msg: "social 必须是 JSON 对象" }, 400);
      }
    }
    if (!socialObj || typeof socialObj !== "object" || Array.isArray(socialObj)) {
      return jsonResp({ ok: false, msg: "social 必须是 JSON 对象" }, 400);
    }
    let json = "";
    try {
      json = JSON.stringify(socialObj);
    } catch (e) {
      return jsonResp({ ok: false, msg: "social 序列化失败" }, 400);
    }
    if (json.length > 1000) return jsonResp({ ok: false, msg: "社交信息过长（≤1000 字符）" }, 400);
    patch.social_json = json;
  }

  if (Object.keys(patch).length === 0) {
    const profile0 = await loadProfileRow(db, me.id);
    return jsonResp({ ok: true, data: buildProfileOut(user, profile0), msg: "没有需要更新的字段" }, 200);
  }

  /* --- 1) users 侧：只更新「该行真实存在」的列；缺列时自动跳过（降级） --- */
  const userCols = ["nickname", "email", "avatar", "bio", "website", "social_json"];
  const present = userCols.filter(function (c) {
    return Object.prototype.hasOwnProperty.call(user, c) && patch[c] !== undefined;
  });
  if (present.length > 0) {
    const sets = present.map(function (c, i) {
      return c + " = ?" + (i + 2);
    });
    const params = [me.id].concat(present.map(function (c) {
      return patch[c];
    }));
    try {
      /* 绑定参数形如：?1 = id, ?2.. = 各列值（列名来自固定白名单，无注入风险） */
      await db
        .prepare("UPDATE users SET " + sets.join(", ") + " WHERE id = ?1")
        .bind(...params)
        .run();
    } catch (e) {
      /* 整条 UPDATE 失败（老库列缺失等）→ 降级只更新 nickname / email */
      try {
        await db
          .prepare("UPDATE users SET nickname = ?2, email = ?3 WHERE id = ?1")
          .bind(
            me.id,
            patch.nickname !== undefined ? patch.nickname : (user.nickname || ""),
            patch.email !== undefined ? patch.email : (user.email || "")
          )
          .run();
      } catch (e2) {
        return jsonResp({ ok: false, msg: "资料保存失败（users 表字段不兼容）" }, 500);
      }
    }
  }

  /* --- 2) user_profiles 侧：先读旧值合并，再 upsert（表不存在 → 降级跳过） --- */
  try {
    const old = (await loadProfileRow(db, me.id)) || {};
    const merged = {
      avatar: patch.avatar !== undefined ? patch.avatar : (old.avatar || ""),
      bio: patch.bio !== undefined ? patch.bio : (old.bio || ""),
      website: patch.website !== undefined ? patch.website : (old.website || ""),
      location: patch.location !== undefined ? patch.location : (old.location || ""),
      social_json: patch.social_json !== undefined ? patch.social_json : (old.social_json || ""),
    };
    await db
      .prepare(
        "INSERT INTO user_profiles (user_id, avatar, bio, website, location, social_json, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) " +
        "ON CONFLICT(user_id) DO UPDATE SET " +
        "avatar = excluded.avatar, bio = excluded.bio, website = excluded.website, " +
        "location = excluded.location, social_json = excluded.social_json, " +
        "updated_at = excluded.updated_at"
      )
      .bind(
        me.id,
        clip(merged.avatar, 300),
        clip(merged.bio, 300),
        clip(merged.website, 200),
        clip(merged.location, 60),
        clip(merged.social_json, 1000),
        nowMs()
      )
      .run();
  } catch (e) {
    /* user_profiles 表缺失 / 列不符：忽略，users 侧已写入（降级） */
  }

  await writeAudit(env, me, request, "user.profile.update", "user:" + me.id,
    "fields=" + Object.keys(patch).join(","));

  const fresh = await loadUserRow(db, me.id);
  const profile = await loadProfileRow(db, me.id);
  return jsonResp({ ok: true, data: buildProfileOut(fresh || user, profile) }, 200);
}

/* ------------------------------------------------------------------ *
 * FR-X16 会话管理
 * ------------------------------------------------------------------ */

/**
 * GET|DELETE /api/my/sessions —— FR-X16 我的登录会话管理
 *  - GET    : 列出本人所有未过期会话（只返回 token 前 8 位，绝不返回完整 token）
 *  - DELETE : body {token_prefix} 或 {all:true} 踢掉会话（all 时保留当前会话）
 */
export async function handleMySessions(request, env, me) {
  /* 注意：默认 CORS 头（与 index.js json() 一致）只声明 GET, POST, OPTIONS，
   * 浏览器在其它源用 DELETE 踢会话会被预检拦下。若前端要跨源 DELETE，把本行改为：
   * return jsonResp({ ok: true }, 200, { "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" }); */
  if (request.method === "OPTIONS") return jsonResp({ ok: true }, 200);
  if (!me || me.id === undefined || me.id === null) {
    return jsonResp({ ok: false, msg: "请先登录" }, 401);
  }
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const now = nowMs();
  const mine = currentToken(request);

  /* ---------------- GET：会话列表 ---------------- */
  if (request.method === "GET") {
    let rows = [];
    try {
      const res = await db
        .prepare(
          "SELECT token, created_at, expire_at FROM sessions " +
          "WHERE user_id = ?1 AND expire_at > ?2 ORDER BY created_at DESC LIMIT 100"
        )
        .bind(me.id, now)
        .all();
      rows = (res && res.results) || [];
    } catch (e) {
      return jsonResp({ ok: false, msg: "会话查询失败" }, 500);
    }
    const list = rows.map(function (r) {
      const token = String(r.token || "");
      return {
        token_prefix: token.slice(0, 8),
        created_at: Number(r.created_at) || 0,
        expire_at: Number(r.expire_at) || 0,
        created_text: fmtTime(r.created_at),
        expire_text: fmtTime(r.expire_at),
        current: !!mine && token === mine,
      };
    });
    return jsonResp({ ok: true, data: { list: list, total: list.length } }, 200);
  }

  /* 兼容 POST（部分前端只会发 POST）与 DELETE 两种写法，body 语义相同 */
  if (request.method !== "DELETE" && request.method !== "POST") {
    return jsonResp({ ok: false, msg: "不支持的请求方法" }, 405);
  }

  /* ---------------- DELETE：踢会话 ---------------- */
  const body = await readBody(request);
  let deleted = 0;

  if (body.all === true) {
    if (!mine) {
      return jsonResp(
        { ok: false, msg: "无法识别当前会话，请重新登录后再操作" },
        400
      );
    }
    try {
      const res = await db
        .prepare("DELETE FROM sessions WHERE user_id = ?1 AND token <> ?2")
        .bind(me.id, mine)
        .run();
      deleted = (res && res.meta && Number(res.meta.changes)) || 0;
    } catch (e) {
      return jsonResp({ ok: false, msg: "会话删除失败" }, 500);
    }
  } else {
    const prefix = String(body.token_prefix || body.prefix || "").trim().toLowerCase();
    if (!prefix) return jsonResp({ ok: false, msg: "缺少 token_prefix（或传 all:true）" }, 400);
    if (!/^[0-9a-f]{4,80}$/.test(prefix)) {
      return jsonResp({ ok: false, msg: "token_prefix 不合法" }, 400);
    }
    try {
      /* ?2 = prefix + "%"：按前缀匹配本用户的会话（token 为随机 hex，前缀足够区分） */
      const res = await db
        .prepare("DELETE FROM sessions WHERE user_id = ?1 AND token LIKE ?2")
        .bind(me.id, prefix + "%")
        .run();
      deleted = (res && res.meta && Number(res.meta.changes)) || 0;
    } catch (e) {
      return jsonResp({ ok: false, msg: "会话删除失败" }, 500);
    }
  }

  await writeAudit(env, me, request, "user.session.revoke", "user:" + me.id,
    body.all === true ? "all=true;deleted=" + deleted : "prefix=" + clip(body.token_prefix, 16) + ";deleted=" + deleted);

  return jsonResp({ ok: true, data: { deleted: deleted }, msg: "已退出 " + deleted + " 个会话" }, 200);
}

/* ------------------------------------------------------------------ *
 * FR-X17 2FA 骨架
 * ------------------------------------------------------------------ */

/* 读取用户的两因子密钥（列不存在时返回 ""，属于老库降级路径） */
async function load2faSecret(db, userId) {
  try {
    const row = await db
      .prepare("SELECT two_factor_secret FROM users WHERE id = ?1")
      .bind(userId)
      .first();
    return row && row.two_factor_secret ? String(row.two_factor_secret) : "";
  } catch (e) {
    return "";
  }
}

/**
 * GET|POST /api/my/2fa —— FR-X17 两步验证（2FA）【骨架】
 *
 * ⚠️ 重要说明（骨架边界）：
 *  1. 本接口只实现「安全地生成 TOTP 密钥 + 记录开关状态」，
 *     **不做真实的 TOTP 校验**（不校验用户提交的 6 位动态码）。
 *  2. **登录流程尚未校验 2FA**：index.js 的 handleLogin / handleUserLogin 目前
 *     只看密码，即使这里 enabled=true，攻击者仅凭密码仍可登录。
 *     真正上线时必须：登录校验密码通过后，若 two_factor_secret 非空则要求动态码
 *     （HMAC-SHA1 over 时间步长，Web Crypto 可算，但那是另一次改动），
 *     并补一次性恢复码与「信任本设备」逻辑。
 *  3. 因此本接口返回的 enabled 只是「已配置密钥」的展示状态，不等同于安全增强。
 */
export async function handleMy2fa(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true }, 200);
  if (!me || me.id === undefined || me.id === null) {
    return jsonResp({ ok: false, msg: "请先登录" }, 401);
  }
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  /* ---------------- GET：查看 2FA 状态 ---------------- */
  if (request.method === "GET") {
    const secret = await load2faSecret(db, me.id);
    return jsonResp(
      {
        ok: true,
        data: { enabled: !!secret, has_secret: !!secret },
        msg: "2FA 为骨架实现：登录流程尚未校验动态码",
      },
      200
    );
  }

  if (request.method !== "POST") {
    return jsonResp({ ok: false, msg: "不支持的请求方法" }, 405);
  }

  /* ---------------- POST：setup / enable / disable ---------------- */
  const body = await readBody(request);
  const action = String(body.action || "").toLowerCase();

  if (action === "setup") {
    const secret = genTotpSecret();
    try {
      await db
        .prepare("UPDATE users SET two_factor_secret = ?2 WHERE id = ?1")
        .bind(me.id, secret)
        .run();
    } catch (e) {
      return jsonResp(
        { ok: false, msg: "写入 two_factor_secret 失败：请确认 users 表已含该列" },
        500
      );
    }
    /* 用户名：优先用 me.username，缺失时回查 DB */
    let username = me.username || "";
    if (!username) {
      try {
        const row = await db
          .prepare("SELECT username FROM users WHERE id = ?1")
          .bind(me.id)
          .first();
        username = row && row.username ? String(row.username) : "user";
      } catch (e) {
        username = "user";
      }
    }
    const issuer = "清逸的博客";
    /* otpauth:// 的 label/issuer 含中文，必须 encodeURIComponent */
    const otpauth =
      "otpauth://totp/" + encodeURIComponent(issuer) + ":" + encodeURIComponent(username) +
      "?secret=" + encodeURIComponent(secret) + "&issuer=" + encodeURIComponent(issuer);

    await writeAudit(env, me, request, "user.2fa.setup", "user:" + me.id, "secret_len=" + secret.length);

    return jsonResp(
      {
        ok: true,
        data: { secret: secret, otpauth_url: otpauth },
        msg: "密钥已生成（骨架：登录尚未校验动态码，请勿据此认为账号已受保护）",
      },
      200
    );
  }

  if (action === "enable") {
    const secret = await load2faSecret(db, me.id);
    if (!secret) {
      return jsonResp({ ok: false, msg: "请先调用 action=setup 生成密钥" }, 400);
    }
    await writeAudit(env, me, request, "user.2fa.enable", "user:" + me.id, "skeleton");
    return jsonResp(
      { ok: true, data: { enabled: true }, msg: "已记录；TOTP 校验逻辑待接入（骨架）" },
      200
    );
  }

  if (action === "disable") {
    try {
      await db
        .prepare("UPDATE users SET two_factor_secret = ?2 WHERE id = ?1")
        .bind(me.id, "")
        .run();
    } catch (e) {
      return jsonResp({ ok: false, msg: "清除 two_factor_secret 失败" }, 500);
    }
    await writeAudit(env, me, request, "user.2fa.disable", "user:" + me.id, "cleared");
    return jsonResp({ ok: true, data: { enabled: false }, msg: "已关闭两步验证" }, 200);
  }

  return jsonResp({ ok: false, msg: 'action 只支持 "setup" / "enable" / "disable"' }, 400);
}

/* ------------------------------------------------------------------ *
 * 修改密码（POST /api/my/password）：校验旧密码 + 可选 TOTP 动态码
 * ------------------------------------------------------------------ */

/* 校验旧密码是否匹配（复用 index.js 的 PBKDF2 口径，本模块自带实现） */
async function verifyPasswordHash(password, saltHex, expectHex) {
  try {
    const salt = hexToBytes(saltHex);
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(String(password)), "PBKDF2", false, ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" }, key, 256
    );
    const hex = hexEncode(new Uint8Array(bits));
    return hex === expectHex;
  } catch (e) {
    return false;
  }
}

export async function handleMyPassword(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true }, 200);
  if (!me) return jsonResp({ ok: false, msg: "请先登录" }, 401);
  if (request.method !== "POST") return jsonResp({ ok: false, msg: "方法不支持" }, 405);
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const body = await readBody(request);
  const oldPw = String(body.old_password || "");
  const newPw = String(body.new_password || "");
  const totp = String(body.totp || "").trim();

  if (!oldPw) return jsonResp({ ok: false, msg: "请输入当前密码" }, 400);
  if (newPw.length < 6) return jsonResp({ ok: false, msg: "新密码至少 6 位" }, 400);

  try {
    const user = await db.prepare(
      "SELECT id, pass_salt, pass_hash, two_factor_secret FROM users WHERE id = ?1"
    ).bind(me.id).first();
    if (!user) return jsonResp({ ok: false, msg: "用户不存在" }, 404);

    // ① 校验旧密码
    const okOld = await verifyPasswordHash(oldPw, user.pass_salt, user.pass_hash);
    if (!okOld) return jsonResp({ ok: false, msg: "当前密码不正确" }, 400);

    // ② 若已绑定 2FA，则必须校验 TOTP 动态码
    const secret = user.two_factor_secret ? String(user.two_factor_secret) : "";
    if (secret) {
      if (!totp) return jsonResp({ ok: false, msg: "该账号已开启两步验证，请输入动态验证码" }, 400);
      const okTotp = await verifyTotp(secret, totp);
      if (!okTotp) return jsonResp({ ok: false, msg: "动态验证码不正确或已过期" }, 400);
    }

    // ③ 生成新盐 + 新哈希，更新密码
    const newSalt = newSaltHex();
    const newHash = await hashPassword(newPw, newSalt);
    await db.prepare("UPDATE users SET pass_salt = ?2, pass_hash = ?3 WHERE id = ?1")
      .bind(me.id, newSalt, newHash).run();

    // ④ 踢掉该用户全部会话（改密后强制重新登录）
    try { await db.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(me.id).run(); } catch (e) {}

    await writeAudit(env, me, request, "user.password.change", "user:" + me.id, "");
    return jsonResp({ ok: true, msg: "密码已修改，请重新登录" }, 200);
  } catch (e) {
    return jsonResp({ ok: false, msg: "修改失败，请稍后再试" }, 500);
  }
}

/* ------------------------------------------------------------------ *
 * 「我的收藏 / 我的评论 / 我的点赞」列表（GET，均需登录）
 * ------------------------------------------------------------------ */

/* GET /api/my/bookmarks：按 user_id 查收藏，关联文章标题 */
export async function handleMyBookmarks(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true }, 200);
  if (!me) return jsonResp({ ok: false, msg: "请先登录" }, 401);
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);
  try {
    const rows = await db.prepare(
      "SELECT b.post_id, b.created_at, p.title, p.source_file " +
      "FROM article_bookmarks b JOIN posts p ON p.id = b.post_id " +
      "WHERE b.user_id = ?1 AND p.status = 1 ORDER BY b.created_at DESC LIMIT 200"
    ).bind(me.id).all();
    const list = (rows.results || []).map((r) => ({
      post_id: r.post_id,
      source_file: r.source_file || "",
      title: r.title || "（文章已删除）",
      created_at: r.created_at,
      created_text: fmtTime(r.created_at),
    }));
    return jsonResp({ ok: true, data: { list, total: list.length } }, 200);
  } catch (e) {
    return jsonResp({ ok: true, data: { list: [], total: 0 }, note: "扩展表未创建" }, 200);
  }
}

/* GET /api/my/comments：按作者名（登录昵称/用户名）查自己的评论。
 * 注：评论表无 user_id，仅按 author 文本匹配，匿名同名评论可能一并列出（数据模型所限）。 */
export async function handleMyComments(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true }, 200);
  if (!me) return jsonResp({ ok: false, msg: "请先登录" }, 401);
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);
  const author = String(me.nickname || me.username || "");
  if (!author) return jsonResp({ ok: false, msg: "无法确定评论署名" }, 400);
  try {
    const rows = await db.prepare(
      "SELECT id, post_id, page_id, content, status, zan, cai, created_at " +
      "FROM comments WHERE author = ?1 ORDER BY id DESC LIMIT 200"
    ).bind(author).all();
    const list = (rows.results || []).map((r) => ({
      id: r.id,
      post_id: r.post_id,
      page_id: r.page_id,
      content: String(r.content || "").slice(0, 300),
      status: r.status,
      zan: r.zan || 0,
      cai: r.cai || 0,
      created_at: r.created_at,
      created_text: fmtTime(r.created_at),
    }));
    return jsonResp({ ok: true, data: { list, total: list.length } }, 200);
  } catch (e) {
    return jsonResp({ ok: true, data: { list: [], total: 0 }, note: "查询失败" }, 200);
  }
}

/* GET /api/my/likes：按 user_id 查点赞的文章。
 * 依赖 article_likes 表新增的 user_id 列（见 extend-schema ALTER + likes.js 落库）。 */
export async function handleMyLikes(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true }, 200);
  if (!me) return jsonResp({ ok: false, msg: "请先登录" }, 401);
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);
  try {
    const rows = await db.prepare(
      "SELECT l.post_id, l.created_at, p.title, p.source_file " +
      "FROM article_likes l JOIN posts p ON p.id = l.post_id " +
      "WHERE l.user_id = ?1 AND p.status = 1 ORDER BY l.created_at DESC LIMIT 200"
    ).bind(me.id).all();
    const list = (rows.results || []).map((r) => ({
      post_id: r.post_id,
      source_file: r.source_file || "",
      title: r.title || "（文章已删除）",
      created_at: r.created_at,
      created_text: fmtTime(r.created_at),
    }));
    return jsonResp({ ok: true, data: { list, total: list.length } }, 200);
  } catch (e) {
    return jsonResp({ ok: true, data: { list: [], total: 0 }, note: "article_likes.user_id 列未创建或查询失败" }, 200);
  }
}

/* ------------------------------------------------------------------ *
 * FR-X18 第三方登录骨架（OAuth）
 * ------------------------------------------------------------------ */

/* 从请求路径取 OAuth provider：
 * 路径形如 /api/oauth/<provider>/start 或 /api/oauth/<provider>/callback，
 * 因此取倒数第二段（最后一段是动作）。 */
function oauthProviderOf(request) {
  try {
    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    const last = String(parts[parts.length - 1] || "").toLowerCase();
    if (last === "start" || last === "callback") {
      return String(parts[parts.length - 2] || "").toLowerCase();
    }
    return last;
  } catch (e) {
    return "";
  }
}

/* 由当前 start 请求推导 callback 地址（同源、同前缀，只把 start 换成 callback） */
function oauthCallbackUrl(request) {
  try {
    const u = new URL(request.url);
    let p = u.pathname.replace(/\/+$/, "");
    if (/\/start$/i.test(p)) {
      p = p.replace(/\/start$/i, "/callback");
    } else if (!/\/callback$/i.test(p)) {
      p = p + "/callback";
    }
    return u.origin + p;
  } catch (e) {
    return "";
  }
}

/* 302 跳转响应 */
function redirectResp(location) {
  return new Response(null, {
    status: 302,
    headers: {
      location: location,
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

/**
 * GET /api/oauth/:provider/start —— FR-X18 第三方登录【骨架】
 *
 * ⚠️ 骨架边界：
 *  - 只在配置了 env.GITHUB_CLIENT_ID 时才跳转，未配置返回 501，不报错、不影响站点。
 *  - 生成的 state **不落库、回调时也不校验**（骨架：未做 state 校验，接真实登录时必须补
 *    —— 真实实现要把 state 写入 cookie/D1 并在 callback 比对，防 CSRF）。
 *  - 未做授权后的自动建号，仅绑定已存在的 oauth_accounts 记录。
 */
export async function handleOAuthStart(request, env) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true }, 200);

  const provider = oauthProviderOf(request);
  if (provider !== "github") {
    return jsonResp({ ok: false, msg: "暂不支持该第三方登录" }, 400);
  }

  const clientId = env && env.GITHUB_CLIENT_ID ? String(env.GITHUB_CLIENT_ID) : "";
  if (!clientId) {
    return jsonResp(
      { ok: false, msg: "未配置 GITHUB_CLIENT_ID，第三方登录暂不可用（骨架）" },
      501
    );
  }

  const callback = oauthCallbackUrl(request);
  /* state 仅用于占位：未落库、未校验（见上方骨架说明） */
  const state = randHex(16);
  const authorize =
    "https://github.com/login/oauth/authorize" +
    "?client_id=" + encodeURIComponent(clientId) +
    "&redirect_uri=" + encodeURIComponent(callback) +
    "&scope=read:user%20user:email" +
    "&state=" + encodeURIComponent(state);

  await writeAudit(env, null, request, "oauth.start", "provider:" + provider, "state=" + clip(state, 16));

  return redirectResp(authorize);
}

/**
 * GET /api/oauth/:provider/callback —— FR-X18 第三方登录回调【骨架】
 *
 * ⚠️ 骨架边界：
 *  - **不做自动建号**：GitHub 账号未在 oauth_accounts 绑定时，返回提示让用户先用
 *    账号密码登录后在资料页绑定，避免误建账号 / 越权登录。
 *  - 不校验 state（骨架，接真实登录必须补）。
 *  - 成功时创建 8 小时会话并 Set-Cookie（与 index.js handleUserLogin 口径一致：
 *    HttpOnly + SameSite=Lax + Max-Age=28800）。
 */
export async function handleOAuthCallback(request, env) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true }, 200);

  const provider = oauthProviderOf(request);
  if (provider !== "github") {
    return jsonResp({ ok: false, msg: "暂不支持该第三方登录" }, 400);
  }

  const clientId = env && env.GITHUB_CLIENT_ID ? String(env.GITHUB_CLIENT_ID) : "";
  const clientSecret = env && env.GITHUB_CLIENT_SECRET ? String(env.GITHUB_CLIENT_SECRET) : "";
  if (!clientId || !clientSecret) {
    return jsonResp(
      { ok: false, msg: "未配置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET，第三方登录暂不可用（骨架）" },
      501
    );
  }

  const url = new URL(request.url);
  const code = String(url.searchParams.get("code") || "").trim();
  const oauthErr = String(url.searchParams.get("error") || "").trim();
  if (oauthErr) {
    return jsonResp(
      { ok: false, msg: "GitHub 授权被拒绝：" + clip(oauthErr, 80) },
      400
    );
  }
  if (!code) return jsonResp({ ok: false, msg: "缺少 code 参数" }, 400);

  try {
    /* --- 1) code 换 access_token --- */
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: code }),
    });
    const tokenData = await tokenRes.json().catch(function () {
      return {};
    });
    const accessToken = tokenData && tokenData.access_token ? String(tokenData.access_token) : "";
    if (!accessToken) {
      const why = (tokenData && (tokenData.error_description || tokenData.error)) || "未知错误";
      return jsonResp({ ok: false, msg: "GitHub 换取 token 失败：" + clip(why, 200) }, 502);
    }

    /* --- 2) 拉取 GitHub 用户资料 --- */
    const userRes = await fetch("https://api.github.com/user", {
      headers: { authorization: "Bearer " + accessToken, "user-agent": "qingyi-blog-worker" },
    });
    const ghUser = await userRes.json().catch(function () {
      return {};
    });
    if (!ghUser || ghUser.id === undefined || ghUser.id === null) {
      const why = (ghUser && ghUser.message) || ("HTTP " + userRes.status);
      return jsonResp({ ok: false, msg: "获取 GitHub 用户信息失败：" + clip(why, 200) }, 502);
    }

    const openId = String(ghUser.id);
    const unionId = ghUser.node_id ? String(ghUser.node_id) : "";

    /* --- 3) 按 (provider, open_id) 查绑定 --- */
    const db = env.DB;
    if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);
    const bound = await db
      .prepare(
        "SELECT a.id AS oauth_id, u.id, u.username, u.nickname, u.email, u.avatar, u.role, u.status " +
        "FROM oauth_accounts a JOIN users u ON u.id = a.user_id " +
        "WHERE a.provider = ?1 AND a.open_id = ?2 LIMIT 1"
      )
      .bind(provider, openId)
      .first();

    if (!bound) {
      /* 不做自动建号（骨架）：提示先绑定 */
      await writeAudit(env, null, request, "oauth.callback.unbound", "provider:" + provider,
        "open_id=" + clip(openId, 40) + ";union_id=" + clip(unionId, 40));
      return jsonResp(
        { ok: false, msg: "该 GitHub 账号尚未绑定，请先用账号密码登录后在资料页绑定（骨架）" },
        200
      );
    }
    if (bound.status !== undefined && bound.status !== null && Number(bound.status) !== 1) {
      return jsonResp({ ok: false, msg: "该账号已被禁用" }, 403);
    }

    /* --- 4) 建会话（8 小时，与 handleUserLogin 口径一致） --- */
    const token = randHex(24);
    const now = nowMs();
    await db
      .prepare("INSERT INTO sessions (token, user_id, created_at, expire_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(token, bound.id, now, now + 8 * 3600 * 1000)
      .run();

    /* best-effort：同步最新昵称/头像到 oauth_accounts（失败忽略） */
    try {
      await db
        .prepare("UPDATE oauth_accounts SET nickname = ?3, avatar = ?4 WHERE id = ?1 AND user_id = ?2")
        .bind(
          bound.oauth_id,
          bound.id,
          clip(ghUser.name || ghUser.login || "", 80),
          clip(ghUser.avatar_url || "", 300)
        )
        .run();
    } catch (e) {
      /* ignore */
    }

    await writeAudit(env, { id: bound.id }, request, "oauth.callback.login", "user:" + bound.id,
      "provider=" + provider + ";open_id=" + clip(openId, 40));

    return jsonResp(
      {
        ok: true,
        data: {
          token: token,
          provider: provider,
          user: {
            id: bound.id,
            username: bound.username || "",
            nickname: bound.nickname || bound.username || "",
            email: bound.email || "",
            avatar: bound.avatar || "",
            role: bound.role || "user",
          },
        },
        msg: "第三方登录成功（骨架：session token 同时通过 Set-Cookie 下发）",
      },
      200,
      { "set-cookie": "session=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800" }
    );
  } catch (e) {
    return jsonResp(
      { ok: false, msg: "第三方登录失败：" + clip(e && e.message ? e.message : String(e), 200) },
      502
    );
  }
}

/* ------------------------------------------------------------------ *
 * 后台总览
 * ------------------------------------------------------------------ */

/**
 * GET|POST /api/admin/users-ext —— 用户扩展总览（会话数 / 2FA 状态 / 踢会话）
 * 需要 super_admin（模块内再校验一次，避免接线处漏判）。
 *  - GET  : 用户总览；带 ?user_id= 时返回该用户会话列表
 *  - POST : {action:"revoke_sessions", user_id} 删除该用户全部会话
 * 说明：总览只用 2~3 条聚合查询（一条 users 列表 + 一条 sessions 分组统计），
 *       不做逐用户子查询，避免 N+1。
 */
export async function handleAdminUsersExt(request, env, me) {
  if (request.method === "OPTIONS") return jsonResp({ ok: true }, 200);
  if (!me || me.id === undefined || me.id === null) {
    return jsonResp({ ok: false, msg: "请先登录" }, 401);
  }
  if (String(me.role || "") !== "super_admin") {
    return jsonResp({ ok: false, msg: "需要超级管理员权限" }, 403);
  }
  const db = env && env.DB;
  if (!db) return jsonResp({ ok: false, msg: "数据库未绑定" }, 500);

  const url = new URL(request.url);
  const now = nowMs();

  /* ---------------- GET ---------------- */
  if (request.method === "GET") {
    const targetId = parseInt(url.searchParams.get("user_id") || "0", 10) || 0;

    /* 1) 某用户的会话列表 */
    if (targetId > 0) {
      let rows = [];
      try {
        const res = await db
          .prepare(
            "SELECT token, created_at, expire_at FROM sessions " +
            "WHERE user_id = ?1 AND expire_at > ?2 ORDER BY created_at DESC LIMIT 200"
          )
          .bind(targetId, now)
          .all();
        rows = (res && res.results) || [];
      } catch (e) {
        return jsonResp({ ok: false, msg: "会话查询失败" }, 500);
      }
      const mine = currentToken(request);
      const list = rows.map(function (r) {
        const token = String(r.token || "");
        return {
          token_prefix: token.slice(0, 8),
          created_at: Number(r.created_at) || 0,
          expire_at: Number(r.expire_at) || 0,
          created_text: fmtTime(r.created_at),
          expire_text: fmtTime(r.expire_at),
          current: !!mine && token === mine,
        };
      });
      return jsonResp({ ok: true, data: { user_id: targetId, list: list, total: list.length } }, 200);
    }

    /* 2) 用户总览：先试带 email_verified / two_factor_secret 的宽查询，失败再降级 */
    let userRows = [];
    let with2faCol = true;
    try {
      const res = await db
        .prepare(
          "SELECT id, username, role, status, last_login_at, email_verified, two_factor_secret " +
          "FROM users ORDER BY id DESC LIMIT 200"
        )
        .all();
      userRows = (res && res.results) || [];
    } catch (e) {
      with2faCol = false;
      try {
        const res2 = await db
          .prepare("SELECT id, username, role, status FROM users ORDER BY id DESC LIMIT 200")
          .all();
        userRows = (res2 && res2.results) || [];
      } catch (e2) {
        return jsonResp({ ok: false, msg: "用户查询失败" }, 500);
      }
    }

    /* 3) 会话数：一条 GROUP BY 聚合（不逐用户子查询） */
    const sessionMap = {};
    try {
      const res = await db
        .prepare(
          "SELECT user_id, COUNT(*) AS c FROM sessions WHERE expire_at > ?1 GROUP BY user_id"
        )
        .bind(now)
        .all();
      (res && res.results ? res.results : []).forEach(function (r) {
        sessionMap[String(r.user_id)] = Number(r.c) || 0;
      });
    } catch (e) {
      /* 会话统计失败不影响总览主体，计数按 0 处理 */
    }

    const users = userRows.map(function (r) {
      return {
        id: r.id,
        username: r.username || "",
        role: r.role || "user",
        status: r.status === undefined || r.status === null ? 1 : Number(r.status),
        session_count: sessionMap[String(r.id)] || 0,
        last_login_at: r.last_login_at === undefined || r.last_login_at === null
          ? 0
          : Number(r.last_login_at) || 0,
        email_verified: r.email_verified === undefined || r.email_verified === null
          ? 0
          : Number(r.email_verified) || 0,
        has_2fa: with2faCol ? !!r.two_factor_secret : false,
      };
    });

    return jsonResp(
      {
        ok: true,
        data: {
          list: users,
          total: users.length,
          degraded: !with2faCol,
          note: "has_2fa 仅表示已生成密钥；登录流程尚未校验 2FA（骨架）",
        },
      },
      200
    );
  }

  /* ---------------- POST：踢会话 ---------------- */
  if (request.method !== "POST") {
    return jsonResp({ ok: false, msg: "不支持的请求方法" }, 405);
  }

  const body = await readBody(request);
  const action = String(body.action || "").toLowerCase();
  if (action !== "revoke_sessions") {
    return jsonResp({ ok: false, msg: 'action 只支持 "revoke_sessions"' }, 400);
  }
  const userId = parseInt(body.user_id, 10) || 0;
  if (userId <= 0) return jsonResp({ ok: false, msg: "user_id 不合法" }, 400);
  if (userId === Number(me.id)) {
    return jsonResp({ ok: false, msg: "请用『我的会话』自助操作" }, 400);
  }

  try {
    const exists = await db.prepare("SELECT id FROM users WHERE id = ?1").bind(userId).first();
    if (!exists) return jsonResp({ ok: false, msg: "用户不存在" }, 404);
  } catch (e) {
    /* 查存在性失败不阻断删除（best-effort） */
  }

  let deleted = 0;
  try {
    const res = await db.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId).run();
    deleted = (res && res.meta && Number(res.meta.changes)) || 0;
  } catch (e) {
    return jsonResp({ ok: false, msg: "会话删除失败" }, 500);
  }

  await writeAudit(env, me, request, "admin.user.revoke_sessions", "user:" + userId,
    "deleted=" + deleted);

  return jsonResp({ ok: true, data: { user_id: userId, deleted: deleted } }, 200);
}

/* ------------------------------------------------------------------ *
 * FR-X22 评论增强：Gravatar 兜底 + 作者标识 + 置顶
 * ------------------------------------------------------------------ */

/**
 * 若无头像则按邮箱生成 Gravatar 兜底地址（d=identicon，size 限制 32–256）。
 * @param {string} email 评论者邮箱
 * @param {number} size 头像边长（px）
 * @returns {string} 头像 URL；邮箱为空时返回 ""（调用方保留原值）
 */
export function gravatarUrl(email, size) {
  const mail = String(email === undefined || email === null ? "" : email).trim().toLowerCase();
  if (!mail) return "";
  let s = parseInt(size, 10);
  if (!s) s = 68;
  if (s < 32) s = 32;
  if (s > 256) s = 256;
  return "https://www.gravatar.com/avatar/" + md5Hex(mail) + "?d=identicon&s=" + s;
}

/**
 * 给评论列表补 Gravatar 兜底头像 / 作者标识 / 置顶标记，返回**新数组**
 * （每项是浅拷贝，不改调用方对象；调用方可选 await 后直接用返回的 list）。
 *
 * 说明：
 *  - is_author：优先用 comments.is_author 列；该列缺失/为空时，退化为
 *    「评论作者名与 env.ADMIN_USER（默认 kingkushawn）相同」。无法可靠按文章作者判定，
 *    因此不做「article.author」比对。
 *  - is_pinned：来自 comments.is_pinned 列（置顶排序由调用方决定，本函数不改顺序）。
 *  - avatar：row.avatar 为空且有 email 时用 gravatarUrl(email, 68) 兜底。
 */
export async function enhanceComments(env, rows, me) {
  const src = Array.isArray(rows) ? rows : [];
  const adminUser = String((env && env.ADMIN_USER) || "kingkushawn").trim().toLowerCase();
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const row = src[i];
    if (!row || typeof row !== "object") continue;
    const item = Object.assign({}, row);

    const author = String(item.author || "").trim();
    if (item.is_author === undefined || item.is_author === null) {
      item.is_author = !!author && author.toLowerCase() === adminUser;
    } else {
      item.is_author = Number(item.is_author) === 1 || item.is_author === true;
    }

    item.is_pinned = Number(item.is_pinned) === 1 || item.is_pinned === true;

    const avatar = String(item.avatar || "").trim();
    if (!avatar && item.email) {
      const fallback = gravatarUrl(item.email, 68);
      item.avatar = fallback || "";
    } else {
      item.avatar = avatar;
    }

    out.push(item);
  }
  return out;
}
