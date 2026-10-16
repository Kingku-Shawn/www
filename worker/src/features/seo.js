/* ==================================================================
 * 清逸的博客 · SEO 与分发（worker/src/features/seo.js）
 * 自包含模块：零依赖、零 import、导入时零副作用
 * ------------------------------------------------------------------
 * 对应《追加补充.md》：
 *   · FR-X1 —— robots.txt：允许全站抓取、屏蔽 /admin、声明 sitemap 绝对地址
 *   · FR-X2 —— sitemap.xml：首页 / 文章列表 / 关于我 / 每篇文章（lastmod 取 updated_at）
 *   · FR-X3 —— 分发能力：RSS 2.0（/rss.xml）、Atom（/atom.xml）、JSON Feed（/feed.json）
 *   · FR-X4 —— 文章页 <head> 注入 canonical / description / og:* / article:* / twitter:* / JSON-LD
 *   · NFR-X1 —— 统一安全响应头（CSP / HSTS / nosniff / Frame / Referrer / Permissions）
 *               与 404、500/403 错误页（单文件内联极简 CSS，引用 /soulsoft-tools.css）
 *
 * 硬约束：
 *   1) 本模块不 import 任何模块（避免与 index.js 形成循环依赖），所需小工具函数全部内部自定义；
 *   2) 导入时无副作用：不查 D1、不发 fetch；D1 查询全程 try/catch，失败即降级返回最小可用内容；
 *   3) 所有拼接进 HTML / XML 的动态数据（标题、摘要、专栏名、路径）一律转义；
 *   4) 只用标准 Web API（URL / Headers / Date / JSON / encodeURIComponent），不用 Node 专有 API。
 *
 * ⚠ CSP 说明（重要）：
 *   详情页模板与静态页存在「内联 <script>」与「内联 style 属性」，
 *   外链 CDN 资源已本地镜像到 /o/、/js/、/uploads/ 等同源路径，
 *   因此 script-src / style-src 暂必须允许 'unsafe-inline'；
 *   后续若把内联脚本外链化、或改成 nonce（script-src 'nonce-xxx'），再逐条收紧本文件 CSP。
 * ================================================================== */

export const SITE_NAME = "清逸的博客";

/* 站点级常量（不在导出行列，改动请直接改这里） */
const SITE_AUTHOR = "清逸";
const SITE_DESC = "清逸的博客：技术笔记、项目实践与日常思考。";
const DEFAULT_HOST = "my.qingyi.dpdns.org/blog";
const FEED_LIMIT = 20;

/* ------------------------------------------------------------------ */
/* 基础工具（内部使用；与 index.js 的 escapeHtml 同语义，但独立定义） */
/* ------------------------------------------------------------------ */

/** XML 文本转义：& < > " ' */
export function escapeXml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** HTML 属性转义：直接复用 XML 文本转义（&apos; 在 HTML5 中同样合法） */
export function escapeAttr(s) {
  return escapeXml(s);
}

/** 站点基地址：https://<CUSTOM_HOST>，去掉结尾斜杠；env 缺失时用默认域名 */
export function siteBase(env) {
  const raw = env && env.CUSTOM_HOST ? String(env.CUSTOM_HOST).trim() : "";
  const host = raw || DEFAULT_HOST;
  // 允许 env.CUSTOM_HOST 直接写成完整 URL（https://xxx），否则按裸域名拼 https://
  const withScheme = /^https?:\/\//i.test(host) ? host : "https://" + host;
  return withScheme.replace(/\/+$/, "");
}

