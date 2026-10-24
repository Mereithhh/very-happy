#!/usr/bin/env node
/**
 * device-shots —— 在真实 Chromium 里按**设备预设**截 Web 主要页面，并量溢出 / 触控尺寸。
 *
 * 页面来自 DEV harness `/dev/device/*`（B-795）：真实 AppLayout（侧栏 / rail / 单栏切换）
 * 包着真实会话页（汇报板负责人会话）、团队页、项目页和设置页，数据全是本地示例；
 * `--pages secondary` 扫一遍其余二级页（B-796：手机上每页左上角都要有返回）；
 * `--pages overlays` 扫壳外浮层：更新弹窗、通知面板、各类 toast（B-796b：✕ 不得落进侧边 inset）。
 * `--pages menus` 打开会话页 ⋯ 和侧栏首 / 末行 ⋯（B-798）：每个菜单项都要能滚进视口（扣掉 safe-area）
 * 并且点得到（elementFromPoint 命中该项），粗指针 ≤600px 必须是底部 sheet，更宽的是限高弹出菜单。
 * 所以先起 Web dev server（不需要后端）：
 *
 *   pnpm -C packages/happy-web-v2 exec vite --port 8795 --strictPort
 *   node scripts/dev/device-shots.mjs --base http://127.0.0.1:8795 --out <dir> \
 *        [--devices duo-folded,duo-open-land] [--pages session,board] [--themes light,dark]
 *   node scripts/dev/device-shots.mjs --base … --fold      # 折叠 ↔ 展开切换回归
 *   node scripts/dev/device-shots.mjs --base … --devices duo-folded-inset   # 外屏右侧状态列（B-796）
 *
 * 粗指针设备在 page 创建后用 CDP 打开原生触屏，并在每张截图后核验
 * `matchMedia('(pointer: coarse)')` 仍为真（见 dev skill：长页截图会重置触屏模拟）。
 * 截图只截真实视口。每张图同时打印：
 *   - overflowX：文档横向溢出像素（应为 0）
 *   - outside：右边缘越出视口的可见元素（应为空）
 *   - hoverOnly：触屏上占位却透明（只有 hover 才显示）的按钮（应为空）
 *   - inInset：带 safeArea 的预设下，落进侧边 inset（系统状态列）里的可点控件（应为空）
 *   - smallTargets：粗指针下宽或高 < 44px 的可见按钮（只报告：量的是盒子，
 *     不含 ::after 扩出的热区；行内文字链接按 WCAG 2.5.8 例外处理）
 * `--fold` 在会话页、汇报板、团队页、项目页和新建对话弹窗上做 466×678 ↔ 890×626
 * 往返，断言弹窗（含输入内容）仍在、汇报板仍开、composer 草稿仍在、聊天滚动位置保持、
 * 没有整页重载；再验 890×626 的侧栏抽屉（rail 打开，遮罩 / Esc / 收起按钮 / 导航关闭）。
 * 退出码：任何断言失败为 1。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** iPhone Duo（2026-10）CSS 视口为公开估算值（DPR 3 假设），Apple 未公布浏览器值。 */
export const DEVICES = {
    'duo-folded': { width: 466, height: 678, dpr: 3, coarse: true, label: 'iPhone Duo 合起 5.4"' },
    // B-796: the cover display in portrait keeps the clock / camera / status icons in a column on the
    // RIGHT edge (third-party measurements: insets top 0 · right 84 · bottom 34 · left 0 pt). Chromium
    // has no env(safe-area-inset-*) override, so the preset sets the app's `--sa-*` mirrors and draws
    // the column (system material look) over the page; `inInset` lists controls left under it.
    'duo-folded-inset': { width: 466, height: 678, dpr: 3, coarse: true, label: 'iPhone Duo 合起 + 右侧状态列', safeArea: { top: 0, right: 84, bottom: 34, left: 0 } },
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
    // Phones show the list at the root; the drawer (medium touch) opens over a session.
    sidebar: { path: (d) => (d.width < 800 ? '/' : '/session/dev-board'), prepare: 'sidebar' },
    team: { path: '/teams/team-pay' },
    project: { path: '/projects/pj-pay' },
    // Single pane in the app (no sidebar), but inside the shell (B-796: the shell pads the side insets).
    settings: { path: '/settings' },
    // B-798 PR F (`--pages touch`): an ordinary session (no all-zero board strip), the prompt nav over a
    // tool-output copy overlay (the nav must take the tap), 「会话信息」 from a phone header's ⋯, and a 404 id.
    plain: { path: '/session/dev-plain' },
    'prompt-nav': { path: '/session/dev-plain', prepare: 'prompt-nav' },
    'session-info': { path: '/session/dev-plain', prepare: 'session-info' },
    'session-missing': { path: '/session/dev-missing', ready: '.sd-loading .vh-empty' },
};

