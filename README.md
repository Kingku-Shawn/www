# 清逸的博客

一个中文个人博客：GitHub Pages 托管静态站，Cloudflare Worker（`blog-server`）作为统一入口，Cloudflare D1 承载全部动态数据。

> **线上地址**：<https://blog.qingyi.dpdns.org/>
> **技术栈**：GitHub Pages + Cloudflare Worker（ES Module，无框架）+ Cloudflare D1 + 原生 HTML/CSS/JS
> **最后更新**：2026-10-12

---

## 1. 架构

### 1.1 请求链路

```
                     浏览器
                        │
                        ▼
        Cloudflare 代理（blog.qingyi.dpdns.org，橙色小云朵）
        DNS：blog  ──CNAME──►  kingku-shawn.github.io
                        │
                        ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  Cloudflare Worker  blog-server（统一入口，worker/src/index.js）│
   └─────────────────────────────────────────────────────────────┘
        │
        ├─ ① /article/a_*.html ──► handleArticleDetail
        │       D1 posts 读正文 ──► renderArticleFromTemplate 直出完整 HTML
        │       （顶栏 + 正文 + 评论区 + 右侧目录/上下篇/专栏面板）
        │       ?col=专栏名 ──► 专栏面板两态：
        │          无 col → 只列「专栏名 + N 篇」
        │          有 col → 服务端直出「专栏文章展示态」+ 栏内上下篇
        │       D1 查不到该文 ──► passthroughArticle ──► 反代回源 Pages
        │
        ├─ ② /api/public/*.json、/api/tools.json、/api/about.json、
        │   /api/layout.json ──► D1 优先，异常/为空则回退 raw 静态 JSON
        │       /api/public/posts.json：3 秒内存缓存 + 标签/分栏 2 次聚合查询
        │
        ├─ ③ POST /api/view ──► 阅读量 +1（D1 views 与 posts.views 双写）
        │
        ├─ ④ /api/ping、/api/health ──► 健康检查（d1/tables/posts_total/
        │       posts_dirty_content/raw_article_status 等诊断字段）
        │
        ├─ ⑤ /api/pinlun/*、/api-v1/pinlun/*
        │       action ∈ list/replies/publish/vote/del，旧契约 {success,data,msg}
        │
        ├─ ⑥ /api-v1/csrf、/api-v1/article/*、/api-v1/user/*
        │       旧 Vue SPA 契约：csrf 返回字符串 token；
        │       article/* 固定 success:false（防止旧 store 覆盖已预渲染正文）；
        │       user/* 走 Cookie 会话
        │
        ├─ ⑦ /api/user/{login,info,logout}（Cookie 会话，评论区用）
        │   /api/{login,register,me,logout}（X-Token + localStorage，登录页/后台用）
        │
        ├─ ⑧ GET /api/columns/<专栏名>/articles?cur=<source_file>
        │       专栏文章列表；带 cur 时附该文在专栏内的 prev/next
        │
        ├─ ⑨ GET /api/uploads/<file>、/api/dashboard|posts|categories|tags|
        │   columns|comments|users|settings|upload|import_posts
        │       ──► handleAdmin（X-Token 鉴权，完整后台接口见 §3.2）
        │
        ├─ ⑩ 未命中 /api/*、/api-v1/* ──► proxyStaticJson
        │       从 RAW_API_BASE 取同名 .json，120 秒缓存
        │
        └─ ⑪ /admin* ──► guardAdmin 鉴权：sessions JOIN users
                role ∈ ('admin','super_admin') 且 status=1 且未过期，
                接受 X-Token 头或 session Cookie
                失败 → 纯文本 404（不暴露存在性）
                通过 → 从 RAW_ADMIN_BASE 取回后台页面
                （整个 admin/ 都不部署到 Pages；
                  /admin 或 /admin/ → index.html，
                  /admin/web/editor.html → admin/web/editor.html）

        ⑫ 其余全部路径 ──► proxyStatic 反代回源 GitHub Pages
                （redirect:"manual" + 3xx Location 改写，规避自定义域名 301 死循环）

   ┌──────────────────────────────────────────────┐
   │  Cloudflare D1  t_blog_qingyi（binding: DB）  │
   │  14 张业务表，首次 /api/* 请求自动建表         │
   └──────────────────────────────────────────────┘
```

### 1.2 分层说明

| 层 | 说明 |
| --- | --- |
| 域名 | `blog.qingyi.dpdns.org`（dpdns.org 动态 DNS + Cloudflare 代理） |
| 静态站 | GitHub Pages 项目站，裸源 `https://kingku-shawn.github.io/blog`，已在 Pages 配自定义域名 |
| 动态后端 | Cloudflare Worker `blog-server`（`worker/src/index.js`，当前 2705 行，ES module `export default { fetch }`，无框架；行数会随改动漂移，以文件为准） |
| 数据 | Cloudflare D1 库 `t_blog_qingyi`，binding `DB`，`database_id = add76dbc-1118-4ec8-9edd-e380b66cbbac` |
| 未使用 | 控制台建的 KV（系统表 `_cf_KV`），当前无任何读写 |

### 1.3 为什么用 Worker 做统一入口

1. **一次解决 301 死循环**。Pages 已设自定义域名 `blog.qingyi.dpdns.org`，Worker 若直接回源该域名会被再 301 回自己。`proxyStatic` 用 `redirect:"manual"`，并把 3xx 的 `Location` 中的自定义域名改写回裸源 `https://kingku-shawn.github.io/blog`，最多跟 3 跳，彻底断开环。
2. **动态与静态同一个域名，前端零改造**。首页、文章列表、详情、评论区都从同源发起请求，不需要 CORS、不需要配置第二个域名。
3. **正文保存即生效**。文章真源在 D1，`/article/a_*.html` 走服务端模板直出，后台改完刷新即是最新，不必重新生成 HTML 文件再等 Pages 构建。
4. **保守部署**。`wrangler.toml` 里 **没有 `routes` 段**，Worker 代码部署不会覆盖 Cloudflare 控制台已配好的绑定与路由；路由改由控制台维护。
5. **纯 raw 兜底更稳**。静态 JSON 兜底走 `raw.githubusercontent.com`（不经过 Pages），天然没有自定义域名 301 问题。
6. **后台云化 + 防探测**。整个 `admin/` 目录都不部署到 Pages（不可被公开下载），管理员鉴权通过后由 Worker 从 `RAW_ADMIN_BASE`（指向仓库 `admin/`）按需取回：`/admin` 或 `/admin/` → `admin/index.html`，`/admin/web/editor.html` → 仓库同名的 `admin/web/editor.html`；非管理员访问 `/admin*` 一律 **纯文本 404**，与「该路径不存在」不可区分。

> **降级链路（重要）**：整套两态专栏只在 `/article/a_*.html` 命中 D1 时生效。若该路由没命中 Worker（或某文不在 D1），会 `passthroughArticle → proxyStatic` 回到 Pages 上的旧静态详情页，专栏面板与上下篇联动**自动失效，不会报错**。排查「专栏点了没反应」时先确认请求到了 Worker。

---

## 2. 目录结构

> ⚠ **当前仓库尚未执行 `scripts/restructure.mjs`**，所有静态资源仍在仓库根目录。下面给出「当前真实结构」与「重构后的目标结构」两套。

### 2.1 当前真实结构（未重构）