/** 去标签 + 压缩空白 + 反转义常见实体，用于从正文兜底生成摘要 */
function plainText(html) {
  return String(html == null ? "" : html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** 摘要截断：压缩空白后截到 n 字符（meta description 用） */
function clip(s, n) {
  const t = plainText(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** 原样截断：保留换行（错误堆栈塞进 <pre> 用），超长补提示 */
function clamp(s, n) {
  const t = String(s == null ? "" : s);
  return t.length > n ? t.slice(0, n) + "\n…（已截断）" : t;
}

/** 文本日期 → 毫秒。
    D1 里 created_at / updated_at 由 index.js 的 nowStr() 写成 "YYYY-MM-DD HH:MM:SS"（Worker 运行时为 UTC），
    无时区信息时按 UTC 解释；也兼容 ISO / RFC 日期串与 10 位、13 位时间戳字符串。 */
function parseDateMs(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (!s) return 0;
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s);
    if (!hasTz) {
      return Date.UTC(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)
      );
    }
    const ms = Date.parse(s.replace(" ", "T"));
    return isNaN(ms) ? 0 : ms;
  }
  const ms = Date.parse(s);
  return isNaN(ms) ? 0 : ms;
}

/** sitemap lastmod：W3C 完整日期（YYYY-MM-DD，sitemap 协议允许完整日期形式） */
function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Atom updated / JSON Feed 时间：W3C 完整日期时间（UTC） */
function isoDateTime(ms) {
  return new Date(ms).toISOString();
}

/** RSS pubDate：RFC 1123 / RFC 822 格式（toUTCString 输出 GMT 时区） */
function rfc822(ms) {
  return new Date(ms).toUTCString();
}

/** 文章 URL：${base}/article/${source_file}[?col=xxx] */
function articleUrl(base, sourceFile, col) {
  const sf = String(sourceFile == null ? "" : sourceFile).replace(/^\/+/, "");
  let url = base + "/article/" + sf;
  if (col) url += "?col=" + encodeURIComponent(col);
  return url;
}

/** JSON-LD 片段：JSON.stringify 已处理引号转义，额外把 < 转成 \u003c 防 </script> 早闭合 */
function jsonLdScript(obj) {
  const json = JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return '<script type="application/ld+json">' + json + "</script>\n";
}

/* ------------------------------------------------------------------ */
/* D1 查询（全程 try/catch：D1 未绑定 / 表未建 / 查询失败一律降级为空数组） */
/* ------------------------------------------------------------------ */

/** 列表查询：与 index.js handlePosts 同口径（status=1，置顶优先，id 倒序） */
async function queryPosts(env, limit) {
  const db = env && env.DB ? env.DB : null;
  if (!db) return [];
  let sql = "SELECT id,title,summary,source_file,created_at,updated_at FROM posts WHERE status=1 ORDER BY is_top DESC, id DESC";
  const n = Number(limit) || 0;
  if (n > 0) sql += " LIMIT " + n;
  try {
    const rows = await db.prepare(sql).all();
    return (rows && rows.results) || [];
  } catch (e) {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* FR-X1 robots.txt                                                    */
/* ------------------------------------------------------------------ */

/** robots.txt 纯文本：允许全站（含文章/工具页），屏蔽后台，声明 sitemap 绝对地址 */
export function robotsTxt(env) {
  const base = siteBase(env);
  const parts = [];
  parts.push("User-agent: *\n");
  parts.push("Allow: /\n");
  parts.push("Disallow: /admin\n");
  parts.push("Disallow: /admin/\n");
  parts.push("\n");
  parts.push("Sitemap: " + base + "/sitemap.xml\n");
  return parts.join("");
}

/* ------------------------------------------------------------------ */
/* FR-X2 sitemap.xml                                                   */
/* ------------------------------------------------------------------ */

/** 单个 <url> 条目（loc/lastmod 一律 XML 转义，URL 里的 & 必须变 &amp;） */
function sitemapEntry(loc, lastmod, changefreq, priority) {
  const parts = [];
  parts.push("  <url>\n");
  parts.push("    <loc>" + escapeXml(loc) + "</loc>\n");
  if (lastmod) parts.push("    <lastmod>" + escapeXml(lastmod) + "</lastmod>\n");
  if (changefreq) parts.push("    <changefreq>" + changefreq + "</changefreq>\n");
  if (priority) parts.push("    <priority>" + priority + "</priority>\n");
  parts.push("  </url>\n");
  return parts.join("");
}

/** sitemap.xml：首页 + 文章列表 + 关于我 + 每篇文章；D1 不可用或为空时只给静态页最小 sitemap */
export async function sitemapXml(env) {
  const base = siteBase(env);
  const rows = await queryPosts(env, 0);
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  parts.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n');
  // 静态页：站点入口与固定导航页（路径与 index.js 模板导航一致）
  parts.push(sitemapEntry(base + "/", "", "daily", "1.0"));
  parts.push(sitemapEntry(base + "/article/index.html", "", "daily", "0.9"));
  parts.push(sitemapEntry(base + "/aboutme/index.html", "", "monthly", "0.5"));
  // 文章页：source_file 即详情页文件名（a_xxx.html）
  for (const r of rows) {
    if (!r) continue;
    const sf = String(r.source_file || "").trim();
    if (!sf) continue;
    const ms = parseDateMs(r.updated_at) || parseDateMs(r.created_at);
    parts.push(sitemapEntry(base + "/article/" + sf, ms ? isoDate(ms) : "", "weekly", "0.8"));
  }
  parts.push("</urlset>\n");
  return parts.join("");
}

/* ------------------------------------------------------------------ */
/* FR-X3 feeds（RSS 2.0 / Atom / JSON Feed）                            */
/* ------------------------------------------------------------------ */

/** 取最新 20 篇并归一化为 feed 条目（pubMs = created_at，modMs = updated_at） */
async function feedItems(env, base) {
  const rows = await queryPosts(env, FEED_LIMIT);
  const out = [];
  for (const r of rows) {
    if (!r) continue;
    const sf = String(r.source_file || "").trim();
    if (!sf) continue;
    out.push({
      title: String(r.title || ""),
      summary: String(r.summary || ""),
      url: articleUrl(base, sf, ""),
      pubMs: parseDateMs(r.created_at),
      modMs: parseDateMs(r.updated_at),
    });
  }
  return out;
}

/** 条目最新更新时间（用于 feed 级 lastBuildDate / updated） */
function newestMs(items) {
  let ms = 0;
  for (const it of items) {
    const v = it.modMs || it.pubMs || 0;
    if (v > ms) ms = v;
  }
  return ms;
}

/** RSS 2.0：channel(title/link/description/language/atom:link self) + item(title/link/guid/pubDate/description) */
function rssXml(base, items) {
  const latest = newestMs(items);
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  parts.push('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n');
  parts.push("<channel>\n");
  parts.push("<title>" + escapeXml(SITE_NAME) + "</title>\n");
  parts.push("<link>" + escapeXml(base + "/") + "</link>\n");
  parts.push("<description>" + escapeXml(SITE_DESC) + "</description>\n");
  parts.push("<language>zh-CN</language>\n");
  if (latest) parts.push("<lastBuildDate>" + rfc822(latest) + "</lastBuildDate>\n");
  parts.push('<atom:link href="' + escapeXml(base + "/rss.xml") + '" rel="self" type="application/rss+xml"/>\n');
  for (const it of items) {
    const pub = it.pubMs || it.modMs;
    parts.push("<item>\n");
    parts.push("<title>" + escapeXml(it.title) + "</title>\n");
    parts.push("<link>" + escapeXml(it.url) + "</link>\n");
    parts.push('<guid isPermaLink="true">' + escapeXml(it.url) + "</guid>\n");
    if (pub) parts.push("<pubDate>" + rfc822(pub) + "</pubDate>\n");
    parts.push("<description>" + escapeXml(it.summary) + "</description>\n");
    parts.push("</item>\n");
  }
  parts.push("</channel>\n");
  parts.push("</rss>\n");
  return parts.join("");
}

/** Atom 1.0：feed(id/title/updated/link self + alternate) + entry(id/title/updated/link/published/summary) */
function atomXml(base, items) {
  const latest = newestMs(items);
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  parts.push('<feed xmlns="http://www.w3.org/2005/Atom">\n');
  parts.push("<title>" + escapeXml(SITE_NAME) + "</title>\n");
  parts.push("<id>" + escapeXml(base + "/") + "</id>\n");
  parts.push('<link href="' + escapeXml(base + "/") + '"/>\n');
  parts.push('<link rel="self" type="application/atom+xml" href="' + escapeXml(base + "/atom.xml") + '"/>\n');
  parts.push("<updated>" + escapeXml(isoDateTime(latest || Date.now())) + "</updated>\n");
  parts.push("<subtitle>" + escapeXml(SITE_DESC) + "</subtitle>\n");
  parts.push('<author><name>' + escapeXml(SITE_AUTHOR) + "</name><uri>" + escapeXml(base + "/aboutme/index.html") + "</uri></author>\n");
  for (const it of items) {
    const pub = it.pubMs || it.modMs;
    parts.push("<entry>\n");
    parts.push("<title>" + escapeXml(it.title) + "</title>\n");
    parts.push("<id>" + escapeXml(it.url) + "</id>\n");
    parts.push('<link href="' + escapeXml(it.url) + '"/>\n');
    parts.push("<updated>" + escapeXml(isoDateTime(it.modMs || pub || latest || Date.now())) + "</updated>\n");
    if (pub) parts.push("<published>" + escapeXml(isoDateTime(pub)) + "</published>\n");
    parts.push("<summary>" + escapeXml(it.summary) + "</summary>\n");
    parts.push("</entry>\n");
  }
  parts.push("</feed>\n");
  return parts.join("");
}

/** JSON Feed 1.1：version/title/home_page_url/feed_url + items(id/url/title/summary/date_published) */
function jsonFeedText(base, items) {
  const feed = {
    version: "https://jsonfeed.org/version/1.1",
    title: SITE_NAME,
    home_page_url: base + "/",
    feed_url: base + "/feed.json",
    description: SITE_DESC,
    language: "zh-CN",
    items: items.map((it) => {
      const pub = it.pubMs || it.modMs;
      const o = { id: it.url, url: it.url, title: it.title, summary: it.summary };
      if (pub) o.date_published = isoDateTime(pub);
      if (it.modMs) o.date_modified = isoDateTime(it.modMs);
      return o;
    }),
  };
  return JSON.stringify(feed, null, 2);
}

/** 按 kind 分发：kind ∈ "rss" | "atom" | "json"（其他值按 rss 处理）；出错不抛异常，返回最小可用内容 */
export async function feedXml(env, kind) {
  const base = siteBase(env);
  const k = String(kind == null ? "" : kind).trim().toLowerCase();
  let items = [];
  try {
    items = await feedItems(env, base);
  } catch (e) {
    items = [];
  }
  if (k === "atom") return atomXml(base, items);
  if (k === "json") return jsonFeedText(base, items);
  return rssXml(base, items);
}

/* ------------------------------------------------------------------ */
/* FR-X4 文章页 <head> meta + JSON-LD                                  */
/* ------------------------------------------------------------------ */

/** 选取社交分享图：opts.image → post.og_image → post.cover_image（都是真实存在的字段）。
    找不到就返回空串，调用方省略 og:image / twitter:image（不编造不存在的默认图）。 */
function pickImage(post, opts, base) {
  const cands = [opts.image, post.og_image, post.cover_image];
  for (const c of cands) {
    const s = String(c == null ? "" : c).trim();
    if (!s) continue;
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith("//")) return "https:" + s;
    return base + (s.startsWith("/") ? s : "/" + s);
  }
  return "";
}

/** 文章页 JSON-LD：Article + BreadcrumbList（带专栏上下文时补一条专栏面包屑） */
function articleJsonLd(base, ctx) {
  const article = {
    "@type": "Article",
    headline: ctx.title,
    mainEntityOfPage: { "@type": "WebPage", "@id": ctx.canonical },
    url: ctx.canonical,
    inLanguage: "zh-CN",
    author: { "@type": "Person", name: SITE_AUTHOR, url: base + "/aboutme/index.html" },
    publisher: { "@type": "Person", name: SITE_AUTHOR, url: base + "/aboutme/index.html" },
    isPartOf: { "@type": "WebSite", name: SITE_NAME, url: base + "/" },
  };
  if (ctx.desc) article.description = ctx.desc;
  if (ctx.image) article.image = [ctx.image];
  if (ctx.pubMs) article.datePublished = isoDateTime(ctx.pubMs);
  if (ctx.modMs) article.dateModified = isoDateTime(ctx.modMs);
  const crumbs = [
    { "@type": "ListItem", position: 1, name: "首页", item: base + "/" },
    { "@type": "ListItem", position: 2, name: "文章", item: base + "/article/index.html" },
  ];
  if (ctx.col) {
    crumbs.push({
      "@type": "ListItem",
      position: 3,
      name: ctx.col,
      item: base + "/article/index.html?col=" + encodeURIComponent(ctx.col),
    });
  }
  crumbs.push({ "@type": "ListItem", position: crumbs.length + 1, name: ctx.title, item: ctx.canonical });
  return jsonLdScript({
    "@context": "https://schema.org",
    "@graph": [article, { "@type": "BreadcrumbList", itemListElement: crumbs }],
  });
}

/**
 * 文章页 <head> 追加的 meta 片段（字符串，可直接插进模板 head）。
 * post：D1 posts 行（title/summary/content/created_at/updated_at/source_file，可选 og_image/cover_image）
 * opts：{ env, col, image } —— env 用于拼站点绝对地址；col 为 ?col= 专栏上下文；image 为外部指定分享图
 */
export function articleMeta(post, opts) {
  const p = post || {};
  const o = opts || {};
  const env = o.env || {};
  const base = siteBase(env);
  const sourceFile = String(p.source_file || o.source_file || "").trim();
  const col = String(o.col || "").trim();
  const canonical = sourceFile ? articleUrl(base, sourceFile, col) : base + "/";
  const title = String(p.title == null ? "" : p.title).trim() || SITE_NAME;
  const desc = clip(String(p.summary == null ? "" : p.summary) || plainText(p.content || ""), 160);
  const image = pickImage(p, o, base);
  const pubMs = parseDateMs(p.created_at);
  const modMs = parseDateMs(p.updated_at) || pubMs;
  const parts = [];
  parts.push('<link rel="canonical" href="' + escapeAttr(canonical) + '">\n');
  if (desc) parts.push('<meta name="description" content="' + escapeAttr(desc) + '">\n');
  parts.push('<meta property="og:type" content="article">\n');
  parts.push('<meta property="og:site_name" content="' + escapeAttr(SITE_NAME) + '">\n');
  parts.push('<meta property="og:title" content="' + escapeAttr(title) + '">\n');
  if (desc) parts.push('<meta property="og:description" content="' + escapeAttr(desc) + '">\n');
  parts.push('<meta property="og:url" content="' + escapeAttr(canonical) + '">\n');
  if (image) {
    parts.push('<meta property="og:image" content="' + escapeAttr(image) + '">\n');
    parts.push('<meta name="twitter:image" content="' + escapeAttr(image) + '">\n');
  }
  if (pubMs) parts.push('<meta property="article:published_time" content="' + escapeAttr(isoDateTime(pubMs)) + '">\n');
  if (modMs) parts.push('<meta property="article:modified_time" content="' + escapeAttr(isoDateTime(modMs)) + '">\n');
  parts.push('<meta name="twitter:card" content="summary_large_image">\n');
  parts.push('<meta name="twitter:title" content="' + escapeAttr(title) + '">\n');
  if (desc) parts.push('<meta name="twitter:description" content="' + escapeAttr(desc) + '">\n');
  parts.push(articleJsonLd(base, { title: title, desc: desc, canonical: canonical, image: image, pubMs: pubMs, modMs: modMs, col: col }));
  return parts.join("");
}

/** 首页/通用页 JSON-LD：WebSite + Person */
export function siteJsonLd(env) {
  const base = siteBase(env);
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": base + "/#website",
        name: SITE_NAME,
        url: base + "/",
        description: SITE_DESC,
        inLanguage: "zh-CN",
        publisher: { "@id": base + "/#person" },
      },
      {
        "@type": "Person",
        "@id": base + "/#person",
        name: SITE_AUTHOR,
        url: base + "/aboutme/index.html",
      },
    ],
  };
  return jsonLdScript(graph);
}

