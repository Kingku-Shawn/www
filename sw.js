/* 《追加补充.md》FR-X12：PWA Service Worker
 * 策略（刻意保守，避免污染线上缓存）：
 *   - 只处理同源 GET；/api/*、/api-v1/*、/admin* 一律不拦截（接口数据永不缓存）
 *   - 页面导航（navigate）：network-first，断网时回退缓存的 /404.html 或 /index.html
 *   - JS/CSS：network-first（避免部署后仍用旧的 header-fix.js 等）
 *   - 图片/字体等静态资源：cache-first + 后台更新（stale-while-revalidate）
 *   - 缓存名带版本号；activate 时清掉旧版本缓存
 */
var CACHE = "qingyi-blog-v1";
var SHELL = ["/index.html", "/soulsoft-tools.css", "/manifest.json", "/icons/icon.svg", "/404.html"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .catch(function () { /* 任一资源 404 也不阻塞安装 */ })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isStaticAsset(path) {
  return /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp3|wav|ogg|m4a|mp4|webm)$/i.test(path);
}
function isCode(path) {
  return /\.(?:js|css|mjs)$/i.test(path);
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;
  var p = url.pathname;
  // 接口与后台：完全不拦截（保持既有 no-store / 鉴权行为）
  if (p.indexOf("/api/") === 0 || p.indexOf("/api-v1/") === 0 || p.indexOf("/admin") === 0) return;

  // 页面导航：network-first
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match("/index.html").then(function (hit) {
          return hit || caches.match("/404.html");
        });
      })
    );
    return;
  }

  // JS/CSS：network-first（部署后立刻生效）
  if (isCode(p)) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var cp = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); }).catch(function () {});
        }
        return res;
      }).catch(function () { return caches.match(req); })
    );
    return;
  }

  // 图片/字体等：cache-first + 后台更新
  if (isStaticAsset(p)) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) {
          if (res && res.ok && res.type === "basic") {
            var cp = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, cp); }).catch(function () {});
          }
          return res;
        }).catch(function () { return hit; });
        return hit || net;
      })
    );
  }
});
