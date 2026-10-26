#!/usr/bin/env node
/**
 * B-828: the desktop sidebar's 能力 rows (项目 / 团队 / 自动化 / 待办 / 联系人 vs
 * 「更多能力 ▾」) must not flip back and forth after the window was narrow for a
 * moment — Xu CHEN 10-26: Mac lid closed, back at the desk, the sidebar
 * flickered until 设置 and back. Runs against the vite dev server's
 * `/dev/sidebar` harness (real <Sidebar/>, seeded stores, no login, no server).
 * Not part of CI — run by hand:
 *
 *   pnpm -C packages/happy-web-v2 exec vite --port 8799 --strictPort
 *   node packages/happy-web-v2/e2e/sidebar-caps-flicker.mjs --base http://127.0.0.1:8799 [--scene atlas]
 *
 * Metric: childList mutations of `.sb-caps` per second (one per flip). Steps:
 *   A. fresh mount, heights 600–1000: no flips.
 *   B. page frozen (CDP Page.setWebLifecycleState) while the window shrinks to
 *      700px wide (desktop → phone layout, the sidebar stays mounted — B-795),
 *      then active again at 1440px: no flips, and the same rows as a fresh
 *      mount at each height. Before the fix: ~60 flips/s (every frame).
 * Exit code 1 on any failed check.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const BASE = opt('base', 'http://127.0.0.1:8799');
const SCENE = opt('scene', 'atlas');
const HEIGHTS = [600, 700, 780, 820, 860, 900, 940, 1000];

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
    return undefined;
}

let failures = 0;
function check(ok, what, detail = '') {
    console.log(`${ok ? '  ✓' : '  ✗'} ${what}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: findChromium() });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
const cdp = await context.newCDPSession(page);

/** Flips of the 能力 block over `ms`, plus the rows it ends on. */
async function sample(ms = 1000) {
    await page.evaluate(() => {
        window.__capsMo?.disconnect();
        window.__capsFlips = 0;
        window.__capsMo = new MutationObserver(() => { window.__capsFlips += 1; });
        window.__capsMo.observe(document.querySelector('.sb-caps'), { childList: true });
    });
    await sleep(ms);
    return page.evaluate(() => ({
        flips: window.__capsFlips,
        rows: [...document.querySelectorAll('.sb-caps [data-cap]')].map((b) => b.getAttribute('data-cap')).join(','),
    }));
}
async function sweep() {
    const out = new Map();
    for (const h of HEIGHTS) {
        await page.setViewportSize({ width: 1440, height: h });
        await sleep(200);
        out.set(h, await sample());
    }
    return out;
}

try {
    await page.goto(`${BASE}/dev/sidebar?scene=${SCENE}`);
    await page.locator('.sb-caps').waitFor({ timeout: 60_000 });
    await sleep(800);

    console.log('A. fresh mount');
    const fresh = await sweep();
    const freshFlips = [...fresh.values()].reduce((n, s) => n + s.flips, 0);
    check(freshFlips === 0, 'no flips at any height', JSON.stringify([...fresh].map(([h, s]) => [h, s.flips])));

    console.log('B. frozen while the window goes narrow, then active and wide again');
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    await page.setViewportSize({ width: 700, height: 900 });
    await sleep(500);
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await sleep(300);
    check(await page.locator('.sb-caps').count() === 0, 'the narrow window shows the phone layout (no 能力 block)');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.sb-caps').waitFor({ timeout: 10_000 });
    await sleep(300);
    const after = await sweep();
    const afterFlips = [...after.values()].reduce((n, s) => n + s.flips, 0);
    check(afterFlips === 0, 'no flips at any height after narrow → wide', JSON.stringify([...after].map(([h, s]) => [h, s.flips])));
    const mismatched = HEIGHTS.filter((h) => after.get(h).rows !== fresh.get(h).rows);
    check(mismatched.length === 0, 'the same rows as a fresh mount at every height', mismatched.map((h) => `${h}: ${after.get(h).rows} vs ${fresh.get(h).rows}`).join('; '));
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
