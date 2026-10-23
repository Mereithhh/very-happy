#!/usr/bin/env node
/**
 * device-shots —— 在真实 Chromium 里按**设备预设**截 Web 主要页面，并量溢出 / 触控尺寸。
 *
 * 页面来自 DEV harness `/dev/device/*`（B-795）：真实 AppLayout（侧栏 / rail / 单栏切换）
 * 包着真实会话页（汇报板负责人会话）、团队页、项目页和设置页，数据全是本地示例。
 * 所以先起 Web dev server（不需要后端）：
 *
 *   pnpm -C packages/happy-web-v2 exec vite --port 8795 --strictPort
 *   node scripts/dev/device-shots.mjs --base http://127.0.0.1:8795 --out <dir> \
 *        [--devices duo-folded,duo-open-land] [--pages session,board] [--themes light,dark]
 *   node scripts/dev/device-shots.mjs --base … --fold      # 折叠 ↔ 展开切换回归
 *
 * 粗指针设备在 page 创建后用 CDP 打开原生触屏，并在每张截图后核验
 * `matchMedia('(pointer: coarse)')` 仍为真（见 dev skill：长页截图会重置触屏模拟）。
 * 截图只截真实视口。每张图同时打印：
 *   - overflowX：文档横向溢出像素（应为 0）
 *   - outside：右边缘越出视口的可见元素（应为空）
 *   - smallTargets：粗指针下宽或高 < 44px 的可见按钮（只报告，部分为内联图标）
 * `--fold` 在会话页、汇报板、团队页、项目页和新建对话弹窗上做 466×678 ↔ 890×626
 * 往返，断言弹窗仍开、composer 草稿仍在、聊天滚动位置保持、没有整页重载。
 * 退出码：任何断言失败为 1。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** iPhone Duo（2026-10）CSS 视口为公开估算值（DPR 3 假设），Apple 未公布浏览器值。 */
export const DEVICES = {
    'duo-folded': { width: 466, height: 678, dpr: 3, coarse: true, label: 'iPhone Duo 合起 5.4"' },
    'duo-open-land': { width: 890, height: 626, dpr: 3, coarse: true, label: 'iPhone Duo 展开横屏 7.6"' },
    'duo-open-port': { width: 626, height: 890, dpr: 3, coarse: true, label: 'iPhone Duo 展开竖屏 7.6"' },
    'phone': { width: 390, height: 844, dpr: 3, coarse: true, label: 'iPhone 6.1"' },
    'desktop': { width: 1440, height: 900, dpr: 1, coarse: false, label: 'Desktop' },
};

/** 页面：path 相对 /dev/device；prepare 在截图前于页面里执行（打开汇报板等）。 */
export const PAGES = {
    // A lead session opens in 「只看我和负责人」 by default (B-766 B-1).
    session: { path: '/session/dev-board' },
    board: { path: '/session/dev-board', prepare: 'board' },
    sidebar: { path: '/', prepare: 'sidebar' },
    team: { path: '/teams/team-pay' },
    project: { path: '/projects/pj-pay' },
    // Settings never shows the sidebar in the app (single pane), so it is captured outside the shell.
    settings: { url: '/dev/settings' },
};

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const base = opt('base', 'http://127.0.0.1:8795');
const outDir = opt('out', null);
const devices = opt('devices', 'duo-folded,duo-open-land,duo-open-port').split(',');
const pages = opt('pages', Object.keys(PAGES).join(',')).split(',');
const themes = opt('themes', 'light,dark').split(',');
const locale = opt('locale', 'zh-CN');

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

const exe = findChromium();
if (!exe) {
    console.error('device-shots: no Chromium in the playwright cache (pnpm dlx playwright-core@1.55.0 install chromium)');
    process.exit(2);
}
const { chromium } = await import('playwright-core');
if (outDir) mkdirSync(outDir, { recursive: true });

let failures = 0;
const fail = (msg) => { failures++; console.log(`  ✗ ${msg}`); };

