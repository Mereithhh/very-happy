#!/usr/bin/env node
/**
 * ipad-viewport-sim —— 用 Playwright WebKit 模拟 iPad，验 B-855「整页上移、下方大片空白」：
 *
 * 真机（用户 11-01，iPad Pro 横屏 + Magic Keyboard）：整个 app 被往上推约 300px（侧栏头、会话页头
 * 出屏，输入框到屏幕中间，下方空白），「闪一下」后自愈。即根文档带着 scrollY 残留——iOS 弹键盘时为露出
 * 输入框平移/滚动文档（overflow:hidden 挡不住，iOS 临时扩展可滚范围），收起后没归零。
 *
 * 模型：`__simIosPan(px)` = iOS 扩展可滚范围（在 <html> 内追加占位）+ 把文档滚到 px；收键盘只恢复
 * visualViewport，占位与 scrollY 残留保留（真机正是这样卡住，直到 iOS 自行重排「闪一下」）。
 * 设备：Macintosh UA + maxTouchPoints 5（iPadOS 桌面模式 Safari），any-pointer: coarse；
 * pointer 分 fine（接触控板/Magic Keyboard）与 coarse 两种。
 *
 * 场景（每个都断言 scrollY=0、#root 顶在 0、composer 底在屏幕底）：
 *   A 键盘弹出（vv 缩 + 平移）后收起   B 无键盘时程序化滚动（focus / scrollIntoView）
 *   C 横竖屏旋转带残留                 D 后台→前台（visibilitychange + pageshow）带残留
 *   E 键盘弹出期间：不与 iOS 平移打架（不 scrollTo）、#root 钉在可见区
 *   F（B-936）分栏（侧栏常驻）× 软键盘 436 / 硬件键盘快捷栏 764 × 有无 iOS 平移：侧栏顶在 0、全高 834 不动，
 *     只有内容区（.app-main-row）缩到可见高度、composer 贴在键盘上；收起后回到 0 偏移、内容区回到全高、无空白带
 *   G（B-936）单栏（侧栏收起）× 快捷栏：保持 B-797/B-855 行为——整个 #root 缩到可见高度
 * 另跑 Android Chromium（resizes-content：innerHeight 缩，vv 同步）回归：不判键盘、不滚、composer 贴底。
 * iPhone / Duo 回归用 ios-viewport-sim.mjs。
 *
 *   pnpm -C packages/happy-web-v2 exec vite --port 5410 --strictPort
 *   node scripts/dev/ipad-viewport-sim.mjs --base http://127.0.0.1:5410 [--out <dir>] [--no-android]
 *
 * 退出码：任一断言失败为 1（修前 fine 指针全部场景、coarse 指针 B/C/D 失败）。
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const base = opt('base', 'http://127.0.0.1:5410');
const outDir = opt('out', null);
if (outDir) mkdirSync(outDir, { recursive: true });

const { webkit, chromium } = await import('playwright-core');

let failures = 0;
const check = (ok, msg, detail) => {
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'} ${msg}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
};

const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

/** Runs before the app: an iPad Safari tab (Macintosh UA, touch screen) whose primary pointer is `sim.pointer`. */
function simulateIpad(sim) {
    const mm = window.matchMedia.bind(window);
    const forced = {
        '(pointer: coarse)': sim.pointer === 'coarse', '(pointer: fine)': sim.pointer === 'fine',
        '(any-pointer: coarse)': true, '(hover: hover)': sim.pointer === 'fine', '(hover: none)': sim.pointer === 'coarse',
    };
    window.matchMedia = (q) => (q in forced ? { matches: forced[q], media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } : mm(q));
    Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get: () => 5 });
    const vv = new EventTarget();
    const state = { height: null, offsetTop: 0 };
    Object.defineProperties(vv, {
        width: { get: () => window.innerWidth }, height: { get: () => state.height ?? window.innerHeight },
        offsetTop: { get: () => state.offsetTop }, offsetLeft: { get: () => 0 },
        pageTop: { get: () => window.scrollY + state.offsetTop }, pageLeft: { get: () => 0 }, scale: { get: () => 1 },
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
    const fire = () => {
        vv.dispatchEvent(new Event('resize'));
        vv.dispatchEvent(new Event('scroll'));
    };
    // iOS reveal-pan: the document becomes scrollable past its end and is scrolled — overflow:hidden does not stop it.
    window.__simIosPan = (px) => {
        let spacer = document.getElementById('__sim-pan');
        if (!spacer) {
            spacer = document.createElement('div');
            spacer.id = '__sim-pan';
            spacer.style.cssText = 'height:600px;width:1px;pointer-events:none';
            document.documentElement.appendChild(spacer);
        }
        document.scrollingElement.scrollTop = px;
        return window.scrollY;
    };
    window.__simKeyboard = (height, pan) => {
        state.height = height;
        state.offsetTop = 0;
        if (pan) window.__simIosPan(pan);
        fire();
    };
    window.__simKeyboardClose = () => {
        state.height = null;
        state.offsetTop = 0;
        fire(); // the pan residue stays — the device does not undo it
    };
    localStorage.setItem('vh-pwa-install-never-v1', '1');
    localStorage.setItem('vh-notif-optin-dismissed-v1', '1');
    localStorage.setItem('vh.featureTips.seen.v1', JSON.stringify(['quick-open@1', 'prompt-rail@1', 'review-all@1', 'session-peek@1']));
}

const IPAD_LAND = { width: 1194, height: 834 };
const IPAD_PORT = { width: 834, height: 1194 };
const PATH = '/dev/device/session/dev-board';

async function open(browser, pointer, size, { collapsed = false } = {}) {
    const context = await browser.newContext({ viewport: size, deviceScaleFactor: 2, hasTouch: true, userAgent: IPAD_UA, locale: 'zh-CN' });
    await context.addInitScript(simulateIpad, { pointer });
    if (collapsed) await context.addInitScript(() => localStorage.setItem('vh.sidebar.collapsed', '1'));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
    await page.goto(`${base}${PATH}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app-shell .sd-foot textarea', { timeout: 30_000 });
    await page.waitForTimeout(800);
    return { context, page, errors };
}

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))));

const layout = (page) => page.evaluate(() => {
    const root = document.documentElement;
    const r = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
    return {
        scrollY: window.scrollY, innerHeight: window.innerHeight,
        rootTop: Math.round(r('#root').top), footBottom: Math.round(r('.sd-foot').bottom),
        keyboardOpen: root.dataset.keyboardOpen ?? null, rootLock: root.dataset.rootLock ?? null,
        rootPos: getComputedStyle(document.getElementById('root')).position,
        rootH: Math.round(r('#root').height), pane: root.dataset.keyboardPane ?? null,
        sbTop: r('.app-sidebar') ? Math.round(r('.app-sidebar').top) : null, sbH: r('.app-sidebar') ? Math.round(r('.app-sidebar').height) : null,
        mainBottom: r('.app-main-row') ? Math.round(r('.app-main-row').bottom) : null,
    };
});

const restored = (l, label) => {
    check(l.scrollY === 0 && l.rootTop === 0 && Math.abs(l.footBottom - l.innerHeight) <= 1,
        `${label}: layout back in place (scrollY 0, app top 0, composer at the bottom)`, l);
};

const shot = async (page, name) => { if (outDir) await page.screenshot({ path: join(outDir, `${name}.png`) }); };

const browser = await webkit.launch();
try {
    for (const pointer of ['fine', 'coarse']) {
        console.log(`\n[iPad Pro 11, pointer: ${pointer}]`);
        const { context, page, errors } = await open(browser, pointer, IPAD_LAND);
        const start = await layout(page);
        check(start.rootLock === 'true' && start.scrollY === 0, 'root lock on, document at 0', start);

        // A — keyboard up (vv 834 → 436, iOS pans the document 300) then closed
        await page.locator('.sd-foot textarea').first().focus();
        const panned = await page.evaluate(() => window.__simKeyboard(436, 300) ?? window.scrollY);
        await settle(page);
        const up = await layout(page);
        check(panned > 0, 'model: the pan really scrolled the document', panned);
        check(up.keyboardOpen === 'true', 'A: keyboard recognised on iPad (touch screen, not just pointer: coarse)', up);
        check(up.rootPos === 'fixed', 'E: #root pinned to the visible area while the keyboard is up', up.rootPos);
        await page.evaluate(() => window.__simKeyboardClose());
        await settle(page);
        const a = await layout(page);
        await shot(page, `ipad-${pointer}-A-keyboard-closed`);
        restored(a, 'A keyboard closed');

        // B — no keyboard; something scrolls the document (focus / scrollIntoView of a card)
        await page.evaluate(() => window.__simIosPan(311));
        await settle(page);
        const b = await layout(page);
        await shot(page, `ipad-${pointer}-B-programmatic-scroll`);
        restored(b, 'B programmatic document scroll');

        // C — rotation with a residue
        await page.evaluate(() => window.__simIosPan(200));
        await page.setViewportSize(IPAD_PORT);
        await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
        await settle(page);
        const c = await layout(page);
        await shot(page, `ipad-${pointer}-C-rotated-portrait`);
        restored(c, 'C rotated to portrait');
        await page.setViewportSize(IPAD_LAND);
        await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
        await settle(page);
        restored(await layout(page), 'C rotated back to landscape');

        // D — background → foreground with a residue
        await page.evaluate(() => {
            window.__simIosPan(250);
            document.dispatchEvent(new Event('visibilitychange'));
            window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        });
        await settle(page);
        const d = await layout(page);
        restored(d, 'D back to the foreground');

        // E — keyboard up again: the guard must not fight iOS's pan (scrollY left as iOS set it)
        await page.evaluate(() => window.__simKeyboard(436, 120));
        await settle(page);
        const e = await layout(page);
        check(e.keyboardOpen === 'true' && e.scrollY === 120, 'E: while the keyboard is up the pan is followed, never undone', e);
        await page.evaluate(() => window.__simKeyboardClose());
        await settle(page);
        restored(await layout(page), 'E keyboard closed again');

        // F — B-936: split layout. Only the content pane avoids the keyboard; the sidebar never moves or shrinks.
        for (const [kb, vvH] of [['soft', 436], ['bar', 764]]) {
            for (const pan of [0, 120]) {
                const label = `F split · ${kb === 'soft' ? 'soft keyboard' : 'shortcut bar'} · ${pan ? `pan ${pan}` : 'no pan'}`;
                await page.locator('.sd-foot textarea').first().focus();
                await page.evaluate(([h, p]) => window.__simKeyboard(h, p), [vvH, pan]);
                await settle(page);
                const f = await layout(page);
                check(f.pane === 'detail' && f.sbTop === 0 && f.sbH === IPAD_LAND.height,
                    `${label}: sidebar stays at 0, full height`, { pane: f.pane, sbTop: f.sbTop, sbH: f.sbH, rootH: f.rootH });
                check(Math.abs(f.footBottom - vvH) <= 1 && Math.abs(f.mainBottom - vvH) <= 1,
                    `${label}: content pane ends at the keyboard, composer on it`, { footBottom: f.footBottom, mainBottom: f.mainBottom, vvH });
                await shot(page, `ipad-${pointer}-F-${kb}-${pan ? 'pan' : 'nopan'}`);
                await page.evaluate(() => window.__simKeyboardClose());
                await settle(page);
                const fc = await layout(page);
                restored(fc, `${label} → closed`);
                check(fc.pane === null && fc.sbH === IPAD_LAND.height && fc.mainBottom === IPAD_LAND.height,
                    `${label} → closed: no pane mark, sidebar and content back to full height (no blank band)`, { pane: fc.pane, sbH: fc.sbH, mainBottom: fc.mainBottom });
            }
        }
        check(errors.length === 0, 'no page errors', errors);
        await context.close();

        // G — B-936: single pane (sidebar collapsed) keeps the whole-root behaviour
        console.log(`\n[iPad Pro 11, pointer: ${pointer}, sidebar collapsed]`);
        const single = await open(browser, pointer, IPAD_LAND, { collapsed: true });
        await single.page.locator('.sd-foot textarea').first().focus();
        await single.page.evaluate(() => window.__simKeyboard(764, 0));
        await settle(single.page);
        const g = await layout(single.page);
        check(g.pane === 'root' && g.rootPos === 'fixed' && g.rootH === 764 && Math.abs(g.footBottom - 764) <= 1,
            'G single pane · shortcut bar: the whole app is the visible area (unchanged)', { pane: g.pane, rootH: g.rootH, footBottom: g.footBottom });
        await shot(single.page, `ipad-${pointer}-G-single-bar`);
        await single.page.evaluate(() => window.__simKeyboardClose());
        await settle(single.page);
        restored(await layout(single.page), 'G closed');
        check(single.errors.length === 0, 'no page errors (single pane)', single.errors);
        await single.context.close();
    }
} finally {
    await browser.close();
}

function chromiumExe() {
    const dir = join(homedir(), '.cache', 'ms-playwright');
    if (!existsSync(dir)) return undefined;
    for (const entry of readdirSync(dir).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
        for (const p of ['chrome-linux/chrome', 'chrome-linux64/chrome']) if (existsSync(join(dir, entry, p))) return join(dir, entry, p);
    }
    return undefined;
}

if (!args.includes('--no-android')) {
    console.log('\n[Android Chromium (Pixel 7), resizes-content keyboard]');
    const exe = chromiumExe();
    const cb = await chromium.launch(exe ? { executablePath: exe } : {});
    try {
        const context = await cb.newContext({
            viewport: { width: 412, height: 839 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true, locale: 'zh-CN',
            userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
        });
        await context.addInitScript(() => {
            localStorage.setItem('vh-pwa-install-never-v1', '1');
            localStorage.setItem('vh-notif-optin-dismissed-v1', '1');
            localStorage.setItem('vh.featureTips.seen.v1', JSON.stringify(['quick-open@1', 'prompt-rail@1', 'review-all@1', 'session-peek@1']));
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
        await page.goto(`${base}${PATH}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.sd-foot textarea', { timeout: 30_000 });
        await page.waitForTimeout(800);
        await page.locator('.sd-foot textarea').first().focus();
        await page.setViewportSize({ width: 412, height: 500 }); // the keyboard resizes the content
        await settle(page);
        const k = await layout(page);
        check(k.keyboardOpen === null && k.scrollY === 0 && Math.abs(k.footBottom - 500) <= 1, 'keyboard up: no overlay pin, composer on the keyboard, no scroll', k);
        await shot(page, 'android-keyboard');
        await page.setViewportSize({ width: 412, height: 839 });
        await settle(page);
        const c = await layout(page);
        check(c.scrollY === 0 && Math.abs(c.footBottom - 839) <= 1, 'keyboard closed: composer back at the bottom', c);
        const focused = await page.evaluate(() => document.activeElement?.tagName);
        check(focused === 'TEXTAREA', 'composer keeps focus', focused);
        check(errors.length === 0, 'no page errors', errors);
        await context.close();
    } finally {
        await cb.close();
    }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