```
blog/
├── index.html                  # 首页：hero 统计卡 + 文章卡片 + 侧栏专栏/标签筛选（<head> 已加 description/canonical/OG/Twitter/订阅发现链接/WebSite JSON-LD）
├── favicon.ico
├── soulsoft-tools.css          # 工具页统一主题
├── CNAME                       # blog.qingyi.dpdns.org（GitHub Pages 自定义域名）
├── robots.txt                  # ⚠ 静态兜底爬虫规则（deploy.yml 会复制进 _site；动态版由 Worker 提供）
├── 404.html                    # ⚠ 站点风格自定义 404（含 /js/header-fix.js；deploy.yml 会复制进 _site）
├── README.md                   # 本文件
├── api/                        # 静态 JSON（D1 为空/异常时的兜底源）
│   ├── tools.json              # 6 个工具，当前全部 enabled:false（临时下架，页面保留）
│   ├── about.json
│   ├── layout.json
│   └── public/
│       ├── posts.json          # 静态兜底：全量文章元数据（条目数可能与 D1 略有差异；线上以 D1 为准，当前 57 行）
│       ├── columns.json        # 1 个专栏「技术杂谈」6 篇
│       ├── tags.json           # 20 个标签
│       └── comments.json
├── article/
│   ├── index.html              # 文章列表（支持 ?col=、?tag=、关键词搜索为前端全量过滤；<head> 已补 SEO 元信息）
│   └── a_*.html                # 文章静态详情页（旧静态兜底，共 56 个；另有若干 index.html@c=* 异常文件名）
├── search/                     # ★ 新增：搜索页（index.html + search.js，调 /api/public/search）
├── privacy/index.html          # ★ 新增：隐私政策（合规页）
├── terms/index.html            # ★ 新增：服务条款（合规页）
├── aboutme/index.html          # 关于我
├── user/
│   ├── login.html              # 登录 + 注册双 tab（支持 ?next=，#register 直达注册；已加「忘记密码？」入口）
│   ├── forgot.html             # ★ 新增：申请密码重置
│   ├── reset.html              # ★ 新增：凭令牌重置密码
│   └── verify.html             # ★ 新增：邮箱验证
├── js/
│   ├── header-fix.js           # 全站统一顶栏注入（含 injectSearchLink()：顶栏「搜索」入口）+ 轻量评论区替换 + 汉堡菜单
│   ├── article-detail-enhance.js  # 旧静态详情页增强：粘性侧栏 + 上下篇 + 目录
│   ├── layout-engine.js        # 页面装修/布局引擎（读 /api/layout.json）
│   ├── lib/                    # jquery-1.11.1.min.js、prismjs
│   └── piano/soundfont/        # 钢琴音色
├── piano/index.html            # 在线钢琴
├── music/
│   ├── index.html              # 在线乐器总览
│   ├── kalimba/index.html      # 卡林巴拇指琴
│   └── guitar-chords/index.html # 吉他和弦库
├── tiaoyin/                    # 调音器（index + banjo/erhu/guitar/mandolin/ukulele/viola/violin）
├── metronome/index.html        # 节拍器
├── o/                          # 旧 Vue SPA 与编译产物（cdn-2607/a/0/*.js|css）+ 历史 uploads
├── cdn.jsdelivr.net/           # 镜像的第三方 CDN 资源
├── uploads/                    # 站点图片/头像等
├── worker/src/
│   ├── index.js                # Cloudflare Worker 入口（路由 + 内置详情模板 + 后台）
│   ├── extend-schema.js        # ★ 新增：扩展表结构，EXTEND_STATEMENTS = 84 条语句（27 表 + 33 ALTER + 24 索引）
│   └── features/               # ★ 新增：零依赖扩展模块（均由 index.js import）
│       ├── seo.js              #   SEO/分发：/robots.txt、/sitemap.xml、/rss.xml、/atom.xml、/feed.json、head 元信息、JSON-LD
│       ├── search.js           #   全文搜索：FTS5 trigram/unicode61 二选一 + LIKE 兜底（engine 报 fts5/like）+ 搜索建议
│       ├── likes.js            #   文章点赞（免登录指纹去重）/ 收藏（需登录）
│       ├── moderation.js       #   评论审核与风控：先审后发、黑名单、批量审核、举报
│       ├── security.js         #   限流（rate_limits）、审计（audit_logs）、安全响应头
│       ├── auth-ext.js         #   密码重置 / 邮箱验证骨架（MAIL_WEBHOOK_URL 可选）
│       ├── stats.js            #   隐私友好统计（visits + ip_hash + 日聚合，UTC+8）
│       ├── notify.js           #   订阅 / 站内信 / Webhook（HMAC-SHA256 签名）
│       ├── users-ext.js        #   资料/头像路径、本人会话、2FA 骨架、OAuth 骨架、评论增强
│       └── content.js          #   文章修订/回滚/定时发布、重定向、后台导出导入（骨架）
├── migrations/
│   ├── 0001_init.sql           # 旧建表（views/comments/votes）
│   ├── 0002_admin_full.sql     # 完整建表（14 张表，手动兜底；Worker 已自动建表）
│   └── 0003_extend.sql         # ★ 新增：扩展表纯 SQL 版（与 EXTEND_STATEMENTS 逐条等价，手动兜底）
├── scripts/restructure.mjs     # 目录重构脚本（幂等）
├── admin/                      # ★ 整个目录都不部署到 Pages
│   ├── index.html              # 后台主界面单页（★ 已含「评论审核」界面：待审队列/筛选/全选批量/举报处理/评论配置/黑名单）
│   ├── web/
│   │   ├── index.html          # 后台子页面
│   │   └── editor.html         # 页面装修编辑器（/admin/web/editor.html 会被映射到仓库同名文件）
│   ├── server.py               # 离线/宝塔模式用的 Python 后台
│   └── data/admin.db           # 离线 SQLite 库（线上已不用）
├── backup/                     # 历史整站备份（不参与部署）
├── .github/workflows/deploy.yml# GitHub Pages 构建部署（逐个判断存在再复制，纳入 search/privacy/terms 与 robots.txt/404.html/sitemap.xml）
├── wrangler.toml               # Worker + D1 + 环境变量（无 routes 段）
├── package.json                # wrangler 依赖与脚本
├── .dev.vars                   # 本地密钥（已 gitignore）
├── node_modules/
├── 需求文档.md 前后端接口指南.md 数据库设计文档.md 数据库说明书.md
├── 功能扩展与H5同步设计.md 移动端App设计与接口规划.md
├── 离线使用说明.md 宝塔部署指南.md
└── README.md
```

### 2.2 目标结构（执行 `node scripts/restructure.mjs` 之后）

```
blog/
├── site/                       # ★ 静态站点（GitHub Pages 部署源）
│   ├── index.html  favicon.ico  soulsoft-tools.css
│   ├── api/  article/  aboutme/  user/  js/  uploads/
│   ├── piano/  music/  tiaoyin/  metronome/  guitar-chords/  kalimba/
│   ├── o/  cdn.jsdelivr.net/
├── worker/src/index.js         # Cloudflare Worker
├── migrations/*.sql            # D1 建表 SQL
├── scripts/restructure.mjs     # 重构脚本
├── admin/                      # 后台（留根，不进 site/，不部署）
│   ├── index.html              # 后台主界面单页
│   ├── web/index.html          # 后台子页面
│   ├── web/editor.html         # 页面装修编辑器
│   ├── server.py               # 离线/宝塔模式用的 Python 后台
│   └── data/admin.db           # 离线 SQLite 库
├── backup/                     # 历史备份（留根，不部署）
├── .github/workflows/deploy.yml
├── wrangler.toml  package.json  CNAME  README.md
└── 离线使用说明.md 宝塔部署指南.md 及其余中文文档
```

被移入 `site/` 的条目（脚本 `MOVE_INTO_SITE`）：`aboutme`、`article`、`guitar-chords`、`js`、`kalimba`、`metronome`、`music`、`o`、`piano`、`tiaoyin`、`uploads`、`user`、`cdn.jsdelivr.net`、`api`、`index.html`、`favicon.ico`、`soulsoft-tools.css`。
留在根目录的条目（脚本 `KEEP_AT_ROOT`）：`site`、`worker`、`migrations`、`scripts`、`.github`、`.git`、`.gitignore`、`package.json`、`wrangler.toml`、`CNAME`、`README.md`、`backup`、`admin`、`离线使用说明.md`、`宝塔部署指南.md`、`node_modules`、`.wrangler`、`.dev.vars` 等。

### 2.3 重构注意事项

1. **先备份再动手**。至少把根目录整体复制一份（或确认 `backup/` 里有可用快照），脚本本身只做「同盘改名」，没有回滚逻辑。
2. **`wrangler.toml` 的 3 个 raw 变量必须同步改**，否则正文补抓与静态 JSON 兜底会 404。把路径中的 `/main/api`、`/main/article` 改成 `/main/site/api`、`/main/site/article`：

   | 变量 | 重构前 | 重构后 |
   | --- | --- | --- |
   | `POSTS_URL` | `.../blog/main/api/public/posts.json` | `.../blog/main/site/api/public/posts.json` |
   | `RAW_API_BASE` | `.../blog/main/api` | `.../blog/main/site/api` |
   | `RAW_ARTICLE_BASE` | `.../blog/main/article` | `.../blog/main/site/article` |

   `RAW_ADMIN_BASE`（`.../main/admin`）与 `STATIC_ORIGIN` **不用改**：admin 留在根目录，Pages 站点根不变。
3. **改完重新部署 Worker**：`npx wrangler deploy`。然后访问 `/api/ping`，确认 `raw_article_status: 200`（若是 404，就是上面 3 个变量没改对）。
4. **`admin/` 与 `backup/` 不进 `site/`**：admin 只在 Pages 之外由 Worker 服务，避免后台被公开下载；`backup/` 含大量历史文件，入站无意义且拖慢构建。
5. **`.github/workflows/deploy.yml` 无需改**：它已写成「有 `site/` 就用 `site/`，否则回退复制根目录的静态目录」，两种情况都能正确部署，并且始终排除 `admin`、复制根 `CNAME`。
6. **脚本幂等**：重复执行不会二次移动；目标已存在的条目会打印 `[skip]` 跳过；未识别条目打印 `[warn]` 并留在根目录。
7. **`article/` 目录里有若干异常文件名**（形如 `article/index.html@c=docker.html`、含乱码的 `index.html@c=...`），像是一次带 URL 的抓取误写出的产物。脚本只搬目录、不清理内容，建议重构后手工核对并删除这些非预期文件。
8. **清浏览器缓存**：重构只影响仓库布局与 Pages 部署，不影响线上 URL（URL 由 Pages 站点根决定），但 CDN/浏览器缓存可能仍持旧资源。

---

## 3. 功能清单