/** B-796b: overlays outside the shell (the release-notes ✕ sat under the Duo status column in production). */
export const OVERLAYS = {
    // The harness mounts the pager on `#whats-new`; a fresh profile has one unread release, so its last page shows the ✕.
    'whats-new': { path: '/session/dev-board#whats-new', prepare: 'whats-new' },
    notifications: { path: (d) => (d.width < 800 ? '/' : '/session/dev-board'), prepare: 'notifications' },
    // success / error / sticky action toast (with its ✕), raised by the harness on `#toasts`.
    toasts: { path: '/session/dev-board#toasts', prepare: 'toasts' },
};
Object.assign(PAGES, OVERLAYS);

/** B-796 sweep: every secondary page inside the shell (`--pages secondary`); a phone must show a back control on each. */
export const SECONDARY = {
    'teams-list': '/teams', 'projects-list': '/projects', 'project-settings': '/projects/pj-pay/settings',
    automations: '/automations', 'automation-new': '/automations/new', todos: '/todos', people: '/people',
    notes: '/notes', 'task-board': '/board', help: '/help', 'terminal-picker': '/terminal', 'machine-connect': '/machine/connect',
    machine: '/machine/dev-machine', 'settings-account': '/settings/account', 'settings-appearance': '/settings/appearance',
};
for (const [name, path] of Object.entries(SECONDARY)) PAGES[name] = { path, back: true };

/** B-798 (P0-1): long ⋯ menus ran off the Duo cover / phone and could not scroll; `menus` = trigger selector, first and last match are opened. */
export const MENUS = {
    'menu-session': { path: '/session/dev-board', menus: '.ch button.ch-icon[aria-haspopup="menu"]' },
    'menu-sidebar': { path: (d) => (d.width < 800 ? '/' : '/session/dev-board'), prepare: 'sidebar', menus: '.sb-row-menu' },
};
Object.assign(PAGES, MENUS);
PAGES.team.back = true;
PAGES.project.back = true;
PAGES.session.back = true;

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const base = opt('base', 'http://127.0.0.1:8795');
const outDir = opt('out', null);
const devices = opt('devices', 'duo-folded,duo-open-land,duo-open-port').split(',');
const PRIMARY = ['session', 'board', 'sidebar', 'team', 'project', 'settings'];
const GROUPS = { secondary: Object.keys(SECONDARY), overlays: Object.keys(OVERLAYS), menus: Object.keys(MENUS), touch: ['session', 'plain', 'prompt-nav', 'session-info', 'session-missing'] };
const pages = opt('pages', PRIMARY.join(',')).split(',').flatMap((p) => GROUPS[p] ?? [p]);
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