/* ------------------------------------------------------------------ */
/* NFR-X1 安全响应头                                                    */
/* ------------------------------------------------------------------ */

/* 与现有页面兼容的保守策略（见文件头 CSP 说明）：
   · script-src 允许 'unsafe-inline'（详情页模板存在大量内联脚本：评论、目录、汉堡菜单等）
   · style-src 允许 'unsafe-inline'（模板与静态页大量内联 style 属性 / <style> 块）与 https:
   · img-src / media-src 放行 https:（正文里可能引用站外图片，CDN 已本地镜像但仍留余量）
   · frame-ancestors 'none' 防点击劫持；base-uri / form-action 限制为本站 */
export const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https:; " +
    "img-src 'self' data: blob: https:; font-src 'self' data: https:; media-src 'self' https:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
  "x-xss-protection": "0",
};

/** 头是否已存在（Headers 用 has()，普通对象按大小写不敏感遍历） */
function hasHeader(headers, name) {
  if (typeof headers.has === "function") return headers.has(name);
  const lower = String(name).toLowerCase();
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === lower) return true;
  }
  return false;
}

/** 写入头（Headers 用 set()，普通对象直接赋值） */
function setHeader(headers, name, value) {
  if (typeof headers.set === "function") headers.set(name, value);
  else headers[name] = value;
}

