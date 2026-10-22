#!/usr/bin/env node
/**
 * nesting-audit —— B-614 / docs/design-language.md §2.1 的 1-Border Rule 检查：
 * 从画布向内任何一条视线上，最多一道「闭合」轮廓。
 *
 * 闭合轮廓 = 4 边都可见的 border、非 none 的 outline，或 0 偏移 0 模糊、
 * spread > 0 的 box-shadow 环（inset 或外环都算）。违规 = 一个闭合元素的祖先
 * （在被审区域内）也闭合，比如卡片里套卡片、带框代码块里套带框按钮。
 *
 * 用法：先起 dev server（`pnpm -C packages/happy-web-v2 dev`），再
 *
 *   node scripts/dev/nesting-audit.mjs [--base http://localhost:8082] [--json out.json]
 *
 * 默认审 dev harness 页（`/dev/depth/session/:id`、`/dev/multi-agent/:id`、
 * `/dev/sidebar`、`/dev/multi-agent-teams`、B-754 `/dev/tool-cards/:id`）的对话、输入区、侧栏、右侧面板与团队页，
 * 明暗两套主题各跑一遍。退出码：0 无违规；1 有违规；2 环境问题。
 * 焦点环只在聚焦时出现，审计时鼠标移出、不聚焦任何控件。伪元素不在审计范围内。
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const base = opt('--base', 'http://localhost:8082');
const jsonOut = opt('--json', null);

function findChromium() {
    for (const dir of [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]) {
        if (!existsSync(dir)) continue;
        for (const entry of readdirSync(dir).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
            for (const rel of ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome']) {
                const exe = join(dir, entry, rel);
                if (existsSync(exe)) return exe;
            }
        }
    }
    return null;
}

const PAGES = [
    { name: 'session', path: '/dev/depth/session/dev-depth', expand: '.ta-head', openTools: true, regions: { transcript: '.cl-inner', composer: '.sd-foot' } },
    { name: 'multiagent', path: '/dev/multi-agent/dev-multi-agent?drawer=sa-done', regions: { transcript: '.cl-inner', composer: '.sd-foot', sidepanel: '.sd-files' } },
    { name: 'codexpanel', path: '/dev/multi-agent/dev-multi-agent?drawer=codex-spawn', regions: { sidepanel: '.sd-files' } },
    { name: 'board', path: '/dev/board/session/dev-board?panel=board', regions: { transcript: '.cl-inner', sidepanel: '.sd-files' } },
    { name: 'sidebar', path: '/dev/sidebar', regions: { sidebar: '.sb' } },
    { name: 'teams', path: '/dev/multi-agent-teams', regions: { teams: '.teams-screen' } },
    // B-754: every runner's tool card, expanded.
    { name: 'toolcards', path: '/dev/tool-cards/dev-tools', openTools: true, regions: { transcript: '.cl-inner' } },
];

/** Runs in the page. */
function audit(regions) {
    const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width >= 4 && r.height >= 4 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05; };
    const alpha = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return c === 'transparent' ? 0 : 1; const p = m[1].split(/[ ,/]+/).filter(Boolean); return p.length >= 4 ? Number(p[3]) : 1; };
    const ring = (bs) => {
        if (!bs || bs === 'none') return false;
        return bs.split(/,(?![^(]*\))/).some((p) => {
            const color = (p.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/i) || ['rgb(0,0,0)'])[0];
            const nums = (p.replace(/rgba?\([^)]*\)/g, '').match(/-?[\d.]+px|\b0\b/g) || []).map((n) => parseFloat(n));
            const [x = 0, y = 0, blur = 0, spread = 0] = nums;
            return Math.abs(x) < 0.01 && Math.abs(y) < 0.01 && blur < 0.01 && spread > 0 && alpha(color) > 0.02;
        });
    };
    const closed = (el) => {
        const cs = getComputedStyle(el);
        if (['Top', 'Right', 'Bottom', 'Left'].every((s) => parseFloat(cs[`border${s}Width`]) > 0 && !['none', 'hidden'].includes(cs[`border${s}Style`]) && alpha(cs[`border${s}Color`]) > 0.02)) return 'border';
        if (ring(cs.boxShadow)) return 'ring';
        if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && alpha(cs.outlineColor) > 0.02) return 'outline';
        return null;
    };
    const label = (el) => `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''}`;
    const out = {};
    for (const [name, sel] of Object.entries(regions)) {
        const root = document.querySelector(sel);
        if (!root) { out[name] = { missing: true }; continue; }
        let count = 0; const violations = [];
        for (const el of [root, ...root.querySelectorAll('*')]) {
            if (el instanceof SVGElement || !visible(el)) continue;
            const kind = closed(el); if (!kind) continue; count++;
            for (let a = el.parentElement; a && a !== root.parentElement; a = a.parentElement) {
                if (visible(a) && closed(a)) { violations.push(`${label(el)} [${kind}] inside ${label(a)} [${closed(a)}]`); break; }
            }
        }
        out[name] = { closed: count, violations: violations.length, samples: [...new Set(violations)].slice(0, 12) };
    }
    return out;
}

const exe = findChromium();
if (!exe) { console.error('nesting-audit: no Chromium in the playwright cache (pnpm dlx playwright-core@1.55.0 install chromium)'); process.exit(2); }
let chromium;
try { ({ chromium } = await import('playwright-core')); } catch { console.error('nesting-audit: playwright-core is not installed'); process.exit(2); }

const browser = await chromium.launch({ executablePath: exe });
const report = {};
let total = 0;
try {
    for (const theme of ['light', 'dark']) for (const page of PAGES) {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: theme });
        await ctx.addInitScript((t) => { try { localStorage.setItem('vh-theme-preference', t); localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch {} }, theme);
        const p = await ctx.newPage();
        await p.goto(base + page.path, { waitUntil: 'networkidle' }).catch(() => {});
        await p.waitForTimeout(1200);
        // A loaded machine can take longer than the fixed pause to mount lazy harness chunks.
        await p.waitForSelector(Object.values(page.regions)[0], { timeout: 20000 }).catch(() => {});
        if (page.expand) { const h = await p.$(page.expand); if (h && (await h.getAttribute('aria-expanded')) === 'false') { await h.click(); await p.waitForTimeout(300); } }
        // open every collapsed tool row so each output kind (file, search, diff, command) is audited
        if (page.openTools) for (const h of await p.$$('.cl-inner .tg-row-head[aria-expanded="false"]')) { await h.click().catch(() => {}); await p.waitForTimeout(80); }
        await p.mouse.move(1, 1);
        const res = await p.evaluate(audit, page.regions);
        report[`${page.name}-${theme}`] = res;
        for (const [region, r] of Object.entries(res)) {
            if (r.missing) { console.log(`${page.name}-${theme} ${region}: MISSING`); continue; }
            total += r.violations;
            console.log(`${`${page.name}-${theme}`.padEnd(18)} ${region.padEnd(11)} closed=${String(r.closed).padStart(3)} violations=${r.violations}`);
            for (const s of r.samples) console.log(`    ${s}`);
        }
        await ctx.close();
    }
} finally { await browser.close(); }
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
console.log(`nesting-audit: ${total} violation(s)`);
process.exit(total > 0 ? 1 : 0);