async function openDevice(browser, device, theme) {
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
    if (d.safeArea) await context.addInitScript(simulateSafeArea, d.safeArea);
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

/** Runs in the page: `--sa-*` (styles/base.css) stand in for env(safe-area-inset-*); the column mimics iOS's. */
function simulateSafeArea(sa) {
    const install = () => {
        const style = document.createElement('style');
        style.dataset.simSafeArea = '';
        style.textContent = `:root { --sa-t: ${sa.top}px !important; --sa-r: ${sa.right}px !important; --sa-b: ${sa.bottom}px !important; --sa-l: ${sa.left}px !important; }`
            + `#sim-status-column { position: fixed; z-index: 2147483647; top: 0; right: 0; bottom: 0; width: ${sa.right}px; pointer-events: none; display: flex; flex-direction: column; align-items: center; padding-top: 28px; gap: 6px; font: 600 15px -apple-system, system-ui, sans-serif; color: #000; }`
            + `#sim-status-column > i { width: 46px; height: 120px; border-radius: 23px; background: rgb(255 255 255 / 0.55); backdrop-filter: blur(14px); display: flex; flex-direction: column; align-items: center; justify-content: center; font-style: normal; }`;
        document.head.appendChild(style);
        const col = document.createElement('div');
        col.id = 'sim-status-column';
        col.setAttribute('aria-hidden', 'true');
        col.innerHTML = '<i>●<br>10:59<br>◔</i>';
        document.body.appendChild(col);
    };
    if (document.body) install(); else document.addEventListener('DOMContentLoaded', install);
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

async function goto(page, path, url, ready) {
    await page.goto(`${base}${url ?? `/dev/device${path}`}`, { waitUntil: 'domcontentloaded' });
    // A hash-only change (`#toasts` after the same session path) does not reload the harness.
    if ((url ?? path).includes('#')) await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app-shell, .settings-workspace', { timeout: 20_000 });
    if (ready) await page.waitForSelector(ready, { timeout: 10_000 }).catch(() => fail(`${path}: ${ready} never appeared`));
    await page.waitForTimeout(900);
}

async function prepare(page, kind) {
    if (kind === 'board') {
        // The user's path: phones drop the top sheet from the summary strip; wider screens use the header button (aside tab).
        const strip = page.locator('.brf-strip-btn').first();
        if (await strip.count() && await strip.isVisible()) await strip.click();
        else await page.locator('.brf-hbtn').first().click();
    } else if (kind === 'sidebar') {
        // Medium touch screens: the sidebar tree lives in the drawer behind the rail.
        const rail = page.locator('.app-rail-btn[aria-expanded="false"]').first();
        if (await rail.count()) await rail.click();
    } else if (kind === 'whats-new') {
        await page.waitForSelector('.wn-card', { timeout: 10_000 });
        // Locked pages hide the ✕; page forward to the last one, where it shows.
        for (let i = 0; i < 12 && !await page.locator('.wn-close').count(); i++) {
            await page.locator('.wn-nav .wn-done').click();
            await page.waitForTimeout(250);
        }
        if (!await page.locator('.wn-close').count()) throw new Error('device-shots: release notes never reached the page with ✕');
    } else if (kind === 'notifications') {
        const rail = page.locator('.app-rail-btn[aria-expanded="false"]').first();
        if (!await page.locator('.nc-bell-btn:visible').count() && await rail.count()) { await rail.click(); await page.waitForTimeout(400); }
        await page.locator('.nc-bell-btn:visible').first().click();
        await page.waitForSelector('.nc-panel', { timeout: 10_000 });
    } else if (kind === 'toasts') {
        await page.waitForSelector('.vh-toast-x', { timeout: 10_000 });
    } else if (kind === 'prompt-nav') {
        // Open the folded turns (their Bash cards carry the copy overlays), scroll up (the nav shows only away
        // from the bottom), then put a tool-output copy overlay right under the nav.
        await page.evaluate(() => document.querySelectorAll('.cl-inner .ta-head[aria-expanded="false"]').forEach((b) => b.click()));
        await page.waitForTimeout(400);
        await page.evaluate(() => { const s = document.querySelector('.cl-scroll'); s.scrollTop = s.scrollHeight / 2; s.dispatchEvent(new Event('scroll')); });
        await page.waitForSelector('.cl-promptnav', { timeout: 10_000 });
        await page.evaluate(() => {
            const s = document.querySelector('.cl-scroll');
            const nav = document.querySelector('.cl-promptnav').getBoundingClientRect();
            const target = nav.top + nav.height * 0.75;
            const overlays = [...s.querySelectorAll('.vh-copy--overlay')];
            const best = overlays.map((el) => { const r = el.getBoundingClientRect(); return { d: r.top + r.height / 2 - target }; })
                .sort((a, b) => Math.abs(a.d) - Math.abs(b.d))[0];
            if (best) { s.scrollTop += best.d; s.dispatchEvent(new Event('scroll')); }
        });
        await page.waitForTimeout(400);
    } else if (kind === 'session-info') {
        await page.locator('.ch button[aria-haspopup="menu"]').last().click();
        await page.waitForSelector('[role="menu"]', { timeout: 5_000 });
        const info = page.locator('[role="menuitem"]', { hasText: /会话信息|Session info/ });
        // Wide headers keep agent · machine and the relay badge on the bar: no entry, the open menu is the capture.
        if (await info.count()) { await info.click(); await page.waitForSelector('.ch-info-dialog', { timeout: 5_000 }); }
    }
    await page.waitForTimeout(500);
}

function measure(sa) {
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
    // Hover-only controls: laid out on screen but transparent until a hover that touch never sends.
    const hoverOnly = [];
    if (!matchMedia('(hover: hover)').matches) {
        for (const el of document.querySelectorAll('button, [role="button"]')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > vw) continue;
            if (el.closest('[aria-hidden="true"], .app-sidebar--parked, .app-sidebar--drawer:not(.is-open)')) continue;
            let faded = false;
            for (let n = el; n && n !== document.body; n = n.parentElement) {
                const cs = getComputedStyle(n);
                if (cs.display === 'none' || cs.visibility === 'hidden') { faded = false; break; }
                if (Number(cs.opacity) === 0) faded = true;
            }
            if (faded) hoverOnly.push(label(el));
        }
    }
    // Controls the user can't reach: under a simulated side inset (the system column draws over it).
    const inInset = [];
    if (sa && (sa.left || sa.right)) {
        for (const el of document.querySelectorAll('button, [role="button"], a[href], [role="tab"], input, textarea, .vh-toast')) {
            const r = visible(el);
            if (!r || r.bottom < 0 || r.top > innerHeight || el.closest('[aria-hidden="true"], .app-sidebar--parked, .app-sidebar--drawer:not(.is-open)')) continue;
            if (r.right > vw - sa.right + 1 || r.left < sa.left - 1) inInset.push(`${label(el)} ${Math.round(r.left)}–${Math.round(r.right)}`);
            if (inInset.length > 8) break;
        }
    }
    // A visible back control in the page's top band (unified BackButton or a header back link).
    const back = [...document.querySelectorAll('.app-detail .vh-back, .app-detail a[class*="back"], .app-detail button[class*="back"]')]
        .map((el) => visible(el)).find((r) => r && r.top < 140 && r.left < vw / 2) ?? null;
    // B-798 P1-7: what a tap on each prompt-nav button actually hits (null when the nav is not shown).
    const navHits = [...document.querySelectorAll('.cl-promptnav-btn')].map((btn) => {
        const r = btn.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit) return 'none';
        if (btn.contains(hit)) return 'nav';
        const owner = hit.closest('button, a') ?? hit;
        return `${owner.tagName.toLowerCase()}.${(owner.getAttribute('class') ?? '').split(' ').join('.')}`;
    });
    const overlaysUnderNav = (() => {
        const nav = document.querySelector('.cl-promptnav')?.getBoundingClientRect();
        if (!nav) return 0;
        return [...document.querySelectorAll('.vh-copy--overlay')].filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.left < nav.right && r.right > nav.left && r.top < nav.bottom && r.bottom > nav.top;
        }).length;
    })();
    return { navHits, overlaysUnderNav, overflowX: doc.scrollWidth - doc.clientWidth, outside, hoverOnly, inInset, back: back ? `${Math.round(back.left)},${Math.round(back.top)}` : null, smallTargets: smallTargets.length, smallSample: smallTargets.slice(0, 12), shell: document.querySelector('.app-shell')?.className ?? null };
}