/**
 * 就地补齐安全响应头，返回同一个对象。
 * 参数：Headers 实例或普通对象（如 json() 里的 headers 字面量）。
 * 已存在的头一律保留原值（便于个别路由覆盖 CSP）。
 * ⚠ 只能对「自己 new 出来的 Response」调用；回源 fetch 得到的 Response 其 headers 是
 *   immutable 守卫，set() 会抛 TypeError，需先 new Headers(resp.headers) 再套用。
 */
export function applySecurityHeaders(headers) {
  if (!headers) return headers;
  for (const name of Object.keys(SECURITY_HEADERS)) {
    if (!hasHeader(headers, name)) setHeader(headers, name, SECURITY_HEADERS[name]);
  }
  return headers;
}

/* ------------------------------------------------------------------ */
/* 404 / 错误页（完整 HTML，单文件内联极简 CSS + 引用 /soulsoft-tools.css） */
/* ------------------------------------------------------------------ */

/* 极简内联样式：与站点浅色风格一致，不依赖 /soulsoft-tools.css 是否命中 */
const PAGE_CSS = [
  "*{margin:0;padding:0;box-sizing:border-box}",
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f5f7fb;color:#0f172a;line-height:1.8;min-height:100vh;display:flex;flex-direction:column}',
  ".nav{height:58px;background:rgba(255,255,255,.85);border-bottom:1px solid #e4e9f0}",
  ".nav-in{max-width:1100px;margin:0 auto;height:100%;display:flex;align-items:center;padding:0 24px}",
  ".logo{font-size:19px;font-weight:800;color:#2563eb;text-decoration:none}",
  ".wrap{flex:1;max-width:1100px;width:100%;margin:0 auto;padding:72px 24px;text-align:center}",
  ".code{font-size:64px;font-weight:800;letter-spacing:2px;color:#2563eb}",
  "h1{font-size:22px;margin:8px 0}",
  ".msg{color:#64748b;font-size:14.5px}",
  ".path{margin-top:14px;font-size:13px;color:#94a3b8;word-break:break-all}",
  ".path code{background:#eef2ff;color:#4f46e5;padding:2px 8px;border-radius:6px}",
  ".detail{margin:18px auto 0;max-width:760px;text-align:left;background:#0f172a;color:#e2e8f0;border-radius:12px;padding:16px;font-size:12.5px;line-height:1.7;overflow:auto;white-space:pre-wrap;word-break:break-all}",
  ".acts{margin-top:26px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap}",
  ".btn{display:inline-block;padding:10px 22px;border-radius:12px;background:#2563eb;color:#fff;text-decoration:none;font-size:14px;font-weight:600}",
  ".btn.ghost{background:#fff;color:#2563eb;border:1px solid #d7e3f5}",
  ".foot{padding:18px 24px;text-align:center;color:#94a3b8;font-size:12px}",
].join("\n") + "\n";

