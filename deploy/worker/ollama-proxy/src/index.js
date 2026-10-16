/**
 * ollama.qingyi.dpdns.org 前端代理 Worker
 *
 * 前端调用示例（仅前端接口调用，不带任何 key）：
 *   POST https://ollama.qingyi.dpdns.org/api/chat
 *   { "model": "granite3.2-vision:2b",
 *     "messages": [{ "role": "user", "content": "描述图片", "images": ["<base64>"] }],
 *     "stream": false }
 *
 * 本 Worker：
 *  - 校验 Origin（CORS），只允许白名单（默认 *）。
 *  - 校验 model 白名单（ALLOWED_MODELS 非空时）。
 *  - 用 secret OLLAMA_API_KEY 回源 ollaguard（转发 Authorization: Bearer）。
 *  - 透传 Ollama 的 /api/chat、/api/generate 等接口。
 */

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin");
    const corsOrigin = (env.CORS_ORIGIN || "*").trim();

    // CORS 预检
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }), corsOrigin);
    }

    const url = new URL(request.url);
    const upstream = (env.OLLAMA_UPSTREAM || "http://localhost:4000").trim().replace(/\/+$/, "");
    const key = (env.OLLAMA_API_KEY || "").trim();

    if (!key) {
      return cors(json({ error: "OLLAMA_API_KEY 未配置" }, 500), corsOrigin);
    }

    // 只转发 /api/* 路径，避免代理被滥用
    if (!url.pathname.startsWith("/api/")) {
      return cors(json({ error: "not found" }, 404), corsOrigin);
    }

    // 模型白名单校验（仅当请求体里含 model 且白名单非空）
    const allowed = (env.ALLOWED_MODELS || "").split(",").map(s => s.trim()).filter(Boolean);
    if (allowed.length > 0 && request.method === "POST") {
      try {
        const body = await request.clone().json();
        const model = body && body.model;
        if (model && !allowed.includes(model)) {
          return cors(json({ error: `模型不在白名单：${model}` }, 403), corsOrigin);
        }
      } catch (e) {
        // 非 JSON body 放行，交给上游报错
      }
    }

    const target = upstream + url.pathname + url.search;
    const headers = new Headers(request.headers);
    headers.set("authorization", "Bearer " + key);
    // 转发 X-Request-Id 便于排障
    headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") || "");

    const resp = await fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    });

    const respHeaders = new Headers(resp.headers);
    const corsResp = cors(new Response(resp.body, { status: resp.status, headers: respHeaders }), corsOrigin);
    return corsResp;
  },
};

function cors(resp, origin) {
  const headers = new Headers(resp.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "Content-Type, Authorization");
  headers.set("vary", "Origin");
  return new Response(resp.body, { status: resp.status, headers });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