/** Runs in the page with the menu open: scroll each item into view inside the menu, then it must sit on screen (insets excluded) and be the element under its own centre. */
function menuReach(sa) {
    const menu = document.querySelector('.vh-menu[data-state="open"]');
    if (!menu) return null;
    const inset = { top: 0, right: 0, bottom: 0, left: 0, ...(sa ?? {}) };
    const coarse = matchMedia('(pointer: coarse)').matches;
    const items = [...menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')];
    const unreachable = [];
    const short = [];
    for (const it of items) {
        it.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = it.getBoundingClientRect();
        const name = (it.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
        const onScreen = r.top >= inset.top - 0.5 && r.bottom <= innerHeight - inset.bottom + 0.5 && r.left >= inset.left - 0.5 && r.right <= innerWidth - inset.right + 0.5;
        const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        if (!onScreen || !hit || !it.contains(hit)) unreachable.push(`${name} ${Math.round(r.top)}–${Math.round(r.bottom)}`);
        if (coarse && (r.height < 43.5 || r.width < 43.5)) short.push(`${name} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    menu.scrollTop = 0;
    const box = menu.getBoundingClientRect();
    return {
        count: items.length, unreachable, short, sheet: menu.classList.contains('vh-menu--sheet'),
        scrolls: menu.scrollHeight > menu.clientHeight + 1, box: `${Math.round(box.top)}–${Math.round(box.bottom)}`,
    };
}

async function checkMenus(page, cdp, d, tag, selector) {
    const triggers = page.locator(`${selector}:visible`);
    const n = await triggers.count();
    if (!n) return fail(`${tag}: no menu trigger ${selector}`);
    for (const idx of [...new Set([0, n - 1])]) {
        const trigger = triggers.nth(idx);
        await trigger.scrollIntoViewIfNeeded();
        const where = `${tag} ⋯#${idx}`;
        if (cdp) {
            // A real finger: the menu opens on touch-down, so the sheet can land under it; the release must not pick the item there.
            const b = await trigger.boundingBox();
            const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
            await page.waitForTimeout(80);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else await trigger.click();
        await page.waitForTimeout(450); // open animation + the release's click
        if (!await page.locator('.vh-menu[data-state="open"]').count() || await page.locator('[role="dialog"], [role="alertdialog"]').count()) {
            fail(`${where}: the tap that opened the menu also picked an item (or it never opened)`);
            await page.keyboard.press('Escape');
            continue;
        }
        const m = await page.evaluate(menuReach, d.safeArea ?? null);
        console.log(`  ${where}: ${m.count} items box=${m.box} sheet=${m.sheet} scrolls=${m.scrolls}`);
        if (!m.count) fail(`${where}: empty menu`);
        if (m.unreachable.length) fail(`${where}: items not reachable: ${m.unreachable.join(', ')}`);
        if (m.short.length) fail(`${where}: items under 44px on touch: ${m.short.join(', ')}`);
        const wantSheet = d.coarse && d.width <= 600;
        if (m.sheet !== wantSheet) fail(`${where}: expected ${wantSheet ? 'a bottom sheet' : 'a popover'} at ${d.width}px`);
        if (outDir) writeFileSync(join(outDir, `${tag}-${idx}.png`), await shot(page, cdp, d));
        await page.keyboard.press('Escape');
        await page.waitForSelector('.vh-menu[data-state="open"]', { state: 'detached', timeout: 5_000 }).catch(() => fail(`${where}: menu did not close on Escape`));
        await page.waitForTimeout(200);
    }
}

async function captureAll(browser) {
    for (const device of devices) {
        for (const theme of themes) {
            const { context, page, cdp, d, errors } = await openDevice(browser, device, theme);
            for (const name of pages) {
                const p = PAGES[name];
                if (!p) throw new Error(`unknown page ${name}`);
                await goto(page, typeof p.path === 'function' ? p.path(d) : p.path, p.url, p.ready);
                await assertCoarse(page, d, `${device}/${name}`);
                if (p.prepare) await prepare(page, p.prepare);
                const m = await page.evaluate(measure, d.safeArea ?? null);
                const tag = `${device}-${name}-${theme}`;
                console.log(`── ${tag} (${d.width}×${d.height}) overflowX=${m.overflowX} small=${m.smallTargets} shell="${m.shell}" back=${m.back ?? '-'}`);
                if (p.back && d.width < 600 && !m.back) fail(`${tag}: no back control at the top-left on a phone`);
                if (m.overflowX > 0) fail(`${tag}: document overflows horizontally by ${m.overflowX}px`);
                if (m.navHits.length) console.log(`  prompt nav: hits=${m.navHits.join(',')} overlaysUnder=${m.overlaysUnderNav}`);
                if (m.navHits.some((h) => h !== 'nav')) fail(`${tag}: a prompt-nav tap lands on ${m.navHits.filter((h) => h !== 'nav').join(', ')}`);
                if (m.outside.length) fail(`${tag}: outside viewport: ${m.outside.join(', ')}`);
                if (m.inInset.length) fail(`${tag}: controls under the safe-area inset: ${m.inInset.join(', ')}`);
                if (m.hoverOnly.length) fail(`${tag}: hover-only controls on a touch screen: ${m.hoverOnly.join(', ')}`);
                if (args.includes('--verbose') && m.smallSample.length) console.log(`  small: ${m.smallSample.join(' | ')}`);
                if (p.menus) await checkMenus(page, cdp, d, tag, p.menus);
                else if (outDir) writeFileSync(join(outDir, `${tag}.png`), await shot(page, cdp, d));
            }
            if (errors.length) fail(`${device}/${theme} pageerror: ${errors.join(' | ')}`);
            await context.close();
        }
    }
}

/** Resize like a fold/unfold: the viewport jumps; the page must not reload or drop state. */
async function foldRoundTrip(browser) {
    const folded = DEVICES['duo-folded'];
    const unfolded = DEVICES['duo-open-land'];
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
            const ctx = await openDevice(browser, start, 'light');
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
                // Medium touch screens keep the sidebar in a drawer behind the rail's first button.
                const rail = page.locator('.app-rail-btn[aria-expanded="false"]').first();
                if (await rail.count()) { await rail.click(); await page.waitForTimeout(400); }
                await page.locator('.sb-new-main, .sb-new-icon').first().click(); // desktop row / phone header ＋
                const item = page.getByRole('menuitem').first(); // the phone ＋ is a create menu
                if (await item.count()) await item.click();
                await page.waitForTimeout(600);
            }
            const dialogOpen = () => page.evaluate(() => !!document.querySelector('[role="dialog"]'));
            const boardOpen = () => page.evaluate(() => !!document.querySelector('.brf-panel, .brf-sheet'));
            const before = { dialog: await dialogOpen(), board: await boardOpen() };
            if (c.dialog && !before.dialog) fail(`${start}/${c.name}: dialog did not open`);
            // The dialog's own state must survive too, not just "a dialog is open".
            const dialogText = 'fold/path';
            const dialogInput = page.locator('[role="dialog"] input[type="text"], [role="dialog"] input:not([type])').first();
            if (c.dialog && await dialogInput.count()) await dialogInput.fill(dialogText);
            const other = start === 'duo-folded' ? unfolded : folded;
            const back = DEVICES[start];
            const tag = `${start}→${other === unfolded ? 'open' : 'folded'}→back ${c.name}`;
            for (const [step, d] of [['flip', other], ['back', back]]) {
                await resize(page, cdp, d);
                if (outDir) writeFileSync(join(outDir, `fold-${start}-${c.name.replace(/\W+/g, '_')}-${step}.png`), await shot(page, cdp, d));
                if (!await page.evaluate(() => window.__noReload === 1)) fail(`${tag}: page reloaded at ${step}`);
                // The 汇报板 changes home on the phone line (sheet ↔ aside); it must stay open, not stay a dialog.
                if (c.prepare === 'board') { if (!await boardOpen()) fail(`${tag}: board closed at ${step}`); }
                else if (before.dialog && !await dialogOpen()) fail(`${tag}: dialog closed at ${step}`);
                if (c.dialog && await dialogInput.inputValue().catch(() => null) !== dialogText) fail(`${tag}: dialog input lost at ${step}`);
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
            console.log(`── fold ${tag}: dialog=${before.dialog} board=${before.board} → board now=${await boardOpen()} scrollAnchor=${scrollBefore?.anchor ?? "-"} draft=${hasComposer}`);
            await context.close();
        }
    }
}

/** Medium touch screens: the sidebar is a rail + overlay drawer (appShellMode.ts). */
async function drawerChecks(browser) {
    const { page, context, errors } = await openDevice(browser, 'duo-open-land', 'light');
    await goto(page, '/session/dev-board');
    const isOpen = () => page.evaluate(() => !!document.querySelector('.app-sidebar--drawer.is-open'));
    const railBtn = page.locator('.app-rail-btn').first();
    const step = async (name, act, want) => {
        await act();
        await page.waitForTimeout(350);
        const got = await isOpen();
        if (got !== want) fail(`drawer ${name}: open=${got}, want ${want}`);
        else console.log(`── drawer ${name}: open=${got}`);
    };
    if (await isOpen()) fail('drawer: starts open (content-first expected)');
    await step('rail opens', () => railBtn.click(), true);
    await step('scrim closes', () => page.mouse.click(860, 300), false);
    await step('rail reopens', () => railBtn.click(), true);
    await step('Escape closes', () => page.keyboard.press('Escape'), false);
    await step('rail reopens', () => railBtn.click(), true);
    await step('sidebar collapse button closes', () => page.locator('.app-sidebar--drawer .sb-icon-btn[aria-label*="侧"], .app-sidebar--drawer .sb-icon-btn[aria-label*="idebar"]').last().click(), false);
    await step('rail reopens', () => railBtn.click(), true);
    // Sidebar rows link to the app's absolute routes (outside the harness), so drive an in-shell route change.
    await step('navigating closes', () => page.evaluate(() => {
        history.pushState({}, '', '/dev/device/projects/pj-pay');
        dispatchEvent(new PopStateEvent('popstate'));
    }), false);
    if (!await page.locator('.app-shell').count()) fail('drawer: shell gone after navigation');
    if (errors.length) fail(`drawer pageerror: ${errors.join(' | ')}`);
    await context.close();
}

const browser = await chromium.launch({ executablePath: exe });
try {
    if (args.includes('--fold')) { await foldRoundTrip(browser); await drawerChecks(browser); }
    else await captureAll(browser);
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
