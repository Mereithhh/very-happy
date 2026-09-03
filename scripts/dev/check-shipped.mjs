#!/usr/bin/env node
/**
 * check-shipped —— 证明「这次改动真的在线上」，而不是「workflow 绿了」。
 *
 * AGENTS 要求发布后验证本次改动的关键真实路径，做法是去线上资产里 grep 一段
 * 只有新代码才有的字符串（一条 CSS 规则、一个存储 key、一个事件名）。手搓这段
 * curl 已经连着三次出错，每次的错法都会让人得出**相反**的结论：
 *
 *  ① **只扫 entry 引用的 chunk 不够**。路由级 chunk 往往挂在第二层（今天要找的
 *     `SessionDetailScreen` 是 `AppRoot` 引的，不是 entry 引的），一层扫描找不到，
 *     看起来就像改动没上去。本脚本做**传递闭包**。
 *  ② **拼出来的文件名拿到 200 也可能是假的**：不存在的 /assets/... 会被 SPA
 *     回退成 index.html，HTTP 200 + 一份 HTML，grep 自然是 0。所以本地 dist 里的
 *     chunk 名**不能照抄到线上**（`__APP_VERSION__` 参与内容哈希，CI 和本地不同名），
 *     而且任何看起来像 HTML 的响应都必须当作「这个资产不存在」报出来，不能计入未命中。
 *  ③ SHA 必须**从线上 entry 读**，不是填你部署的那个——别的会话在你上面发一版，
 *     写死的 SHA 就再也匹配不到。不匹配时先查祖先关系
 *     （`git merge-base --is-ancestor <yours> <live>`）再下结论。
 *
 * 用法：
 *   node scripts/dev/check-shipped.mjs --needle 'unread-sessions-v1'
 *   node scripts/dev/check-shipped.mjs --needle '.tg-subagent-open' --needle 'vh:subagent-open'
 *   node scripts/dev/check-shipped.mjs --origin https://veryhappy.dev --needle X --json
 *
 * 每个 needle 都命中才 exit 0；任何一个没命中即非 0。
 */

const args = process.argv.slice(2);
const needles = [];
let origin = 'https://veryhappy.dev';
let asJson = false;
for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--needle') needles.push(args[++i]);
    else if (args[i] === '--origin') origin = args[++i].replace(/\/$/, '');
    else if (args[i] === '--json') asJson = true;
    else if (args[i] === '--help' || args[i] === '-h') { help(); process.exit(0); }
    else { console.error(`unknown argument: ${args[i]}`); help(); process.exit(2); }
}
if (needles.length === 0) { console.error('at least one --needle is required'); help(); process.exit(2); }

function help() {
    console.error(`usage: check-shipped.mjs --needle <string> [--needle <string>…] [--origin <url>] [--json]`);
}

const HTML_START = /^\s*(<!doctype html|<html\b)/i;

async function get(url) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return { ok: false, status: res.status, body: '' };
    const body = await res.text();
    // The SPA serves index.html for any unknown /assets path, so a 200 alone
    // does not mean the asset exists (trap ② in the header).
    if (HTML_START.test(body)) return { ok: false, status: res.status, body, html: true };
    return { ok: true, status: res.status, body };
}

const indexRes = await fetch(origin + '/', { redirect: 'follow' });
if (!indexRes.ok) { console.error(`GET ${origin}/ -> ${indexRes.status}`); process.exit(1); }
const indexHtml = await indexRes.text();

const entry = (indexHtml.match(/assets\/index-[A-Za-z0-9_-]+-[0-9a-f]{40}\.js/) ?? [])[0];
if (!entry) { console.error('could not find a salted entry asset in the served index.html'); process.exit(1); }
const sha = entry.match(/[0-9a-f]{40}/)[0];

// Seed with the entry plus every stylesheet the document links: CSS is not
// referenced from JS in this build, so a CSS-only change lives nowhere else.
const seen = new Set();
const queue = [entry, ...new Set(Array.from(indexHtml.matchAll(/assets\/[A-Za-z0-9_-]+-[0-9a-f]{40}\.css/g), (m) => m[0]))];
const hits = new Map(needles.map((n) => [n, []]));
const phantom = [];
let fetched = 0;

while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const res = await get(`${origin}/${name}`);
    if (!res.ok) { phantom.push({ name, status: res.status, html: res.html === true }); continue; }
    fetched += 1;
    for (const needle of needles) if (res.body.includes(needle)) hits.get(needle).push(name);
    // Transitive walk (trap ①): a route chunk is usually referenced by another
    // chunk, not by the entry.
    if (name.endsWith('.js')) {
        for (const m of res.body.matchAll(/assets\/[A-Za-z0-9_-]+-[0-9a-f]{40}\.(?:js|css)/g)) {
            if (!seen.has(m[0])) queue.push(m[0]);
        }
    }
}

const missing = needles.filter((n) => hits.get(n).length === 0);
if (asJson) {
    console.log(JSON.stringify({
        origin, sha, entry, assetsFetched: fetched,
        hits: Object.fromEntries(hits), phantom, missing,
    }, null, 2));
} else {
    console.log(`live release: ${sha}`);
    console.log(`entry:        ${entry}`);
    console.log(`assets read:  ${fetched}`);
    for (const needle of needles) {
        const where = hits.get(needle);
        console.log(where.length > 0
            ? `  ok        ${JSON.stringify(needle)} in ${where.join(', ')}`
            : `  MISSING   ${JSON.stringify(needle)}`);
    }
    // A phantom is a referenced asset that came back as HTML or an error. It is
    // never a normal state; report it rather than silently counting a miss.
    for (const p of phantom) {
        console.log(`  !! ${p.name} -> ${p.html ? 'HTML fallback (asset does not exist)' : `HTTP ${p.status}`}`);
    }
    if (missing.length > 0) {
        console.log('');
        console.log('If the live SHA is not the one you deployed, another session shipped on top:');
        console.log(`  git merge-base --is-ancestor <your-sha> ${sha} && echo "yours is in"`);
    }
}
process.exit(missing.length > 0 ? 1 : 0);