/** 错误页公共骨架 */
function renderPage(env, opt) {
  const o = opt || {};
  const code = Number(o.code) || 404;
  const base = siteBase(env);
  const title = String(o.title || SITE_NAME);
  const host = base.replace(/^https?:\/\//, "");
  const parts = [];
  parts.push("<!DOCTYPE html>\n");
  parts.push('<html lang="zh-CN">\n');
  parts.push("<head>\n");
  parts.push('<meta charset="utf-8">\n');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">\n');
  parts.push('<meta name="robots" content="' + escapeAttr(o.robots || "noindex, nofollow") + '">\n');
  parts.push("<title>" + escapeXml(title + " - " + SITE_NAME) + "</title>\n");
  parts.push('<link rel="stylesheet" href="/soulsoft-tools.css">\n');
  parts.push("<style>\n" + PAGE_CSS + "</style>\n");
  parts.push("</head>\n");
  parts.push("<body>\n");
  parts.push('<header class="nav"><div class="nav-in"><a class="logo" href="/">' + escapeXml(SITE_NAME) + "</a></div></header>\n");
  parts.push('<main class="wrap">\n');
  parts.push('<div class="code">' + code + "</div>\n");
  parts.push("<h1>" + escapeXml(title) + "</h1>\n");
  if (o.message) parts.push('<p class="msg">' + escapeXml(o.message) + "</p>\n");
  if (o.path) parts.push('<p class="path">请求路径：<code>' + escapeXml(clamp(o.path, 200)) + "</code></p>\n");
  if (o.detail) parts.push('<pre class="detail">' + escapeXml(clamp(o.detail, 600)) + "</pre>\n");
  parts.push('<div class="acts">\n');
  parts.push('<a class="btn" href="/">返回首页</a>\n');
  parts.push('<a class="btn ghost" href="/article/index.html">文章列表</a>\n');
  parts.push("</div>\n");
  parts.push("</main>\n");
  parts.push('<footer class="foot">' + escapeXml(SITE_NAME + " · " + host) + "</footer>\n");
  parts.push("</body>\n");
  parts.push("</html>\n");
  return parts.join("");
}

/** 404 页面：noindex，含返回首页 / 文章列表链接（接线时用 status 404 返回） */
export function notFoundPage(env, path) {
  return renderPage(env, {
    code: 404,
    title: "页面走丢了",
    message: "这个地址不存在，或者内容已被移动、删除。",
    path: path == null ? "" : String(path),
    robots: "noindex",
  });
}

/** 500 / 403 等错误页：detail 只在 <pre> 里输出「转义后」内容，且截断 600 字符 */
export function errorPage(env, status, detail) {
  const code = Number(status) || 500;
  const is403 = code === 403;
  return renderPage(env, {
    code: code,
    title: is403 ? "没有访问权限" : "服务器开小差了",
    message: is403 ? "这个页面需要更高的权限，或者登录状态已失效。" : "服务暂时不可用，请稍后重试。",
    detail: detail == null ? "" : String(detail),
    robots: "noindex, nofollow",
  });
}