async function open(browser, device, theme) {
    const d = DEVICES[device];
    if (!d) throw new Error(`unknown device ${device}`);
    const context = await browser.newContext({
        viewport: { width: d.width, height: d.height }, screen: { width: d.width, height: d.height },
        deviceScaleFactor: d.dpr, colorScheme: theme, hasTouch: d.coarse, isMobile: false, locale,
    });
    // One-time nudges (PWA install, notification opt-in, feature tips) would cover the layout under test.
    await context.addInitScript(() => {
        localStorage.setItem('vh-pwa-install-never-v1', '1');
        localStorage.setItem('vh-notif-optin-dismissed-v1', '1');
        localStorage.setItem('vh.featureTips.seen.v1', JSON.stringify(['quick-open@1', 'prompt-rail@1', 'review-all@1', 'session-peek@1']));
    });
    const page = await context.newPage();
    let cdp = null;
    if (d.coarse) {
        cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
    return { context, page, cdp, d, errors };
}

async function assertCoarse(page, d, where) {
    if (!d.coarse) return;
    if (!await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) throw new Error(`device-shots: pointer not coarse at ${where}`);
}

async function shot(page, cdp, d) {
    if (!cdp) return page.screenshot();
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
    await assertCoarse(page, d, 'screenshot');
    return Buffer.from(data, 'base64');
}

async function goto(page, path, url) {
    await page.goto(`${base}${url ?? `/dev/device${path}`}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app-shell, .settings-workspace', { timeout: 20_000 });
    await page.waitForTimeout(900);
}

async function prepare(page, kind) {
    if (kind === 'board') {
        // The user's path: phones drop the top sheet from the summary strip; wider screens use the header button (aside tab).
        const strip = page.locator('.brf-strip-btn').first();
        if (await strip.count() && await strip.isVisible()) await strip.click();
        else await page.locator('.brf-hbtn').first().click();
    }
    await page.waitForTimeout(500);
}

function measure() {
    const vw = innerWidth;
    const doc = document.scrollingElement;
    const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null;
        return r;
    };
    const label = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.className || el.tagName).toString().trim().replace(/\s+/g, ' ').slice(0, 40);
    const outside = [];
    for (const el of document.querySelectorAll('body *')) {
        const r = visible(el);
        if (!r || r.right <= vw + 1) continue;
        // an ancestor that clips horizontally hides it
        let clipped = false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const ox = getComputedStyle(p).overflowX;
            if (ox !== 'visible' && p.getBoundingClientRect().right <= vw + 1) { clipped = true; break; }
        }
        if (!clipped && !el.closest('[aria-hidden="true"]')) outside.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} → ${Math.round(r.right)}`);
        if (outside.length > 8) break;
    }
    const smallTargets = [];
    if (matchMedia('(pointer: coarse)').matches) {
        for (const el of document.querySelectorAll('button, [role="button"], a[href], [role="tab"], [role="switch"]')) {
            const r = visible(el);
            if (!r || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > vw) continue;
            if (r.width < 44 || r.height < 44) smallTargets.push(`${label(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
        }
    }
    return { overflowX: doc.scrollWidth - doc.clientWidth, outside, smallTargets: smallTargets.length, smallSample: smallTargets.slice(0, 12), shell: document.querySelector('.app-shell')?.className ?? null };
}

async function captureAll(browser) {
    for (const device of devices) {
        for (const theme of themes) {
            const { context, page, cdp, d, errors } = await open(browser, device, theme);
            for (const name of pages) {
                const p = PAGES[name];
                if (!p) throw new Error(`unknown page ${name}`);
                await goto(page, p.path, p.url);
                await assertCoarse(page, d, `${device}/${name}`);
                if (p.prepare) await prepare(page, p.prepare);
                const m = await page.evaluate(measure);
                const tag = `${device}-${name}-${theme}`;
                console.log(`── ${tag} (${d.width}×${d.height}) overflowX=${m.overflowX} small=${m.smallTargets} shell="${m.shell}"`);
                if (m.overflowX > 0) fail(`${tag}: document overflows horizontally by ${m.overflowX}px`);
                if (m.outside.length) fail(`${tag}: outside viewport: ${m.outside.join(', ')}`);
                if (args.includes('--verbose') && m.smallSample.length) console.log(`  small: ${m.smallSample.join(' | ')}`);
                if (outDir) writeFileSync(join(outDir, `${tag}.png`), await shot(page, cdp, d));
            }
            if (errors.length) fail(`${device}/${theme} pageerror: ${errors.join(' | ')}`);
            await context.close();
        }
    }
}

/** Resize like a fold/unfold: the viewport jumps; the page must not reload or drop state. */
async function foldRoundTrip(browser) {
    const folded = DEVICES['duo-folded'];
    const open = DEVICES['duo-open-land'];
    const resize = async (page, cdp, d) => {
        await page.setViewportSize({ width: d.width, height: d.height });
        await page.waitForTimeout(600);
        await assertCoarse(page, d, 'resize');
    };
    const cases = [
        { name: 'session draft + scroll', path: '/session/dev-board' },
        { name: 'board', path: '/session/dev-board', prepare: 'board' },
        { name: 'team', path: '/teams/team-pay' },
        { name: 'project', path: '/projects/pj-pay' },
        // Opened from the sidebar's 新建会话: unfolded on a session page (two panes), folded on the list.
        { name: 'new-chat dialog', path: '/session/dev-board', foldedPath: '/', dialog: true },
    ];
    for (const start of ['duo-open-land', 'duo-folded']) {
        for (const c of cases) {
            const ctx = await open(browser, start, 'light');
            const { page, cdp, context, errors } = ctx;
            await goto(page, start === 'duo-folded' && c.foldedPath ? c.foldedPath : c.path);
            if (c.prepare) await prepare(page, c.prepare);
            await page.evaluate(() => { window.__noReload = 1; });
            const draft = 'fold-draft 折叠草稿';
            const composer = page.locator('textarea').first();
            const hasComposer = !c.dialog && c.path.startsWith('/session') && await composer.count() > 0;
            if (hasComposer) await composer.fill(draft);
            let scrollBefore = null;
            if (c.name.startsWith('session')) {
                scrollBefore = await page.evaluate(() => {
                    const s = [...document.querySelectorAll('*')].find((el) => el.scrollHeight > el.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(el).overflowY) && el.closest('.app-detail'));
                    if (!s) return null;
                    s.scrollTop = Math.max(0, Math.round((s.scrollHeight - s.clientHeight) / 3));
                    s.dispatchEvent(new Event('scroll'));
                    return { top: s.scrollTop, anchor: [...s.querySelectorAll('[data-message-id]')].find((m) => m.getBoundingClientRect().top >= s.getBoundingClientRect().top)?.getAttribute('data-message-id') ?? null };
                });
                await page.waitForTimeout(300);
            }
            if (c.dialog) {
                await page.locator('.sb-new-main').first().click();
                await page.waitForTimeout(600);
            }
            const dialogOpen = () => page.evaluate(() => !!document.querySelector('[role="dialog"]'));
            const boardOpen = () => page.evaluate(() => !!document.querySelector('.brf-panel, .brf-sheet'));
            const before = { dialog: await dialogOpen(), board: await boardOpen() };
            if (c.dialog && !before.dialog) fail(`${start}/${c.name}: dialog did not open`);
            const other = start === 'duo-folded' ? open : folded;
            const back = DEVICES[start];
            const tag = `${start}→${other === open ? 'open' : 'folded'}→back ${c.name}`;
            for (const [step, d] of [['flip', other], ['back', back]]) {
                await resize(page, cdp, d);
                if (outDir) writeFileSync(join(outDir, `fold-${start}-${c.name.replace(/\W+/g, '_')}-${step}.png`), await shot(page, cdp, d));
                if (!await page.evaluate(() => window.__noReload === 1)) fail(`${tag}: page reloaded at ${step}`);
                if (before.dialog && !await dialogOpen()) fail(`${tag}: dialog closed at ${step}`);
                if (hasComposer) {
                    const v = await page.locator('textarea').first().inputValue().catch(() => null);
                    if (v !== draft) fail(`${tag}: composer draft lost at ${step} (got ${JSON.stringify(v)})`);
                }
            }
            if (scrollBefore?.anchor) {
                const ok = await page.evaluate((anchor) => {
                    const el = document.querySelector(`[data-message-id="${anchor}"]`);
                    if (!el) return false;
                    const r = el.getBoundingClientRect();
                    return r.bottom > 0 && r.top < innerHeight;
                }, scrollBefore.anchor);
                if (!ok) fail(`${tag}: scroll anchor ${scrollBefore.anchor} left the viewport`);
            }
            if (errors.length) fail(`${tag}: pageerror ${errors.join(' | ')}`);
            console.log(`── fold ${tag}: dialog=${before.dialog} board=${before.board} → board now=${await boardOpen()}`);
            await context.close();
        }
    }
}

const browser = await chromium.launch({ executablePath: exe });
try {
    if (args.includes('--fold')) await foldRoundTrip(browser);
    else await captureAll(browser);
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
