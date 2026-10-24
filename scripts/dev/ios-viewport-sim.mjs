#!/usr/bin/env node
/**
 * ios-viewport-sim —— 用 Playwright WebKit 模拟 iOS 主屏幕 PWA 的视口，验 B-797：
 *
 *   1. iPhone Duo 外屏：web view 466×657，但 standalone WebKit 的 100lvh = 678
 *      （真机 6c39a148：scrollY=21、--app-h=678）。断言 --app-h 被夹到 657、
 *      根文档不可滚（scrollHeight == clientHeight，scrollTo 后 scrollY 仍为 0）；
 *      同页撤掉 JS 夹值对照，证明模拟确实复现了 678 > 657。
 *   2. 普通 iPhone black-translucent（B-542）：innerHeight 793 + 顶部 inset 59 = 100lvh 852，
 *      断言 --app-h 保持 CSS 的 100lvh（铺满），不被夹短。
 *   3. 软键盘：iOS 键盘只缩 visualViewport。替换成可控的 visualViewport，缩到 380、
 *      平移 120 后断言会话页 composer 底边贴可见区底边、头部在可见区顶、文档不滚；
 *      新建对话弹窗（手机底部 sheet）的底边也贴键盘；收起后变量 / 属性 / 布局全部复原。
 *
 * 模拟的部分：display-mode standalone、-webkit-touch-callout、pointer: coarse（matchMedia /
 * CSS.supports 打桩，standalone 的 CSS 规则以注入样式代替），100lvh 探针高度，visualViewport。
 * 真机的 iOS 平移动画、scroll-edge 模糊仍需 Owner 真机验。
 *
 *   pnpm -C packages/happy-web-v2 exec vite --port 8797 --strictPort
 *   node scripts/dev/ios-viewport-sim.mjs --base http://127.0.0.1:8797 [--out <dir>]
 *
 * 需要 WebKit：pnpm -C packages/happy-web-v2 exec playwright-core install webkit（Linux 另需 install-deps）。
 * 退出码：任一断言失败为 1。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const base = opt('base', 'http://127.0.0.1:8797');
const outDir = opt('out', null);
if (outDir) mkdirSync(outDir, { recursive: true });

const { webkit } = await import('playwright-core');

let failures = 0;
const check = (ok, msg, detail) => {
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'} ${msg}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
};

/** Runs in the page before the app: an iOS standalone web view of `sim.inner` px whose 100lvh is `sim.lvh`. */
function simulateIos(sim) {
    const mm = window.matchMedia.bind(window);
    const forced = { '(display-mode: standalone)': true, '(pointer: coarse)': true };
    window.matchMedia = (q) => (q in forced ? { matches: forced[q], media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } : mm(q));
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (...a) => (a[0] === '-webkit-touch-callout' ? true : supports(...a));
    // 100lvh probe (viewportVars.measureCss / diag units): report the device's large viewport.
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
        const r = rect.call(this);
        if (this.style?.height !== '100lvh') return r;
        const pad = parseFloat(getComputedStyle(this).paddingTop) || 0;
        return new DOMRect(r.x, r.y, r.width, sim.lvh + pad);
    };
    // A controllable visual viewport (the iOS keyboard only shrinks this one).
    const vv = new EventTarget();
    const state = { height: sim.inner, offsetTop: 0 };
    Object.defineProperties(vv, {
        width: { get: () => window.innerWidth }, height: { get: () => state.height },
        offsetTop: { get: () => state.offsetTop }, offsetLeft: { get: () => 0 },
        pageTop: { get: () => window.scrollY + state.offsetTop }, pageLeft: { get: () => 0 }, scale: { get: () => 1 },
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
    window.__simKeyboard = (height, offsetTop) => {
        state.height = height;
        state.offsetTop = offsetTop;
        vv.dispatchEvent(new Event('resize'));
        vv.dispatchEvent(new Event('scroll'));
    };
    // What base.css's standalone-WebKit block and env() resolve to on the device — present from the
    // first script like the real thing; `html:root` outranks base.css's `:root`, the JS inline override
    // and `html[data-keyboard-open]` still outrank it.
    // (An adopted sheet: WebKit runs init scripts before <html> exists.)
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`html:root { --app-h: ${sim.lvh}px; --sa-t: ${sim.safeTop}px; --sa-b: ${sim.safeBottom}px; } html { height: var(--app-h); }`
        + ` html:root[data-keyboard-open] { --sa-b: 0px; }`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    localStorage.setItem('vh-pwa-install-never-v1', '1');
    localStorage.setItem('vh-notif-optin-dismissed-v1', '1');
    localStorage.setItem('vh.featureTips.seen.v1', JSON.stringify(['quick-open@1', 'prompt-rail@1', 'review-all@1', 'session-peek@1']));
}

async function open(browser, sim, path) {
    const context = await browser.newContext({ viewport: { width: sim.width, height: sim.inner }, deviceScaleFactor: 2, hasTouch: true, locale: 'zh-CN' });
    await context.addInitScript(simulateIos, sim);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app-shell, .vd-page', { timeout: 30_000 });
    await page.waitForTimeout(1200);
    return { context, page, errors };
}

const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

const rootState = (page) => page.evaluate(() => {
    const root = document.documentElement;
    window.scrollTo(0, 80);
    const scrollAfterTry = window.scrollY;
    window.scrollTo(0, 0);
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;height:var(--app-h)';
    document.body.appendChild(probe);
    const appH = probe.offsetHeight;
    probe.remove();
    return {
        scrollHeight: root.scrollHeight, clientHeight: root.clientHeight, scrollAfterTry, appH,
        override: root.style.getPropertyValue('--app-h'), rootLock: root.dataset.rootLock ?? null, keyboardOpen: root.dataset.keyboardOpen ?? null,
        shellBottom: document.querySelector('.app-shell')?.getBoundingClientRect().bottom ?? null,
    };
});

const DUO = { width: 466, inner: 657, lvh: 678, safeTop: 0, safeBottom: 34 };
const IPHONE_BT = { width: 430, inner: 873, lvh: 932, safeTop: 59, safeBottom: 34 };

const browser = await webkit.launch();
try {
    console.log('\n[1] iPhone Duo cover PWA: inner 657 / 100lvh 678');
    for (const path of ['/dev/device/session/dev-board', '/dev/device/', '/diag/viewport']) {
        const { context, page, errors } = await open(browser, DUO, path);
        const s = await rootState(page);
        check(s.appH === 657 && s.override === '657px', `${path}: --app-h clamped to the web view`, { appH: s.appH, override: s.override });
        check(s.scrollHeight === s.clientHeight && s.scrollAfterTry === 0, `${path}: root document cannot scroll`, { scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, scrollY: s.scrollAfterTry });
        check(s.rootLock === 'true', `${path}: root lock on`);
        if (s.shellBottom !== null) check(Math.abs(s.shellBottom - 657) <= 1, `${path}: shell ends at the visible bottom`, s.shellBottom);
        if (path === '/dev/device/session/dev-board') {
            // Control: without the JS clamp / lock the simulated device reproduces the bug.
            const before = await page.evaluate(() => {
                const root = document.documentElement;
                root.style.removeProperty('--app-h');
                delete root.dataset.rootLock;
                const r = { scrollHeight: root.scrollHeight, clientHeight: root.clientHeight };
                window.scrollTo(0, 80);
                r.scrollY = window.scrollY;
                window.scrollTo(0, 0);
                return r;
            });
            check(before.scrollHeight === 678 && before.scrollY === 21, 'control (clamp removed): document scrolls 21px like the device', before);
        }
        if (outDir) await page.screenshot({ path: join(outDir, `duo-${path.replace(/\W+/g, '-')}.png`) });
        check(errors.length === 0, `${path}: no page errors`, errors);
        await context.close();
    }

    console.log('\n[2] iPhone black-translucent PWA (B-542): inner 873 + top inset 59 = 100lvh 932');
    {
        const { context, page } = await open(browser, IPHONE_BT, '/dev/device/session/dev-board');
        const s = await rootState(page);
        check(s.override === '' && s.appH === 932, '--app-h stays 100lvh (fills to the screen edge)', { appH: s.appH, override: s.override });
        await context.close();
    }

    console.log('\n[3] soft keyboard on the Duo cover: visualViewport 380 tall, panned 120');
    {
        const { context, page, errors } = await open(browser, DUO, '/dev/device/session/dev-board');
        const composer = page.locator('.sd-foot textarea').first();
        await composer.focus();
        await page.evaluate(() => window.__simKeyboard(380, 120));
        await frame(page);
        const k = await page.evaluate(() => {
            const r = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
            const root = document.documentElement;
            return {
                keyboardOpen: root.dataset.keyboardOpen ?? null, vvH: root.style.getPropertyValue('--vv-h'), vvTop: root.style.getPropertyValue('--vv-top'),
                sdOpen: document.querySelector('.sd')?.dataset.keyboardOpen ?? null,
                foot: r('.sd-foot'), header: r('.app-detail') ?? r('.sd'), rootRect: r('#root'),
                footPad: getComputedStyle(document.querySelector('.sd-foot')).paddingBottom,
                scrollHeight: root.scrollHeight, clientHeight: root.clientHeight, focused: document.activeElement?.tagName,
            };
        });
        check(k.keyboardOpen === 'true' && k.sdOpen === 'true' && k.vvH === '380px' && k.vvTop === '120px', 'keyboard state published', { keyboardOpen: k.keyboardOpen, sd: k.sdOpen, vvH: k.vvH, vvTop: k.vvTop });
        check(Math.abs(k.foot.bottom - 500) <= 1, 'composer bottom sits on the keyboard (120 + 380)', k.foot.bottom);
        check(Math.abs(k.rootRect.top - 120) <= 1 && Math.abs(k.rootRect.height - 380) <= 1, 'app pinned to the visible area', { top: k.rootRect.top, height: k.rootRect.height });
        check(k.footPad === '0px', 'no home-indicator padding under the composer while the keyboard is up', k.footPad);
        check(k.scrollHeight === k.clientHeight, 'document still cannot scroll', { scrollHeight: k.scrollHeight, clientHeight: k.clientHeight });
        check(k.focused === 'TEXTAREA', 'composer keeps focus through the pin', k.focused);
        if (outDir) await page.screenshot({ path: join(outDir, 'duo-keyboard-session.png') });

        await page.evaluate(() => window.__simKeyboard(657, 0));
        await frame(page);
        const c = await page.evaluate(() => {
            const root = document.documentElement;
            return {
                keyboardOpen: root.dataset.keyboardOpen ?? null, vvH: root.style.getPropertyValue('--vv-h'), vvTop: root.style.getPropertyValue('--vv-top'),
                appH: root.style.getPropertyValue('--app-h'), sdOpen: document.querySelector('.sd')?.dataset.keyboardOpen ?? null,
                rootPos: getComputedStyle(document.getElementById('root')).position, footBottom: document.querySelector('.sd-foot').getBoundingClientRect().bottom,
                footPad: getComputedStyle(document.querySelector('.sd-foot')).paddingBottom, scrollY: window.scrollY,
            };
        });
        check(c.keyboardOpen === null && c.sdOpen === null && c.vvH === '' && c.vvTop === '' && c.appH === '657px' && c.rootPos !== 'fixed' && c.scrollY === 0,
            'keyboard closed: variables, attributes and #root fully restored', c);
        check(Math.abs(c.footBottom - 657) <= 1 && c.footPad === '34px', 'composer back at the app bottom with the home-indicator inset', { bottom: c.footBottom, pad: c.footPad });
        check(errors.length === 0, 'no page errors', errors);
        await context.close();
    }

    console.log('\n[4] soft keyboard over the new-chat dialog (phone bottom sheet)');
    {
        const { context, page, errors } = await open(browser, DUO, '/dev/device/');
        await page.locator('.sb-new-main, .sb-new-icon').first().click(); // phone header ＋ is a create menu
        const item = page.getByRole('menuitem').first();
        if (await item.count()) await item.click();
        await page.waitForSelector('.ns-card', { timeout: 10_000 });
        await page.waitForTimeout(300);
        await page.evaluate(() => window.__simKeyboard(380, 120));
        await frame(page);
        const d = await page.evaluate(() => {
            const card = document.querySelector('.ns-card').getBoundingClientRect();
            const backdrop = document.querySelector('.ns-backdrop').getBoundingClientRect();
            return { cardTop: card.top, cardBottom: card.bottom, backdropTop: backdrop.top, backdropBottom: backdrop.bottom };
        });
        check(Math.abs(d.backdropTop - 120) <= 1 && Math.abs(d.backdropBottom - 500) <= 1, 'dialog backdrop covers only the visible area', d);
        check(Math.abs(d.cardBottom - 500) <= 1 && d.cardTop >= 119, 'sheet sits on the keyboard, top inside the visible area', d);
        if (outDir) await page.screenshot({ path: join(outDir, 'duo-keyboard-new-chat.png') });
        await page.evaluate(() => window.__simKeyboard(657, 0));
        await frame(page);
        const back = await page.evaluate(() => document.querySelector('.ns-backdrop').getBoundingClientRect().bottom);
        check(Math.abs(back - 657) <= 1, 'keyboard closed: dialog backdrop back to full height', back);
        check(errors.length === 0, 'no page errors', errors);
        await context.close();
    }

    console.log('\n[5] Viewport 诊断: back top-left, keyboard test field live');
    {
        const { context, page } = await open(browser, DUO, '/diag/viewport');
        const b = await page.evaluate(() => {
            const r = document.querySelector('.vd-head .vh-back').getBoundingClientRect();
            return { left: r.left, top: r.top, width: r.width, height: r.height };
        });
        check(b.left < 40 && b.width >= 44 && b.height >= 44 && b.top >= 8, 'back is top-left, ≥44×44, clear of the top edge', b);
        await page.locator('#vd-kb-input').focus();
        await page.evaluate(() => window.__simKeyboard(380, 120));
        await page.waitForTimeout(1300);
        const live = await page.locator('[data-testid="vd-kb-live"]').innerText();
        check(/vv\.h=380 vv\.top=120 scrollY=0/.test(live) && /--app-h=380 \(js 380px\) open=yes root-lock=yes/.test(live), 'live line shows vv / scrollY / --app-h', live);
        if (outDir) await page.screenshot({ path: join(outDir, 'duo-diag-keyboard.png') });
        await context.close();
    }
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