### 3.1 前台

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 首页文章卡片 + hero 统计卡 | ✅ | 根 `index.html`，数据来自 `/api/public/posts.json` |
| 首页侧栏专栏/标签筛选 | ✅ | 多标签为 **AND** 过滤；选中专栏后卡片链接自动带 `?col=` |
| 文章列表页 | ✅ | `article/index.html`，支持 `?col=`、`?tag=` |
| 文章列表页关键词搜索 | 🚧 | 纯**前端全量过滤**：先取 `/api/public/posts.json` 全量，再在浏览器内按标题/摘要过滤；Worker 的 `posts.json` **不支持 `search` 参数**（`article/index.html` 原先会拼 `&search=` 导致接口 404，已修为前端过滤；本轮新增，待 `git push`） |
| 文章详情动态渲染 | ✅ | `/article/a_*.html` 由 Worker 用内置模板直出（顶栏 + 正文 + 评论区 + 右侧目录/上下篇/专栏面板） |
| 右侧专栏面板「两态」 | 🚧 | 无 `?col=`：只列「专栏名 + N 篇」；带 `?col=`：服务端直出「`← 返回专栏` + 选中栏高亮 + 该栏文章列表」（本轮新增，待部署） |
| 上下篇跟随专栏 | 🚧 | SQL 用 `id IN (SELECT post_id FROM post_columns WHERE column_id=?)` 限定；「上一篇/下一篇」卡片**居左**（本轮新增，待部署） |
| 详情页原地切换专栏 | 🚧 | 点击专栏不刷新页面，原地切换并同步更新上下篇与地址栏；栏内互跳带 `?col=` 保留上下文（本轮新增，待部署） |
| 专栏文章接口 + 前端回退 | 🚧 | `GET /api/columns/<专栏名>/articles?cur=<source_file>`；接口不可用时前端回退用 `/api/public/posts.json` 自行筛选（本轮新增，待部署） |
| 首页/列表页带上下文进详情 | 🚧 | 选中专栏后进入详情页自动带 `?col=`（本轮新增，待部署） |
| 全站统一顶栏 | ✅ | `js/header-fix.js` 注入，含登录/注册双按钮、移动端汉堡菜单、DOM 变化兜底重跑 |
| 工具导航开关 | ⏸ | 按 `/api/tools.json` 的 `enabled` 过滤；当前 6 个工具全部 `enabled:false`（**临时下架**，页面保留、入口隐藏，改回 `true` 即恢复） |
| 轻量评论区 | ✅ | `header-fix.js` 把旧 Vue `.xw-pinlun2` 组件替换为原生轻量评论区 |
| 旧页脚清理 | ✅ | `header-fix.js` 执行 `document.querySelectorAll("footer.xw-footer, footer")` 并 `display:none`，即**隐藏页面上所有 `<footer>`**（不只 `.xw-footer`），以清掉旧模板残留页脚 |
| 登录 / 注册页 | ✅ | `user/login.html`，登录+注册双 tab，支持 `?next=`，`#register` 直达注册 |
| 阅读量打点 | 🚧 | 详情页 `POST /api/view`，D1 `views` + `posts.views` 双写，列表按 `posts.views` 排序；**内置模板补上幂等打点**：`sessionStorage` 键 `blog_viewed_<source_file>`，同一会话同一文章只计一次（本轮新增，待部署；修复此前动态渲染页 `views` 恒为 0） |
| 在线工具页 | ✅ | 钢琴、乐器总览、卡林巴、吉他和弦、调音器、节拍器（页面在，导航临时隐藏） |
| 关于我 / 页面装修 | ✅ | `aboutme/`；装修由 `js/layout-engine.js` 读 `/api/layout.json` |
| 移动端适配 | ✅ | 响应式布局 + 汉堡侧边菜单 |
| 旧静态详情页增强 | ✅ | `js/article-detail-enhance.js`（粘性侧栏 + 上下篇 + 目录），用于未命中 D1 的回退页 |
| **SEO / 分发（页面 `<head>`）** | 🚧 | 详情页 `<head>` 由 Worker 注入 canonical / meta description / OG / Twitter Card / JSON-LD（`Article` + `BreadcrumbList`）；`index.html` 与 `article/index.html` 的 `<head>` 已加 description/canonical/OG/Twitter/订阅发现链接 + 首页 `WebSite` JSON-LD。**Worker 侧需 `npx wrangler deploy`；静态页需 `git push`** |
| **订阅源与爬虫文件** | 🚧 | `/robots.txt`、`/sitemap.xml`（数据源 D1 `posts`）、`/rss.xml`、`/atom.xml`、`/feed.json` —— 实现见 `worker/src/features/seo.js`，**需 `npx wrangler deploy`**；仓库根另有**静态兜底** `robots.txt` 与站点风格 `404.html`（**需 `git push`**） |
| **搜索页 + 顶栏搜索入口** | 🚧 | 新增 `search/index.html` + `search/search.js`（调 `/api/public/search`，显示 `engine` 降级情况）；`js/header-fix.js` 新增 `injectSearchLink()` 让全站顶栏出现「搜索」入口。**静态侧，需 `git push`** |
| **文章点赞 / 收藏** | 🚧 | 详情页正文与评论区之间渲染按钮：点赞**免登录**（指纹 `IP\|UA` 去重、同向再点取消），收藏**需登录**（未登录 401「请先登录」）。**首屏不显示「我是否已赞」，点一次后由响应回填**。需 `npx wrangler deploy` |
| **评论先审后发 / 举报入口** | 🚧 | 敏感词、`settings.comment.moderate=true`、链接数超 `linkLimit` → 入库 `status=0` 待审（文案「已提交，待站长审核后展示」）；黑名单命中 → **直接拒绝**；公开 `POST /api/report`（幂等）。需 `npx wrangler deploy` |
| **密码重置 / 邮箱验证页** | 🚧 | 新增 `user/forgot.html`、`user/reset.html`、`user/verify.html`，登录页加「忘记密码？」。**邮件未配置**时接口返回 `data.mailConfigured:false` 并提示「请联系站长」。**静态页需 `git push`** |
| **合规页（隐私政策 / 服务条款）** | 🚧 | 新增 `privacy/index.html`、`terms/index.html`，并纳入 `deploy.yml` 组装清单。**静态页，需 `git push`** |

### 3.2 后台（`admin/index.html` 单页，原 11 组 + 🚧 本轮新增 3 组扩展）

