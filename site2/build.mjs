import { mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const version = "2.117.3";
const sdkUrls = [
  `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${version}/dist/umd/supabase.min.js`,
  `https://unpkg.com/@supabase/supabase-js@${version}/dist/umd/supabase.min.js`,
];
const root = resolve(".");
const dist = resolve("dist");
const vendor = resolve(dist, "vendor");

async function loadSdk() {
  // 可选：离线构建时指定本地 SDK 文件（SUPABASE_SDK_FILE=/path/supabase.min.js）。
  if (process.env.SUPABASE_SDK_FILE) return readFile(process.env.SUPABASE_SDK_FILE);
  let lastErr;
  for (const url of sdkUrls) {
    for (let i = 1; i <= 3; i++) {
      try {
        const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      } catch (e) {
        lastErr = e;
        console.warn(`Supabase SDK download ${new URL(url).host} attempt ${i}/3 failed: ${e.message}`);
        await new Promise((r) => setTimeout(r, 1000 * i));
      }
    }
  }
  throw new Error(`Failed to fetch Supabase SDK: ${lastErr?.message}`);
}

function replaceOnce(text, pattern, replacement, label) {
  if (!pattern.test(text)) throw new Error(`Build check failed: ${label} not found in index.html`);
  return text.replace(pattern, replacement);
}

const sha256 = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

const template = await readFile(resolve(root, "index.html"), "utf8");
const sdk = await loadSdk();
if (sdk.length < 20000 || !/supabase/i.test(sdk.toString("utf8", 0, 4000) + sdk.toString("utf8", sdk.length - 4000))) {
  throw new Error("Downloaded Supabase SDK looks invalid (too small or wrong content)");
}
const integrity = `sha384-${createHash("sha384").update(sdk).digest("base64")}`;
// 文件名带内容哈希：SDK 变了 URL 就变，可以放心长期缓存，也不会出现"新页面 + 旧脚本"的错配
const sdkFile = `supabase.${createHash("sha384").update(sdk).digest("hex").slice(0, 12)}.js`;
await rm(dist, { recursive: true, force: true });
await mkdir(vendor, { recursive: true });
await writeFile(resolve(vendor, sdkFile), sdk);

// 1) 外部 SDK：CDN → 同源 vendor 文件（带 SRI），并从 CSP 去掉 jsdelivr
let html = replaceOnce(
  template,
  /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2\.117\.3\/dist\/umd\/supabase\.min\.js" crossorigin="anonymous"><\/script>/,
  `<script src="./vendor/${sdkFile}" integrity="${integrity}" crossorigin="anonymous"></script>`,
  "Supabase CDN script tag"
);
html = replaceOnce(html, /script-src 'self' https:\/\/cdn\.jsdelivr\.net ([^;]+);/, "script-src 'self' $1;", "CSP script-src");

// 2) 页面里有【多段】内联脚本（Canvas 背景 + 主应用）：逐段计算哈希，全部写进 CSP
const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (inlineScripts.length === 0) throw new Error("Inline application script not found");
const hashes = inlineScripts.map(sha256);
html = replaceOnce(
  html,
  /script-src ([^;]+);/,
  (_, srcs) => `script-src ${srcs.replace(/\s*'sha256-[^']+'/g, "").trim()} ${hashes.join(" ")};`,
  "CSP script-src"
);

// 3) 自检：每段内联脚本的哈希都必须在 CSP 里，且不再引用 jsdelivr
const csp = html.match(/script-src ([^;]+);/)[1];
for (const h of hashes) if (!csp.includes(h)) throw new Error(`Build check failed: ${h} missing from CSP`);
if (/cdn\.jsdelivr\.net/.test(html)) throw new Error("Build check failed: jsdelivr reference still present in dist/index.html");

await writeFile(resolve(dist, "index.html"), html);
await copyFile(resolve(root, "_headers"), resolve(dist, "_headers"));
console.log(`Supabase SDK ${version} vendored as vendor/${sdkFile} with ${integrity}`);
console.log(`Inline scripts: ${inlineScripts.length}`);
hashes.forEach((h, i) => console.log(`  #${i + 1} CSP hash: ${h}`));
