// 清逸的博客 · 目录重构脚本
// 目标结构：
//   site/      —— 所有静态站点文件（GitHub Pages 部署源，deploy.yml 从 site/ 组装）
//   worker/    —— Cloudflare Worker 代码
//   migrations/—— D1 建表 SQL
//   scripts/   —— 本脚本
//   admin/     —— 本地管理后台（含 data/admin.db 账号库），不进 site/，不部署
//   wrangler.toml / package.json / .github/ / CNAME 等保持根目录
//
// 运行方式（在项目根目录）：
//   node scripts/restructure.mjs
// 脚本幂等：重复运行不会二次移动；不会触碰 backup/ 里的冗余整站备份。
//
// 被移入 site/ 的条目（公开静态资源）：
//   aboutme article guitar-chords js kalimba metronome music o piano tiaoyin
//   uploads user cdn.jsdelivr.net api
//   index.html favicon.ico soulsoft-tools.css
// 保留在根目录（不移动、不部署）：
//   admin/ 离线使用说明.md 宝塔部署指南.md
//   site/ worker/ migrations/ scripts/ .github/ .gitignore package.json
//   wrangler.toml CNAME README.md backup/

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const MOVE_INTO_SITE = [
  "aboutme", "article", "guitar-chords", "js", "kalimba", "metronome",
  "music", "o", "piano", "tiaoyin", "uploads", "user",
  "cdn.jsdelivr.net", "api",
  "index.html", "favicon.ico", "soulsoft-tools.css",
];

const KEEP_AT_ROOT = new Set([
  "site", "worker", "migrations", "scripts", ".github", ".git", ".gitignore",
  "package.json", "wrangler.toml", "CNAME", "README.md", "backup",
  "admin", "离线使用说明.md", "宝塔部署指南.md",
  "node_modules", ".wrangler", ".dev.vars", ".DS_Store", "Thumbs.db",
]);

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function main() {
  const siteDir = path.join(ROOT, "site");
  await fs.mkdir(siteDir, { recursive: true });

  const entries = await fs.readdir(ROOT);
  let moved = 0, skipped = 0, unknown = 0;

  for (const name of entries) {
    const src = path.join(ROOT, name);
    const dst = path.join(siteDir, name);

    if (KEEP_AT_ROOT.has(name)) continue;

    // 明确要移入 site/ 的条目
    if (MOVE_INTO_SITE.includes(name)) {
      if (await exists(dst)) {
        console.log(`[skip] 目标已存在，跳过：${name}`);
        skipped++;
        continue;
      }
      await fs.rename(src, dst);
      console.log(`[move] ${name}  ->  site/${name}`);
      moved++;
      continue;
    }

    // 未识别条目：打印提示，不擅自移动
    console.log(`[warn] 未识别条目，保留在根目录：${name}`);
    unknown++;
  }

  console.log(`\n完成：移动 ${moved} 项，跳过 ${skipped} 项，保留 ${unknown} 项未知条目。`);
  console.log("后续请手动确认根目录只保留：site/ worker/ migrations/ scripts/ admin/ .github/ .gitignore package.json wrangler.toml CNAME README.md backup/ 以及 离线使用说明.md、宝塔部署指南.md");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
