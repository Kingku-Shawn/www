/**
 * my.qingyi.dpdns.org 门户 Worker
 * 把 /blog /tool /score 三个子站聚合到同一域名下：
 *  - /blog/* /tool/* /score/* 的静态资源 → 对应 GitHub Pages 裸源，HTML 注入 <base>
 *  - /blog/api/* 与 /blog/article/* → 博客动态后端（blog-server Worker），路径保留为 /api/*、/article/*
 *  - 根路径 → 重定向到 ROOT_REDIRECT（默认 /blog/）
 *
 * 设计说明：
 *  - 仅对 text/html 响应注入 <base href="/blog/">（或 /tool/、/score/），
 *    让子站内部绝对路径引用（/js/...、/api/...、/uploads/...）落在正确子路径。
 *  - 301/302 的 Location 若为相对路径，补子路径前缀，避免跳回根。
 *  - 博客动态请求（/blog/api/*、/blog/article/*）转发给 blog-server Worker，
 *    路径剥掉 /blog 前缀，blog-server 内部路由不变。
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 根路径重定向
    if (path === "/" || path === "") {
      return Response.redirect(env.ROOT_REDIRECT || "/blog/", 302);
    }

    // 博客动态端点：转发给 blog-server Worker（剥掉 /blog 前缀）
    if (path.startsWith("/blog/api/") || path.startsWith("/blog/api-v1/") || path.startsWith("/blog/article/")) {
      const worker = (env.BLOG_WORKER_ORIGIN || "").trim().replace(/\/+$/, "");
      if (!worker) {
        return new Response("博客后端源未配置（BLOG_WORKER_ORIGIN）", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      const upstream = worker + path.slice("/blog".length) + url.search;
      const resp = await fetch(upstream, {
        method: request.method,
        headers: request.headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
        redirect: "manual",
      });
      return relay(resp);
    }

    // 命中已知子站静态
    for (const [name, r] of Object.entries({
      blog:  "/blog/",
      tool:  "/tool/",
      score: "/score/",
    })) {
      if (path === r.slice(0, -1) || path.startsWith(r)) {
        const originKey = { blog: "BLOG_ORIGIN", tool: "TOOL_ORIGIN", score: "SCORE_ORIGIN" }[name];
        const origin = (env[originKey] || "").trim().replace(/\/+$/, "");
        if (!origin) {
          return new Response(`子站源未配置（${originKey}）`, { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
        }
        return proxyStatic(origin, r, request, url);
      }
    }

    // 未命中：404
    return new Response("404 Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};

async function relay(resp) {
  const headers = new Headers(resp.headers);
  headers.set("access-control-allow-origin", "*");
  return new Response(resp.body, { status: resp.status, headers });
}

async function proxyStatic(origin, prefix, request, url) {
  // 剥掉子路径前缀，得到子站内部路径
  let rest = url.pathname.slice(prefix.length - 1); // 保留开头的 "/"
  if (rest === "") rest = "/";
  const target = origin + rest + url.search;

  const resp = await fetch(target, {
    method: request.method,
    headers: request.headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
  });

  // 处理重定向：相对 Location 补子路径前缀
  if (resp.status >= 300 && resp.status < 400) {
    let loc = resp.headers.get("location") || "";
    if (loc.startsWith("/") && !loc.startsWith(prefix)) {
      loc = prefix.slice(0, -1) + loc;
    }
    const headers = new Headers(resp.headers);
    headers.set("location", loc);
    return new Response(resp.body, { status: resp.status, headers });
  }

  // 非 2xx 透传
  if (!resp.ok) {
    const headers = new Headers(resp.headers);
    headers.set("access-control-allow-origin", "*");
    return new Response(resp.body, { status: resp.status, headers });
  }

  const ct = resp.headers.get("content-type") || "";
  const isHtml = ct.includes("text/html");

  if (!isHtml) {
    const headers = new Headers(resp.headers);
    headers.set("access-control-allow-origin", "*");
    return new Response(resp.body, { status: resp.status, headers });
  }

  // HTML：注入 <base>
  const text = await resp.text();
  const baseTag = `<base href="${prefix}">`;
  let out = text;
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => m + "\n" + baseTag);
  } else {
    out = baseTag + "\n" + out;
  }

  const headers = new Headers(resp.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("cache-control", "no-store"); // 门户 HTML 不缓存，便于迭代
  return new Response(out, { status: resp.status, headers });
}