| # | 分组 | 状态 | 关键接口 |
| --- | --- | --- | --- |
| 1 | 仪表盘 | ✅ | `GET /api/dashboard`（含 seed 与正文补抓结果、待审计数） |
| 2 | 文章管理 | ✅ | `GET /api/posts`、`POST /api/posts/{create,update,delete,import_content}`、`POST /api/import_posts` |
| 3 | 分类管理 | ✅ | `/api/categories[/create|update|delete]` |
| 4 | 标签管理 | ✅ | `/api/tags[...]` |
| 5 | 分栏管理 | ✅ | `/api/columns[...]` |
| 6 | 评论管理 | ✅ | `GET /api/comments`、`POST /api/comments/{update,delete}` |
| 7 | 用户管理 | ✅ | `/api/users[/create|update|delete|resetpwd]` |
| 8 | 工具设置 | ✅ | `GET|POST /api/settings/tools` |
| 9 | 关于我编辑 | ✅ | `GET|POST /api/settings/about` |
| 10 | 页面装修 | ✅ | `GET|POST /api/settings/layout`、`POST /api/settings/layout/reset` |
| 11 | 个人设置 | ✅ | `POST /api/settings` |
| 12 | **评论审核**（新增界面） | 🚧 | 待审队列 / 筛选 / 全选批量 / 举报处理 / 评论配置 / 黑名单 → `POST /api/admin/comments/bulk`（approve/reject/**物理删除**，单次上限 100）、`GET / POST /api/admin/comments/report`、`GET / POST /api/admin/settings/comment`、`GET / POST / DELETE /api/admin/comment-blacklist`。界面在 `admin/index.html`，随 Worker 部署生效（需 `npx wrangler deploy`） |
| 13 | **限流与审计**（新增） | 🚧 | `GET /api/admin/audit-logs`（super_admin）、`GET / POST / DELETE /api/admin/rate-limits`（super_admin）；实现见 `worker/src/features/security.js`，需 `npx wrangler deploy` |
| 14 | **订阅 / 通知 / Webhook**（新增） | 🚧 | `GET / DELETE /api/admin/subscribers`（支持 `?format=csv` 导出）、`GET / POST /api/admin/notifications`、`GET / POST / DELETE /api/admin/webhooks`（HTTPS 校验、secret 只回前 4 位、投递记录）；另有 `GET /api/admin/stats?days=30`（统计）与 `GET /api/admin/auth/tokens`（令牌只回前 8 位）。需 `npx wrangler deploy` |

补充：`POST /api/upload` 上传（base64 存 D1 `uploads`，≤3MB；扩展名白名单 16 项：`.png .jpg .jpeg .gif .webp .svg .mp3 .wav .ogg .m4a .aac .mid .midi .mp4 .webm .mov`，超过 3MB 返回 **413**），`GET /api/uploads/<file>` 公开读取。

**后台鉴权分两套，切勿混用**：`handleAdmin` 下的**所有后台接口只认 `X-Token` 请求头**，不看 Cookie；Cookie `session` 只对 **`/admin*` 页面**（`guardAdmin`，见 §1.1 ⑪）有效。角色分 `super_admin / admin / user`，权限分层：`/api/users*` 仅 `super_admin`；`POST /api/settings` 只需登录（改自己的资料，无 admin 判断）；`POST /api/upload` 需 `admin`。

**登录态与 token 存储（双层防护）**

| 位置 | Key | 说明 |
| --- | --- | --- |
| 登录页 `user/login.html` | `shawn_site_token` | 站点 token，登录/注册成功后写入 |
| 同上（兼容键） | `xw_token` / `xw_username` | 镜像写入，供旧全站导航/评论组件读登录态 |
| 同上（管理员才写） | `shawn_admin_token` / `shawn_admin_role` | 仅当账号 `role ∈ (admin, super_admin)` 时写入 |
| 后台 `admin/index.html` | `shawn_admin_token` | `TOKEN = localStorage.getItem("shawn_admin_token")`，所有后台请求带 `X-Token: TOKEN` |

- **登出**：上述 key 一并清除。
- **回跳**：登录页 `next` 参数只允许**站内相对路径**（防开放重定向）。若 `next` 以 `/admin` 开头但当前账号不是管理员，**不回跳后台而回首页**。
- **后台未登录/非管理员**：`admin/index.html` 的 `boot()` 在无 token 或 `/api/me` 不通过时 `showLogin()` 跳 `/user/login.html?next=/admin/index.html`；`/api/me` 返回的角色不是 `admin`/`super_admin` 时直接 `location.href="/index.html"`。前端拦一层，Worker 侧 `guardAdmin` 再返回纯文本 404 兜底 —— **双层防护**。
- **`#register` 锚点**：打开 `/user/login.html#register` 自动切到注册 tab（顶栏「注册」按钮即指向该地址）。

### 3.3 动态能力（D1）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 14 张业务表 | ✅ | `users`、`sessions`、`categories`、`posts`、`tags`、`post_tags`、`columns`、`post_columns`、`comments`、`votes`、`settings`、`about_versions`、`views`、`uploads` |
| 首次请求自动建表 | ✅ | `ensureSchema`，幂等，逐条 `prepare().run()`，含 `users.email`、`comments.post_id` 列迁移 |
| 文章真源迁 D1 | ✅ | 列表接口 D1 优先；`posts` 为空则自动从 raw 静态 JSON seed |
| 正文自动补抓清洗 | ✅ | `backfillPostContent`，每次 ≤10 篇，占位/混入旧评论组件的正文从 raw 重抓 |
| 阅读量双写 | ✅ | `views` UPSERT +1 且 `posts.views` +1（接口本身已上线） |
| 动态渲染页打点补漏 | 🚧 | 内置模板原先未调用 `POST /api/view`，导致线上 `views` 恒为 0；现补上 `sessionStorage` 幂等打点（`blog_viewed_<source_file>`，同会话同文只计一次），待部署 |
| 列表聚合优化 | ✅ | 标签/分栏各 1 次聚合查询，替代逐篇子查询 |
| 缓存策略 | ✅ | 见 §7.4 缓存策略要点 |
| 线上实测 | ✅ | `/api/ping`：`d1:true`、`posts_total:57`、`posts_dirty_content:0`、`raw_article_status:200` |
| 扩展表结构（27 张） | 🚧 | `worker/src/extend-schema.js`（`EXTEND_STATEMENTS`，84 条 = 27 表 + 33 ALTER + 24 索引）+ `migrations/0003_extend.sql`；`ensureSchema` 已接线（② 扩展结构，独立 marker `article_likes`，**不复用 `posts` 快速路径**），待 `npx wrangler deploy`。**部署后 `/api/ping` 的 `tables` 由 16 项变 43 项** |
| 站点级文件（爬虫协议 / sitemap / 自定义 404） | 🚧 | 根目录 `robots.txt`（静态兜底）与 `404.html`（站点风格自定义 404，含 `/js/header-fix.js`）已就绪，并已在 `deploy.yml` 组装 `_site` 时复制进 Pages；Worker 动态版 `/robots.txt`、`/sitemap.xml`、`/rss.xml`、`/atom.xml`、`/feed.json` 已在 `worker/src/features/seo.js` 接线，待 `npx wrangler deploy` |
| 全文搜索（FTS5） | 🚧 | `worker/src/features/search.js`：`GET /api/public/search?q=&page=&pageSize=`。**FTS5 建表优先 `trigram`、未编译退 `unicode61`；查询失败退 `LIKE`。响应 `engine` 只有 `fts5` / `like` 两个取值（不暴露分词器名）。** `q` 长度 <3 直接走 `LIKE`；结果含 `title_html` 高亮；每页默认 10、上限 50，返回 `has_more`。`GET /api/public/search/suggest?q=` 返回标题 + 历史热词。索引自愈：`posts_fts` 行数 ≠ `posts(status=1)` 行数即整表重建（**后台增删文章无需同步调用**）；**已知边界：只比行数，只改标题/正文而文章数不变时索引不会立刻刷新**。需 `npx wrangler deploy` |
| 文章点赞 / 收藏 | 🚧 | `worker/src/features/likes.js`：`POST /api/article/like` 免登录（指纹 `IP\|UA` 去重、`ON CONFLICT DO NOTHING`、同向再点即取消的切换语义）；`POST /api/article/bookmark` **需登录**（`X-Token` 或 `session` Cookie，未登录 401「请先登录」）。详情页正文与评论区之间渲染按钮（服务端注入 counts；**首屏无法显示「我是否已赞」**，点一次后由响应回填）。需 `npx wrangler deploy` |
| 评论审核与风控 | 🚧 | `worker/src/features/moderation.js`：`publish` 前跑 `checkCommentRisk` —— 黑名单命中（`word`/`ip`/`ua`/`email`/`client`，支持过期时间）→ **拒绝**；敏感词命中 / `settings.comment.moderate=true` / 链接数超 `linkLimit` → **入库 `status=0` 待审**。评论现在会写 `comments.post_id`（按 `page_id` → `posts.source_file` 反查，历史数据仍为 0）。后台「评论审核」界面（`admin/index.html`）已就绪。需 `npx wrangler deploy` |
| 限流与审计 | 🚧 | `worker/src/features/security.js`：限流为**固定窗口**（表 `rate_limits`，规则可用 `settings.rate_limits` 覆盖，**表缺失/SQL 报错一律放行并带 `degraded:true`**），已接线 9 处（`view` 60/分、`report` 10/时、`login` 10/5分、`register` 3/时、`pwreset` 5/时、`subscribe` 5/分、`search` 30/分、`comment` 5/分（评论发布）、`upload` 20/时按用户维度）；触发返回 **429 + `Retry-After` + `X-RateLimit-Limit/Remaining/Reset`**（另有 `access-control-expose-headers`）。审计写 `audit_logs`（best-effort，**登录埋点尚未接**）。另有安全响应头与 `X-Request-Id`。需 `npx wrangler deploy` |
| 访问统计（隐私友好） | 🚧 | `worker/src/features/stats.js`：只对「回源成功的 HTML 页面」与文章页记一次访问；`visits` 存 `client_key`（`IP\|UA`）与 **SHA-256 的 `ip_hash`（不存原始 IP）**、ua/referer/country；日界按 **UTC+8**。`GET /api/public/stats`（文章数/评论数/总阅读/点赞数/今日 PV·UV/近 7 天，**不含明细**）、后台 `GET /api/admin/stats?days=30`（daily/topPages/topPosts/totals）、`aggregateDaily` 支持手动/懒聚合。需 `npx wrangler deploy` |
| 密码重置 / 邮箱验证（骨架） | 🚧 | `worker/src/features/auth-ext.js`：`POST /api/auth/password/request`（**无论账号是否存在都返回同一响应**防枚举，令牌只出现在服务端日志与审计前缀）、`POST /api/auth/password/confirm`（改密 + **踢掉该用户全部会话**）、`POST /api/auth/email/verify/request`（需登录）、`POST /api/auth/email/verify/confirm`；后台 `GET /api/admin/auth/tokens`（令牌只回前 8 位）。**邮件未配置**：返回 `data.mailConfigured:false` 并提示「请联系站长」；配置 `MAIL_WEBHOOK_URL` 后走真实投递。用户侧页面 `user/forgot.html`、`user/reset.html`、`user/verify.html`（**静态侧需 `git push`**）。需 `npx wrangler deploy` |
| 订阅与通知 | 🚧 | `worker/src/features/notify.js`：`POST /api/subscribe`（邮箱校验 + `subscriptions` 与 `newsletter_subscribers` 双写 + 可选邮件；**只有未配置邮件时才在响应里返回退订 token**）、`GET / POST /api/unsubscribe?token=`（极简 HTML 结果页）、`GET / POST /api/my/notifications`（登录用户读自己的站内信、可标记已读）。`notifyEvent()` 写站内信 + 按 `webhooks.events` 投递（HMAC-SHA256 签名 `X-Blog-Signature`、5 秒超时、写 `webhook_deliveries`）；**已在评论发布时调用**（`comment.new` / `comment.reply`），**注册与举报暂未接**。需 `npx wrangler deploy` |

**本轮新实现（🚧 代码就绪，线上尚未部署）**：
1. 专栏面板两态直出（无 `?col=` 只列「专栏名 + N 篇」；带 `?col=` 服务端直出「专栏文章展示态」）；
2. 上下篇限定专栏内 + 详情页原地切换专栏（不刷新，同步地址栏）；
3. `GET /api/columns/<专栏名>/articles?cur=<source_file>`（前端带 `/api/public/posts.json` 筛选兜底）；
4. 首页/列表页选中专栏后进详情自带 `?col=`；
5. **阅读量打点补漏**：内置模板原先没调用 `POST /api/view`（旧静态页依赖的 `js/article-detail-enhance.js` 在动态渲染后已不再加载），导致线上 `views` 恒为 0；现已在模板中补上幂等打点（`sessionStorage` 键 `blog_viewed_<source_file>`，同一会话同一文章只计一次）；
6. **文章列表页关键词搜索改前端过滤**：`article/index.html` 原先会拼 `&search=` 去请求 `/api/public/posts.json`（Worker 的该接口**不支持 `search` 参数**）导致 404，现改为先取全量、再在浏览器内按标题/摘要过滤。

以上 6 项都要部署后才在线上生效：第 1–5 项需 `npx wrangler deploy`（Worker 侧），第 6 项是静态页 `article/index.html`，需 `git push` 后由 Pages 构建生效。

> 📌 **站点级文件（爬虫协议 / sitemap / 自定义 404）已就绪，状态 🚧 代码就绪待部署**：`robots.txt` 作为**静态兜底**放在仓库根（`deploy.yml` 会复制进 `_site`）；**动态版**由 Worker 提供 —— `/robots.txt`、`/sitemap.xml`（数据源为 D1 `posts`）、以及订阅源 `/rss.xml`、`/atom.xml`、`/feed.json`，实现见 `worker/src/features/seo.js`，路由已在 `worker/src/index.js` 接线，**待 `npx wrangler deploy` 生效**。`404.html` 是站点风格的自定义 404（含 `/js/header-fix.js`），已接入 Pages 部署（`git push` 后生效）。

### 3.4 补充包落地状态（**部分已落地 🚧，其余 ⏳**）

> 来源：独立文档 [追加补充.md](./追加补充.md)（增量补充包，只新增不替换既有编号）。本节仅作**索引式概览**，完整清单见《追加补充.md》与《需求文档》§3.8–3.10。
> **状态口径**：**🚧 代码就绪待部署** = 代码已实现（**Worker 侧需 `npx wrangler deploy`，静态页/JS 需 `git push`**），未部署前线上仍表现为 404；**⏳ 规划中** = 只有设计、代码尚未实现，不要用于联调。逐条状态见《需求文档》§3.8–3.10 与 §6 追踪矩阵。

| 方向 | 规划项 | 落地状态 | 优先级 |
| --- | --- | --- | --- |
| SEO / 订阅 / 搜索 | `robots.txt`、`sitemap.xml`、canonical/meta、OG、JSON-LD、Feed（rss/atom/feed.json）、`/api/public/search` + FTS5、搜索建议 —— **已落地 🚧**；归档页（年/月）、标签/分类聚合、作者页、相关文章、文章增强（封面/字数/阅读时长/TOC/代码复制/灯箱/懒加载/脚注/公式/附件）—— **仍 ⏳** | 🚧 已落地项见 `worker/src/features/{seo,search}.js` + `search/`（需 `npx wrangler deploy` / `git push`）；搜索响应 `engine` 只有 `fts5` / `like` 两个取值（FTS5 建表优先 `trigram`、未编译退 `unicode61`；查询失败退 `LIKE`；不暴露分词器名） | P0（SEO 基础、Feed、搜索基础、点赞收藏）· P1（其余） |
| 评论审核与风控 | 先审后发开关、审核队列与批量通过/拒绝、敏感词、频率限制、IP/UA 黑名单、举报处理 —— **已落地 🚧**；Turnstile、评论增强（Markdown/表情/Gravatar）—— **仍 ⏳** | 🚧 `worker/src/features/moderation.js` + `features/security.js` + 后台「评论审核」界面 | P0（审核与风控）· P2（评论 Markdown/表情） |
| 通知 | 站内信、Webhook —— **已落地 🚧**（评论发布已触发）；回复邮件通知扩展、@提醒 —— **仍 ⏳** | 🚧 `worker/src/features/notify.js` | P1 |
| 订阅 | 邮件订阅 / Newsletter、订阅者管理与导出（含 CSV）、退订 —— **已落地 🚧** | 🚧 `worker/src/features/notify.js` + `/api/subscribe`、`/api/unsubscribe` | P1 |
| 用户体系 | 密码重置、邮箱验证 —— **已落地骨架 🚧**（**邮件未配置**，返回 `mailConfigured:false`）；资料与头像（`/api/my/profile`，头像为**路径校验**）、本人会话管理（`/api/my/sessions`）、2FA（`/api/my/2fa`，**登录尚不校验动态码**）、第三方登录（`/api/oauth/<provider>/*`，**未配 `GITHUB_CLIENT_ID` 返回 501**）—— **骨架已接线 🚧**；登录日志/异常登录提醒、2FA 校验闭环、OAuth state 校验与自动建号 —— **仍 ⏳** | 🚧 `worker/src/features/auth-ext.js` + `features/users-ext.js` + `user/forgot.html`、`user/reset.html`、`user/verify.html` | P0（密码重置）· P1（资料/会话）· P2（2FA/OAuth） |
| 安全与合规 / 可访问性 / 测试 | 安全响应头（CSP/HSTS 等）、限流防刷、审计日志、隐私政策/服务条款 —— **已落地 🚧**（「审计日志」的**登录埋点尚未接**）；**可访问性已落地 🚧**（`js/header-fix.js` 的 `injectA11y()`：「跳到正文」跳转链接 + `:focus-visible` + `prefers-reduced-motion` + 导航 `aria-label`，**需 `git push`**；对比度与完整 WCAG 2.1 AA 复核仍 ⏳）；Cookie 同意/备案信息、单元·集成·E2E + CI 预览 —— **仍 ⏳** | 🚧 `worker/src/features/security.js` + `privacy/`、`terms/` + `js/header-fix.js` | P0（安全与合规）· P1（可访问性、测试） |
| 统计 | 隐私友好访问统计（今日 PV·UV / 近 7 天 / Top 页与文章）—— **已落地 🚧**；UV/PV 之外的统计看板 —— **仍 ⏳** | 🚧 `worker/src/features/stats.js` + `GET /api/public/stats`、`GET /api/admin/stats` | P1 |
| 仍未实现 | 修订的**版本对比 UI**与草稿预览、重定向**后台维护界面**（修订与重定向的**界面**已在 `admin/index.html`「内容运营」面板提供，但**无版本对比 UI**）、**深色模式**（各页颜色硬编码在内联 `<style>`，需先抽 CSS 变量）、图片优化、2FA 校验闭环与恢复码、OAuth `state` 校验与自动建号、登录日志/异常登录提醒、国际化/主题、Turnstile、R2、Cron/告警、`/api/public/related`、`/api/public/archive`、`/api/public/tags/<tag>/posts` 等 | ⏳ 规划中 | P1/P2 |
| **骨架已接线（⚠ 勿当已完成）** | 修订/回滚/定时发布（`features/content.js`：`/api/admin/revisions`、`POST /api/posts/schedule`）、重定向（`/api/admin/redirects`）、后台导出导入（`/api/admin/export`、`/api/admin/import`）、资料/头像（`/api/my/profile`）、本人会话（`/api/my/sessions`）、2FA（`/api/my/2fa`）、OAuth（`/api/oauth/<provider>/*`）、后台用户扩展总览（`/api/admin/users-ext`）、评论增强（`enhanceComments`） | 🚧 代码就绪待部署（**骨架**：2FA 登录不校验动态码、OAuth 未配 client id 返 501 且不校验 state、头像为路径校验、重定向无后台界面、修订无版本对比 UI） | P1/P2 |

> P0/P1/P2 的完整口径见《追加补充.md》§五「建议落地优先级」；本节与《功能扩展与H5同步设计》§10/§18 路线图同源。**「仓库里已有扩展表结构」不等于功能已可用**：表由 `worker/src/extend-schema.js`（84 条语句）在首个 `/api/*` 请求自动创建，业务是否可用仍看上面的落地状态列。

---

## 4. 部署步骤

### 4.0 可用的 npm 脚本

`package.json` 已提供以下脚本（`npm run <name>`）：

| 脚本 | 实际命令 | 用途 |
| --- | --- | --- |
| `dev` | `wrangler dev` | 本地启动 Worker |
| `deploy` | `wrangler deploy` | 部署 Worker |
| `db:migrate` | `wrangler d1 execute t_blog_qingyi --remote --file=migrations/0002_admin_full.sql` | 手动建表（**完整版**，14 张表） |
| `db:tables` | `wrangler d1 execute t_blog_qingyi --remote --command "SELECT name FROM sqlite_master WHERE type='table'"` | 查看线上表清单 |

> ⚠ **`migrations/0001_init.sql` 是历史遗留文件，勿用于建表**（只含早期的 `views`/`comments`/`votes`）。完整建表请用 `npm run db:migrate`（即 `migrations/0002_admin_full.sql`），或直接依赖 Worker 首次请求的自动建表 `ensureSchema`——后者是常规路径，手动建表仅作兜底。

### 4.1 第一步：GitHub Pages（静态站）

1. 仓库 **Settings → Pages → Build and deployment**，Source 选 **GitHub Actions**，Custom domain 填 `blog.qingyi.dpdns.org`。
2. Cloudflare DNS 添加：`blog` → CNAME → `kingku-shawn.github.io`，**代理状态：已代理（橙色小云朵）**。
3. 推送代码触发构建（`.github/workflows/deploy.yml` 会组装 `_site`、排除 admin、复制根 `CNAME`）：
   > 📌 **组装清单补充**：`deploy.yml` 还会从**仓库根**复制**站点级文件** `robots.txt`、`404.html`、`sitemap.xml`（**存在才复制**，用 `for f in ...; do if [ -f "$f" ]; then cp "$f" _site/; fi; done`）。当前仓库根有 `robots.txt` 与 `404.html`，**没有**静态 `sitemap.xml`（`/sitemap.xml` 由 Worker 动态生成），因此实际只复制前两个，属预期。

```bash
git add -A && git commit -m "docs: 补全 README" && git push origin main
```

4. 到仓库 **Actions** 页确认 `Deploy to GitHub Pages` 变绿。

**预期结果**：`https://kingku-shawn.github.io/blog/` 可打开首页（裸源正常）。

### 4.2 第二步：部署 Worker + 绑定 D1

```bash
npm install            # 安装 wrangler
npx wrangler whoami    # 确认已登录；未登录先 npx wrangler login
npx wrangler deploy    # 部署 Worker（wrangler.toml 已含 D1 绑定）；等价于 npm run deploy

# 查看部署结果（应输出部署后的 *.workers.dev 地址）
npx wrangler deployments list
```

**预期结果**：命令输出 `Uploaded blog-server` 与一个 `https://blog-server.<子域>.workers.dev` 地址；此时该地址下 `/api/ping` 已可用（D1 绑定随 `[[d1_databases]]` 一起生效）。

> **建表已自动化**：首次 `/api/*` 请求会执行内嵌 `SCHEMA_SQL`（幂等，14 张表 + 列迁移），**无需**手动建表。手动兜底用 `npm run db:migrate`（指向完整版 `migrations/0002_admin_full.sql`）；`migrations/0001_init.sql` 是历史遗留，勿用。查线上表清单用 `npm run db:tables`。
>
> 📌 **扩展表同样自动创建（🚧 代码就绪待部署）**：`ensureSchema` 在基础结构之后还会执行 `worker/src/extend-schema.js` 的 `EXTEND_STATEMENTS` —— **84 条语句**（27 张扩展表 + 33 条 `ALTER TABLE` 字段增补 + 24 条索引），用**独立 marker `article_likes`** 判断（不复用 `posts` 快速路径），逐条吞错、失败下次请求自动重试。因此**扩展表会在首个 `/api/*` 请求自动创建，首次请求略慢**属预期；**部署后 `/api/ping` 的 `tables` 由 16 项变 43 项**。纯 SQL 版为 `migrations/0003_extend.sql`（手动兜底；重复执行时 33 条 `ALTER` 报 `duplicate column name` 属预期）。

### 4.3 第三步：设置管理员密码 secret

```bash
npx wrangler secret put ADMIN_PASS
# 按提示粘贴密码后回车（密码不会写进仓库）
npx wrangler secret list   # 预期列出 ADMIN_PASS
```

> 用户名由 `wrangler.toml` 的 `ADMIN_USER = "kingkushawn"` 指定（公开无妨）：该用户名注册时自动成为管理员。本地联调可把密码写进 `.dev.vars`（已 gitignore）。

### 4.4 第四步：Cloudflare 路由

`wrangler.toml` **没有 `routes` 段**（避免覆盖控制台里已配的绑定与路由），路由在控制台维护：

1. 进入 **Cloudflare 控制台 → Workers & Pages → `blog-server` → Settings → Domains & Routes → Add route**。
2. 添加：**Zone** `qingyi.dpdns.org`，**Route** `blog.qingyi.dpdns.org/*`（整站统一入口），保存。
3. 若只想精确接管动态端点，可改为分别添加 `blog.qingyi.dpdns.org/api/*`、`/api-v1/*`、`/article/*`；但整站路由体验最好（静态由 Worker 反代回源）。
4. 若 dpdns.org 不在自己 Cloudflare 账号托管，则本步无法配置 zone 路由，改走 Worker 的 `*.workers.dev` 地址测试。

### 4.5 第五步：验证

```bash
# 1) 健康检查：期望 d1:true、tables 含 14 张表、posts_total>0、raw_article_status:200
curl -s https://blog.qingyi.dpdns.org/api/ping
```
期望 JSON（字段顺序可能不同）：
```json
{
  "ok": true, "now": 1760000000000, "d1": true,
  "tables": ["_cf_KV","about_versions","categories","columns","comments","post_columns","post_tags","posts","sessions","settings","sqlite_sequence","tags","uploads","users","views","votes"],
  "posts_total": 57, "posts_dirty_content": 0, "raw_article_status": 200
}
```

```bash
# 2) 首页：Worker 反代回源 Pages
curl -sI https://blog.qingyi.dpdns.org/ | findstr /I "HTTP content-type"
# 预期：HTTP/1.1 200 OK，content-type: text/html

# 3) 文章详情动态渲染
curl -s "https://blog.qingyi.dpdns.org/article/a_5a0bf49035583c99c0b28d70.html" | findstr /I "xw-pinlun2"
# 预期：返回完整 HTML（含顶栏/正文/评论/右侧目录）

# 4) 专栏两态
curl -s "https://blog.qingyi.dpdns.org/article/a_5a0bf49035583c99c0b28d70.html?col=%E6%8A%80%E6%9C%AF%E6%9D%82%E8%B0%88" | findstr /I "返回专栏"
# 预期：HTML 中直接含「← 返回专栏」展示态

# 5) 专栏文章接口
curl -s "https://blog.qingyi.dpdns.org/api/columns/技术杂谈/articles"
# 预期：{"ok":true,"data":[{"title":"...","source_file":"a_....html"}, ...]}

# 6) 后台保护：未登录必须是 404（纯文本）
curl -sI https://blog.qingyi.dpdns.org/admin | findstr /I "HTTP"
# 预期：HTTP/1.1 404 Not Found（这是设计如此，不是故障）

# 7) SEO / 订阅源（🚧 需先 npx wrangler deploy）
curl -sI https://blog.qingyi.dpdns.org/sitemap.xml     # 预期 200
curl -s  https://blog.qingyi.dpdns.org/robots.txt      # 预期含 Sitemap:
curl -sI https://blog.qingyi.dpdns.org/rss.xml         # 预期 200

# 8) 全文搜索与降级情况（engine 字段）
curl -s "https://blog.qingyi.dpdns.org/api/public/search?q=技术&page=1"
# 预期：{"ok":true,"data":{...,"engine":"...","has_more":...}}；q 少于 3 字符会走 like

# 9) X-Request-Id 与安全响应头（🚧）
curl -sI https://blog.qingyi.dpdns.org/api/ping | findstr /I "x-request-id x-content-type-options x-frame-options"
```

7. 浏览器打开任意文章详情 → 刷新首页 → 该文阅读量 +1（🚧 打点补漏需先 `npx wrangler deploy` 才生效；幂等，同会话同文只计一次）。
8. 任意响应头应含 **`X-Request-Id`**（所有响应，含静态回源）；连续请求受限接口触发限流时应看到 **429 + `Retry-After` + `X-RateLimit-*`**（均 🚧 需 `npx wrangler deploy`）。
9. 静态侧验证（**需 `git push`**）：访问 `/search/index.html`（或点顶栏「搜索」）、`/user/forgot.html`、`/privacy/`、`/terms/`、`/404.html` 均可达。

### 4.6 实时日志（排障必备）

```bash
npx wrangler tail blog-server
# 另开一个终端请求线上接口，即可看到实时请求日志与异常堆栈
```

---

## 5. 环境变量与密钥

全部在 `wrangler.toml` 的 `[vars]`，密码类走 secret（`npx wrangler secret put`）。

| 变量名 | 示例值 | 作用 |
| --- | --- | --- |
| `POSTS_URL` | `https://raw.githubusercontent.com/Kingku-Shawn/blog/main/api/public/posts.json` | 文章列表静态兜底源（D1 `posts` 为空时 seed / 回退读出） |
| `RAW_API_BASE` | `https://raw.githubusercontent.com/Kingku-Shawn/blog/main/api` | 静态 JSON 兜底目录（`tools/about/layout/public/*.json` 同名读取） |
| `RAW_ARTICLE_BASE` | `https://raw.githubusercontent.com/Kingku-Shawn/blog/main/article` | 文章 HTML 源，用于正文补抓与 `/api/ping` 的 `raw_article_status` 探测 |
| `RAW_ADMIN_BASE` | `https://raw.githubusercontent.com/Kingku-Shawn/blog/main/admin` | 管理员鉴权通过后拉取后台页面（Pages 上不部署 `admin/`） |
| `STATIC_ORIGIN` | `https://kingku-shawn.github.io/blog` | 静态反代目标（Pages 裸源，注意**带 `/blog` 子路径**） |
| `CUSTOM_HOST` | `blog.qingyi.dpdns.org` | 3xx 时把 `Location` 里的自定义域名改写回裸源，破 301 死循环 |
| `ADMIN_USER` | `kingkushawn` | 预设管理员用户名，注册时自动提权；公开无妨 |
| `ADMIN_PASS`（**secret**） | `npx wrangler secret put ADMIN_PASS` | 管理员密码，不落仓库；本地放 `.dev.vars`（已 gitignore） |
| `MAIL_WEBHOOK_URL`（🚧 **可选**） | 你的发信 Webhook 地址 | 邮件通道（密码重置 / 邮箱验证 / 订阅发信）。**未配置时**相关接口返回 `data.mailConfigured:false` 并提示「请联系站长」，并在订阅响应里返回退订 token；**配置后走真实投递**。用 `npx wrangler secret put MAIL_WEBHOOK_URL`（或 `[vars]`） |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`（🚧 **可选**） | GitHub OAuth App 的 id / secret | 第三方登录（骨架）所需。**未配置时 `/api/oauth/*` 返回 501「第三方登录暂不可用（骨架）」**；且该骨架**不校验 `state`、不自动建号**（需先用账号密码登录后在资料页绑定） |
| `DB`（**D1 binding**） | `t_blog_qingyi` / `add76dbc-1118-4ec8-9edd-e380b66cbbac` | D1 数据库绑定，变量名必须是 `DB`，代码里用 `env.DB` |

> 仓库里还有一个控制台建的 KV（表 `_cf_KV`），**当前未被任何代码使用**。

---

## 6. 本地开发与联调

```bash
# 1) 启动本地 Worker（拦截 /api/*、/article/a_*.html，使用本地 D1 模拟）
npx wrangler dev            # 等价于 npm run dev，默认 http://127.0.0.1:8787
# 需要本地管理员密码时，在项目根目录建 .dev.vars：
#   ADMIN_PASS=你的本地密码

# 2) 另起一个终端托管静态站（任选其一）
npx serve .                 # 需要 npm i -g serve；或用 Python
python -m http.server 8080  # 静态站根 = 当前目录（未重构）或 site/（重构后）
```

**常用脚本速查**（均在项目根目录执行）：

```bash
npm run dev         # = npx wrangler dev，本地 Worker（热重载）
npm run deploy      # = npx wrangler deploy，部署到线上
npm run db:migrate  # 手动建表 → migrations/0002_admin_full.sql（完整 14 张表）
npm run db:tables   # 查看线上 D1 表清单
# 注意：migrations/0001_init.sql 是历史遗留（只有 views/comments/votes），不要用它建表
```

**联调注意**

1. **同源问题**：Worker 在 `:8787`，静态站在 `:8080`，跨端口请求需要自己处理 CORS。最省事的做法是先访问 Worker 的地址（`http://127.0.0.1:8787/`），让 `proxyStatic` 去回源真实 Pages，这样动态接口与页面同源。
2. **不要指望本地替身**：`wrangler dev` 的本地 D1 是空的，首次 `/api/*` 会自动建表，`/api/dashboard` 会触发从 raw seed 文章。想复现线上数据，用 `npx wrangler d1 execute t_blog_qingyi --remote ...` 查询线上库，或 `--local` 导入导出。
3. **raw.githubusercontent.com 访问受限**：本机网络访问该域名可能失败（502/超时），这**仅是本地网络受限，Worker 侧正常**。所以本地看到 `raw_article_status` 非 200、或 seed 不出文章，不代表线上有问题；以线上 `/api/ping` 为准。
4. **改代码不会自动上线**：`worker/src/index.js` 每改一次都要 `npx wrangler deploy`。`wrangler dev` 是热重载的，本地验证完再部署。
5. **只改静态站也必须 push**：Pages 由 GitHub Actions 构建，本地改 `index.html`、`js/*.js` 后要提交推送才会生效。

---

## 7. 运维

### 7.1 备份

```bash
# 导出整库为 SQL（推荐每次大改前后各做一次）
npx wrangler d1 export t_blog_qingyi --remote --output=backup/d1-20261012.sql
# 只看表清单
npx wrangler d1 execute t_blog_qingyi --remote --command="SELECT name FROM sqlite_master WHERE type='table'"
# 看文章与脏正文计数
npx wrangler d1 execute t_blog_qingyi --remote --command="SELECT COUNT(*) FROM posts"
```

误删兜底：Cloudflare 控制台提供 D1 **Time Travel** 时间点恢复。

### 7.2 回滚

```bash
npx wrangler deployments list          # 找到上一个版本 id
npx wrangler rollback [deployment-id]  # 不带 id 则回滚到上一个版本
```

静态站回滚用 `git revert` / `git reset` 后重新 push，由 Actions 重新发布。

### 7.3 日志

```bash
npx wrangler tail blog-server          # 实时日志流
npx wrangler tail blog-server --status error   # 只看异常（视 wrangler 版本支持）
```

前台异常会被顶层 `catch` 包成 `{success:false, ok:false, msg:"服务器开小差了", error:"<堆栈前 600 字符>"}`（HTTP 500），看到这条就说明 `error` 字段里有根因。

### 7.4 缓存策略要点

| 位置 | 时长 | 说明 |
| --- | --- | --- |
| `/api/public/posts.json` 列表 | 3 秒 | Worker 内存短缓存，刚发的文章很快就可见 |
| 文章详情 HTML | 60 秒 | `cache-control: public, max-age=60` |
| `/api/*` 静态 JSON 兜底 | 120 秒 | `cf.cacheTtl: 120` + `max-age=120` |
| raw `posts.json` 进程缓存 | 5 分钟 | `fetchStaticPosts` 的 `_postsCache` |
| admin 页面 | HTML `no-store`；其它资源 3600 秒 | 保证后台界面永远最新 |

**改完文章/设置后如果线上没变**：先等 1 分钟（详情页）或 2 分钟（静态 JSON），再强制刷新（Ctrl+F5）。仍不变就用 `npx wrangler tail` 看请求是否命中 Worker。

---

## 8. FAQ

1. **`/admin` 返回 404，是我配错了吗？**
   不是，这是设计如此。`guardAdmin` 对未登录/非管理员/会话过期/角色不足一律返回**纯文本 404**，不暴露路径存在性，防探测与爆破。正确入口是先到 `/user/login.html` 登录（用户名须为角色 `admin` 或 `super_admin`），再访问 `/admin`。

2. **首页/顶栏里的工具页为什么不见了？**
   `api/tools.json` 里 6 个工具当前**全部 `enabled:false`**（临时下架）。D1 `settings.tools` 无记录时，接口回退 raw 原文且**不做过滤**，所以 `GET /api/tools.json` 仍返回 **6 条**、每条 `enabled:false`（**不会**返回空数组）；导航入口隐藏是 `js/header-fix.js` 按 `enabled` 过滤的结果。页面本身还在（`/piano/`、`/music/`、`/tiaoyin/`、`/metronome/` 等可直接访问）。恢复：后台「工具设置」把对应项的 `enabled` 改回 `true`，或直接改 `api/tools.json`。

3. **Worker 报 `xxx is not defined` 或语法错误，怎么排查？**
   `blog-server` 是**无构建的 ES Module**：文件里少一个花括号、引用未声明的变量，整个 Worker 会直接 500，而不是只坏一个接口。排查顺序：① 看 `/api/ping` 返回体里的 `error` 字段（顶层 catch 会带 600 字符堆栈）；② `npx wrangler tail blog-server` 看部署后的实时异常；③ 本地 `npx wrangler dev` 复现，控制台会直接指出行号；④ 修完必须 `npx wrangler deploy`。

4. **`/api/ping` 里 `d1:false`，还有 `hint` 说 D1 未绑定。**
   说明 `env.DB` 是空的。到 **Cloudflare 控制台 → Workers & Pages → `blog-server` → Settings → Bindings** 添加 D1 绑定，**变量名必须是 `DB`**、库选 `t_blog_qingyi`；或确认 `wrangler.toml` 的 `[[d1_databases]] binding = "DB"` 后用 `npx wrangler deploy` 重新部署。

5. **`/api/ping` 里 `raw_article_status` 不是 200？**
   大概率是 `RAW_ARTICLE_BASE` 路径不对。若跑过 `scripts/restructure.mjs`，必须把 `POSTS_URL`/`RAW_API_BASE`/`RAW_ARTICLE_BASE` 从 `/main/api`、`/main/article` 改成 `/main/site/api`、`/main/site/article` 并重新部署。另外**本地网络访问 raw.githubusercontent.com 受限**也会看到非 200，那只是本地受限，Worker 侧正常。

6. **首页白屏/报「静态源未配置（STATIC_ORIGIN）」。**
   `STATIC_ORIGIN` 为空。它必须是 Pages **裸源且带子路径**：`https://kingku-shawn.github.io/blog`（不能写自定义域名，否则 301 死循环；也不能漏 `/blog`）。

7. **文章详情页 404 / 打开了旧样式页面。**
   两种情况：① 该 `source_file` 不在 D1 `posts` 表 → `/article/a_*.html` 会 `passthroughArticle` 反代回 Pages，展示旧静态详情页（专栏面板与专栏内上下篇**不会生效**，这是预期降级）；② D1 有记录但正文是占位符 → 等 `/api/dashboard` 触发的 `backfillPostContent`（每次 ≤10 篇）补抓，或后台重新保存该文。用 `SELECT source_file,content FROM posts WHERE source_file='a_xxx.html'` 核对。

8. **评论区不显示。**
   ① `js/header-fix.js` 会把旧 Vue `.xw-pinlun2` 换成轻量评论区，确认该脚本被加载且没被浏览器缓存住旧版本；② 接口 `/api/pinlun/list` 需返回旧契约 `{success,data,msg}`，用 `curl` 直接测；③ D1 没建表或没绑定（看 `/api/ping` 的 `d1`/`tables`）；④ 没有 `comments` 表时 `ensureSchema` 会自动补建，若失败看 `schema_err`。

9. **访问自定义域名 301 循环（ERR_TOO_MANY_REDIRECTS）。**
   根因是「回源的域名本身也指向自己」。`proxyStatic` 已用 `redirect:"manual"` + 把 3xx `Location` 里的 `CUSTOM_HOST` 改写回 `STATIC_ORIGIN`（最多 3 跳，超出返回 508）。若仍循环：确认 `CUSTOM_HOST` 与 `STATIC_ORIGIN` 填反了没有，以及该路径是否根本没命中 Worker（命中才走这套改写逻辑）。

10. **改了文章/设置，线上还是旧的。**
    分层缓存：列表 3 秒、详情 60 秒、静态 JSON 120 秒、raw 进程缓存 5 分钟。先等到分钟级过期再强制刷新。若 5 分钟还没变，用 `npx wrangler tail` 确认请求到了 Worker 且返回 200，而不是被 Cloudflare 边缘缓存或浏览器缓存接走。

11. **运行 `scripts/restructure.mjs` 后全站 404。**
    最常见是漏改 `wrangler.toml` 的三个 raw 变量（见 §2.3 表格），导致 `/api/public/posts.json` 等兜底全挂；其次是没重新 `npx wrangler deploy`。另外确认 `deploy.yml` 用的是 `site/` 分支（它自动判断，无需改）。

12. **后台能登录但进去很多操作「权限不足」。**
    当前账号角色是 `user`。文章/分类/标签/分栏的写操作要求 `admin` 或 `super_admin`（代码里 `isAdmin` 校验）。用 `super_admin` 账号在后台「用户管理」里提升角色。

13. **推了代码但线上 Worker 行为没变。**
    Worker 与 Pages 是两条独立的部署链路：改 `worker/src/index.js` 必须 `npx wrangler deploy`；改静态站必须 `git push` 并由 Actions 发布。只做其中一件事，另一侧不会更新。

14. **所有文章阅读量都是 0。**
    已知缺口，原因：详情页改由 Worker 内置模板动态渲染后，**模板里没有调用 `POST /api/view`**，而旧静态页依赖的 `js/article-detail-enhance.js` 已不再被加载。**修复代码已就绪但尚未部署**（模板内已加 `sessionStorage` 幂等打点，键 `blog_viewed_<source_file>`）。执行 `npx wrangler deploy` 后恢复；由于是幂等打点，同一浏览器会话内同一文章只计一次，反复刷新不会虚增。

15. **登录后进 `/admin` 还是 404。**
    按顺序查：① 该账号角色是否为 `admin`/`super_admin`（普通 `user` 会被前端重定向到首页，且 Worker 也会返回 404）；② `localStorage` 里是否有 `shawn_admin_token`（登录页仅对管理员写这个 key）；③ `sessions` 表里该 token 是否已过期（`expire_at`）；④ 后台请求是否带了 `X-Token` 头。临时排查可在浏览器控制台看 `localStorage.getItem("shawn_admin_token")`。

---

## 9. 文档索引

同目录中文文档（README 之外共 **11** 份，合计 12 份）。**改代码时该同步改哪些文档，看《文档索引》§3 的维护约定表。**

| 文档 | 一句话定位 |
| --- | --- |
| [文档索引](./文档索引.md) | 全部文档的入口、推荐阅读顺序、维护约定与 ✅/🚧/⏳/⏸ 状态标记规范 —— **改代码时该同步改哪些文档看这里** |
| [需求文档](./需求文档.md) | 需求基线：FR/NFR 编号、决策记录、追踪矩阵、验收清单 |
| [前后端接口指南](./前后端接口指南.md) | 接口手册：每个接口的方法/参数/请求体/响应示例/鉴权/缓存 |
| [数据库设计文档](./数据库设计文档.md) | 表结构、字段、索引、ER 关系、数据流、迁移与扩展 |
| [数据库说明书](./数据库说明书.md) | D1 运维手册：绑定、建表、常用 SQL、备份恢复、排错 |
| [功能扩展与H5同步设计](./功能扩展与H5同步设计.md) | 功能扩展规划 + 现状（SEO/订阅/PWA/评论增强/统计/安全…） |
| [移动端App设计与接口规划](./移动端App设计与接口规划.md) | 安卓/鸿蒙 App 设计与接口规划（App 未开工） |
| [离线使用说明](./离线使用说明.md) | 离线镜像（`admin/server.py` + SQLite）使用说明与线上差异 |
| [宝塔部署指南](./宝塔部署指南.md) | 宝塔面板部署离线动态后台 |
| [变更日志](./变更日志.md) | 按日期倒序的变更记录 + 已知问题/待办 |
| [追加补充.md](./追加补充.md) | 增量补充包：FR-X/NFR-X/D-X 需求、API-X 接口、TABLE-X 扩展表、运维 SQL 与监控 —— **全部 ⏳ 规划中，尚未实现，勿当已实现接口用** |

> 另有 `scripts/restructure.mjs`（目录重构脚本，幂等）与 `backup/`（历史整站备份）不属于文档，见上文「目录结构」。

### 9.1 状态标记规范

本文档与其它文档统一使用四种标记，不混用其它写法（与《文档索引》§3.1 一致）：

| 标记 | 含义 |
| --- | --- |
| ✅ 已实现 | 代码已完成**且线上已生效**（`npx wrangler deploy` / `git push` 已执行） |
| 🚧 代码就绪，待部署 | 代码已改好，但线上仍是旧版本；部署命令见 §4 |
| ⏳ 规划中 | 仅设计，未写代码 |
| ⏸ 暂停/临时下架 | 功能保留但入口/开关关闭（例如 6 个在线工具当前 `enabled:false`） |

---

## 10. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-12 | **文档（补充包第二批落地回填，🚧 代码就绪待部署）**：① **§2.1 当前目录结构**补 `worker/src/extend-schema.js` 与 `worker/src/features/{seo,search,likes,moderation,security,auth-ext,stats,notify,users-ext,content}.js`、新增静态页 `search/`、`privacy/`、`terms/`、`user/{forgot,reset,verify}.html`、站点级文件 `robots.txt`/`404.html`、`migrations/0003_extend.sql`，并给 `admin/index.html` 注明已含「评论审核」界面；② **§3.1 前台**新增 8 行 🚧 条目（SEO/分发 head 元信息、订阅源与爬虫文件、搜索页 + 顶栏搜索入口、点赞/收藏、评论先审后发与举报、密码重置/邮箱验证页、合规页）；③ **§3.2 后台**由「11 组」扩为「原 11 组 + 🚧 新增 3 组」（评论审核、限流与审计、订阅/通知/Webhook）；④ **§3.3 动态能力**新增 6 行 🚧（全文搜索 FTS5 `trigram`/`unicode61` 二选一 + `LIKE` 兜底与索引自愈边界、点赞/收藏、评论审核与风控、限流与审计、访问统计、密码重置骨架、订阅与通知）；⑤ **§3.4** 由「补充包规划（⏳ 未实现）」改写为「补充包落地状态（部分已落地 🚧 / 其余 ⏳）」，逐方向标注实际状态与实现文件；⑥ **§4.2** 补「扩展表会在首个 `/api/*` 请求自动创建（84 条语句，首次略慢，`tables` 16→43）」；⑦ **§4.5 验证**新增第 7–9 条 curl 自检（SEO/Feed、搜索 `engine`、`X-Request-Id` 与安全头）与静态侧可达性检查；⑧ **§5 环境变量**补可选 `MAIL_WEBHOOK_URL`；⑨ **口径修正**：补充包标注「未实现」的若干项**骨架其实已接线**（`features/content.js` 的 `/api/admin/revisions`、`/api/admin/redirects`、`/api/admin/export`、`/api/admin/import`、`POST /api/posts/schedule`；`features/users-ext.js` 的 `/api/my/profile`、`/api/my/sessions`、`/api/my/2fa`、`/api/oauth/*`、`/api/admin/users-ext`），已在 §3.4 单列「骨架已接线（⚠ 勿当已完成）」行并写明边界；⑩ **本文档§10** 即本行。**部署方式**：Worker 侧 🚧 需 `npx wrangler deploy`，静态页/JS 侧 🚧 需 `git push` |
| 2026-10-12 | **代码（🚧 代码就绪待部署）**：① 扩展表结构落地 —— 新增 `worker/src/extend-schema.js`（`EXTEND_STATEMENTS`，84 条独立语句 = 27 `CREATE TABLE` + 33 `ALTER TABLE` + 24 `CREATE INDEX`）与逐条等价的 `migrations/0003_extend.sql`，`worker/src/index.js` 的 `ensureSchema` 重构为「基础结构（16 条 DDL，`posts` 存在则走快速路径）→ 扩展结构（独立 marker `article_likes`，**不复用 `posts` 快速路径**，逐条吞错、失败下次请求自动重试）」。**部署后 `/api/ping` 的 `tables` 由 16 项变 43 项（16 + 27）**。<br>② 站点级文件 —— 新增根目录 `robots.txt`（静态兜底）与 `404.html`（站点风格自定义 404，含 `/js/header-fix.js`）；`.github/workflows/deploy.yml` 组装 `_site` 时额外从仓库根复制 `robots.txt`/`404.html`/`sitemap.xml`（存在才复制）。<br>**文档**：§3.3 功能清单与 §4.1 部署步骤同步补记；详见 [变更日志](./变更日志.md)。 |
| 2026-10-12 | **文档**：README 补写完整，与当前代码对齐（真实目录结构、两态专栏、统一入口架构、11 组后台、登录 token 存储、部署与排障）；新增 [文档索引](./文档索引.md)（文档入口、阅读顺序、维护约定、✅/🚧/⏳/⏸ 状态标记规范）与 [变更日志](./变更日志.md)。<br>**代码（🚧 已就绪，待 `npx wrangler deploy`）**：A. 文章详情右侧专栏面板两态（无 `?col=` 只列专栏名+篇数；带 `?col=` 服务端直出展示态）；B. 上下篇用 `post_columns` 子查询限定专栏内，详情页点击专栏原地切换并同步地址栏，栏内互跳保留 `?col=`，「上一篇/下一篇」卡片居左；C. 新增 `GET /api/columns/<专栏名>/articles?cur=<source_file>`，前端带 `/api/public/posts.json` 筛选兜底；D. 首页/列表页选中专栏后进详情自带 `?col=`；E. 内置模板补上 `POST /api/view` 幂等打点（`sessionStorage` 键 `blog_viewed_<source_file>`），修复动态渲染后阅读量恒为 0。<br>**工程**：`package.json` 的 `db:migrate` 改指完整版 `migrations/0002_admin_full.sql`，并新增 `db:tables` 查表脚本。 |
| 2026-10-12 | **勘误（跨文档一致性审计）**：① `article/index.html` 关键词搜索改为**前端全量过滤**（原先拼 `&search=` 请求 `/api/public/posts.json` 会 404，已修；🚧 待 `git push`）；② `worker/src/index.js` 建表 DDL 注释「17 条」修正为「16 条」（14 张 `CREATE TABLE` + 2 个 `CREATE INDEX`）；③ §3.2 后台接口鉴权更正为**只认 `X-Token` 请求头**，Cookie `session` 只对 `/admin*` 页面（`guardAdmin`）有效；④ §3.3 缓存策略由悬空的「§8.4」改指本文档 §7.4 缓存策略要点；⑤ §1.2 Worker 代码行数 2340 → 2352；⑥ 状态标记统一为**四种**（补齐 `⏸ 暂停/临时下架`，与《文档索引》§3.1 一致）；⑦ §2.1 目录树补 `#` 前缺失的空格，并标注 `article/` 静态详情页 56 个；⑧ §3.2 补上传白名单 16 项与权限分层（`/api/users*` 仅 `super_admin`、`POST /api/settings` 只需登录、`POST /api/upload` 需 `admin`）。 |
| 2026-10-10 | 文档体系升到 v2.0：需求文档、前后端接口指南、数据库设计文档、数据库说明书四份基础文档对齐「文章真源迁 D1」；新增功能扩展与 H5 同步设计、移动端 App 设计与接口规划。 |
| 2026-10-10 | 管理后台整体云化：接口全部由 Worker 提供（X-Token），admin 静态页不部署 Pages、鉴权通过后从 raw 取回；非管理员访问 `/admin*` 返回纯文本 404。 |
| 2026-10-09 | 全站统一顶栏（`js/header-fix.js`）：登录/注册双按钮、工具导航按 `enabled` 过滤、旧 Vue 评论组件替换为轻量评论区、隐藏旧页脚、移动端汉堡菜单、DOM 变化兜底重跑；页面装修引擎 `js/layout-engine.js` 上线。 |
| 2026-10-09 | Worker 升级为统一入口：`/api` 与 `/api-v1` 走 D1、`/article/a_*.html` 从 D1 直出、其余静态反代回源 Pages（`redirect:"manual"` 破 301 死循环）；首次 `/api/*` 自动建表 `ensureSchema`；新增 `/api/ping` 诊断。 |
| 2026-10-08 | 目录重构脚本 `scripts/restructure.mjs`；GitHub Actions 部署流水线（组装 `_site`、排除 admin、复制 `CNAME`）。 |
| 2026-10-08 | 上线初版：Worker（阅读量 `/api/view` + 评论 `/api/pinlun/*`）+ D1（`views`/`comments`/`votes`），静态站托管 GitHub Pages，Cloudflare 代理 `blog.qingyi.dpdns.org`。 |
