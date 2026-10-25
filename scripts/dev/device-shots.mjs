#!/usr/bin/env node
/**
 * device-shots —— 在真实 Chromium 里按**设备预设**截 Web 主要页面，并量溢出 / 触控尺寸。
 *
 * 页面来自 DEV harness `/dev/device/*`（B-795）：真实 AppLayout（侧栏 / rail / 单栏切换）
 * 包着真实会话页（汇报板负责人会话）、团队页、项目页和设置页，数据全是本地示例；
 * `--pages secondary` 扫一遍其余二级页（B-796：手机上每页左上角都要有返回）；
 * `--pages overlays` 扫壳外浮层：更新弹窗、通知面板、各类 toast（B-796b：✕ 不得落进侧边 inset）。
 * `--pages offline` 断网（context.setOffline）后截「已离线，正在重连…」顶部细条和「已恢复」（B-799）：
 * 细条底边必须在壳内所有可见按钮的上方（不挡页头），文字不进侧边 inset。
 * `--pages outbox` 截一条上次页面留下、超过 10 分钟的未发消息：「未发送 · 重发 · 丢弃」（B-814）。
 * `--pages menus` 打开会话页 ⋯ 和侧栏首 / 末行 ⋯（B-798）：每个菜单项都要能滚进视口（扣掉 safe-area）
 * 并且点得到（elementFromPoint 命中该项），粗指针 ≤600px 必须是底部 sheet，更宽的是限高弹出菜单。
 * 所以先起 Web dev server（不需要后端）：
 *
 *   pnpm -C packages/happy-web-v2 exec vite --port 8795 --strictPort
 *   node scripts/dev/device-shots.mjs --base http://127.0.0.1:8795 --out <dir> \
 *        [--devices duo-folded,duo-open-land] [--pages session,board] [--themes light,dark]
 *   node scripts/dev/device-shots.mjs --base … --fold      # 折叠 ↔ 展开切换回归
 *   node scripts/dev/device-shots.mjs --base … --gestures  # 边缘手势：抽屉跟手开合 / standalone 返回 / 横滚排除（B-800）
 *   node scripts/dev/device-shots.mjs --base … --devices duo-folded-inset   # 外屏右侧状态列（B-796）
 *
 * 粗指针设备在 page 创建后用 CDP 打开原生触屏，并在每张截图后核验
 * `matchMedia('(pointer: coarse)')` 仍为真（见 dev skill：长页截图会重置触屏模拟）。
 * 截图只截真实视口。每张图同时打印：
 *   - overflowX：文档横向溢出像素（应为 0）
 *   - outside：右边缘越出视口的可见元素（应为空）
 *   - hoverOnly：触屏上占位却透明（只有 hover 才显示）的按钮（应为空）
 *   - inInset：带 safeArea 的预设下，落进侧边 inset（系统状态列）里的可点控件（应为空）
 *   - smallTargets：粗指针下实际命中区宽或高 < 44px 的可见按钮（B-798 起是门禁：不在 touchGate.mjs 的
 *     SMALL_TARGET_ALLOWLIST 里就失败；命中区用 elementFromPoint 从中心往外走，.vh-hit 等 ::after 热区计入、
 *     被遮挡/裁剪的部分不计；display:inline 的行内文字链接按 WCAG 2.5.8 例外放行）
 *   - hiddenActions：粗指针下有 aria-label、却排成 0×0 的按钮，而它所在的行在屏幕上（B-798：hover 才显示、
 *     触屏只能长按）。门禁，名单是 HIDDEN_ACTION_ALLOWLIST
 * `--fold` 在会话页、汇报板、团队页、项目页和新建对话弹窗上做 466×678 ↔ 890×626
 * 往返，断言弹窗（含输入内容）仍在、汇报板仍开、composer 草稿仍在、聊天滚动位置保持、
 * 没有整页重载；再验 890×626 的侧栏抽屉（rail 打开，遮罩 / Esc / 收起按钮 / 导航关闭）。
 * `--gestures`（B-800）用 CDP 原生触屏（Input.dispatchTouchEvent）逐帧拖动，断言：890×626 抽屉从左边缘右滑
 * 跟手打开（拖到一半抽屉位于半开处）、左滑关闭、慢拖不过阈值回弹、短促快滑按速度打开、浏览器下最外 16px 让给系统；
 * 390×844 手机会话页浏览器内边缘右滑不接管，standalone（navigator.standalone）下跟手出返回箭头并回到列表，
 * 在代码块 / 横向滚动区里横滑不触发。
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
    // B-799 (`--pages offline`): the top bar while offline, and 「已恢复」 right after.
    offline: { path: '/session/dev-plain', prepare: 'offline' },
    recovered: { path: '/session/dev-plain', prepare: 'recovered' },
    // B-804 (`--pages sync`): the messages catch-up — top 「同步中…」, the chat's bottom line, and a queued prompt the
    // wrapper took shown as 「执行中」 in the dock; `sync-slow` is the line past the deadline (「连接不稳定 · 重试」).
    sync: { path: '/session/dev-plain', prepare: 'sync' },
    'sync-slow': { path: '/session/dev-plain', prepare: 'sync-slow' },
    // B-814 (`--pages outbox`): a message restored from an earlier page load, past the 10-minute window — 「未发送 · 重发 / 丢弃」.
    outbox: { path: '/session/dev-plain', prepare: 'outbox' },
    // B-801: a 「新会话」 draft page (agent / machine / directory fields + composer; nothing spawned).
    draft: { path: '/session/dev-board#draft', ready: '[data-testid="draft-target"]' },
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
    // B-798 E: switch rows, row icon buttons and the usage range segmented (touch targets).
    'settings-notifications': '/settings/notifications', 'settings-snippets': '/settings/snippets',
    'settings-voice': '/settings/voice', 'settings-usage': '/settings/usage',
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
const GROUPS = { offline: ['offline', 'recovered'], sync: ['sync', 'sync-slow'], secondary: Object.keys(SECONDARY), overlays: Object.keys(OVERLAYS), menus: Object.keys(MENUS), touch: ['session', 'plain', 'prompt-nav', 'session-info', 'session-missing', 'draft'] };
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
const { SMALL_TARGET_ALLOWLIST, HIDDEN_ACTION_ALLOWLIST, notAllowed } = await import('./touchGate.mjs');
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
    await page.context().setOffline(false); // B-799: a previous `offline` capture
    await page.goto(`${base}${url ?? `/dev/device${path}`}`, { waitUntil: 'domcontentloaded' });
    // A hash-only change (`#toasts` after the same session path) does not reload the harness.
    if ((url ?? path).includes('#')) await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app-shell, .settings-workspace', { timeout: 20_000 });
    if (ready) await page.waitForSelector(ready, { timeout: 10_000 }).catch(() => fail(`${path}: ${ready} never appeared`));
    await page.waitForTimeout(900);
}

async function prepare(page, kind) {
    if (kind === 'offline' || kind === 'recovered') {
        await page.context().setOffline(true);
        await page.waitForSelector('.net-bar[data-net-phase="offline"]', { timeout: 8_000 });
        if (kind === 'recovered') {
            await page.context().setOffline(false);
            await page.waitForSelector('.net-bar[data-net-phase="recovered"]', { timeout: 8_000 });
        }
    } else if (kind === 'sync' || kind === 'sync-slow') {
        // Seeds the stores the real sync path drives (sync.ts → catchUpStatus / promptQueue). On a build
        // without B-804 the imports or fields are missing and the page shows what it showed before.
        // Queue texts follow --locale so the en captures don't show Chinese prompts.
        const en = locale.startsWith('en');
        const texts = en
            ? { queued: 'Run lint again and check for new warnings', dispatched: 'Run the unit tests once the type errors are fixed' }
            : { queued: '再跑一遍 lint，确认没有新的警告', dispatched: '把类型错误修完后跑一下单测' };
        await page.evaluate(async ({ slow, texts }) => {
            const sid = 'dev-plain';
            const { storage } = await import('/src/sync/storage.ts');
            const session = storage.getState().sessions[sid];
            const capabilities = [...(session.metadata?.capabilities ?? []), 'prompt-queue-v1'];
            storage.setState((s) => ({ sessions: { ...s.sessions, [sid]: { ...session, metadata: { ...session.metadata, capabilities } } } }));
            const { promptQueueStore } = await import('/src/sync/promptQueue.ts');
            promptQueueStore.setState((s) => ({ sessions: { ...s.sessions, [sid]: {
                status: 'ready',
                items: [{ id: 'q2', localId: 'l2', position: 1, text: texts.queued, modeMeta: {}, createdAt: Date.now() }],
                dispatched: [{ localId: 'l1', text: texts.dispatched }],
            } } }));
            try {
                const { networkStore } = await import('/src/sync/networkStatus.ts');
                const { catchUpStore } = await import('/src/sync/catchUpStatus.ts');
                networkStore.setState({ syncing: [`messages:${sid}`] });
                catchUpStore.setState({ sessions: { [sid]: slow ? 'slow' : 'syncing' } });
            } catch { /* before B-804 */ }
        }, { slow: kind === 'sync-slow', texts });
        await page.waitForTimeout(400);
    } else if (kind === 'outbox') {
        // The same storage path outbox adoption drives: an optimistic row marked sending, then a stale failure.
        const text = locale.startsWith('en') ? 'Then update the changelog for the build fix' : '然后把构建修复写进 changelog';
        await page.evaluate(async (text) => {
            const sid = 'dev-plain';
            const { storage } = await import('/src/sync/storage.ts');
            const localId = 'outbox-stale-1';
            storage.getState().applyMessages(sid, [{ role: 'user', id: localId, localId, createdAt: Date.now() - 25 * 60_000, isSidechain: false,
                content: { type: 'text', text } }], { sendingLocalIds: [localId] });
            storage.getState().applyOutboxResult(sid, { failures: [{ localId, restorable: false, stale: true }] });
        }, text);
        await page.waitForSelector('[data-send-state="stale"]', { timeout: 8_000 });
        await page.waitForTimeout(400);
    } else if (kind === 'board') {
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
    // The effective hit area: walk out from the centre with elementFromPoint while the point still lands on the
    // control (B-798 E: .vh-hit's centred ::after, negative-inset ::after, and anything covering or clipping it all count).
    const hitBox = (el, r) => {
        const owns = (x, y) => {
            if (x < 0 || y < 0 || x >= vw || y >= innerHeight) return false;
            const h = document.elementFromPoint(x, y);
            return !!h && (h === el || el.contains(h) || [...(el.labels ?? [])].some((l) => l.contains(h)));
        };
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (!owns(cx, cy)) return null; // covered (under a sheet, panel or scrim): not a target right now
        // A control cut by the viewport or by its scroller's edge (scrolled half into view) is not a small
        // target: the edge counts as reach.
        let clip = { left: 0, top: 0, right: vw, bottom: innerHeight };
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const cs = getComputedStyle(p);
            if (!/(auto|scroll|hidden|clip)/.test(cs.overflowX + cs.overflowY)) continue;
            const pr = p.getBoundingClientRect();
            clip = { left: Math.max(clip.left, pr.left), top: Math.max(clip.top, pr.top), right: Math.min(clip.right, pr.right), bottom: Math.min(clip.bottom, pr.bottom) };
        }
        const offscreen = (x, y) => x < clip.left || y < clip.top || x >= clip.right - 1 || y >= clip.bottom - 1;
        const reach = (dx, dy) => {
            let n = 0;
            while (n < 30) {
                const x = cx + dx * (n + 1), y = cy + dy * (n + 1);
                if (offscreen(x, y)) return 30;
                if (!owns(x, y)) break;
                n++;
            }
            return n;
        };
        return { width: reach(-1, 0) + reach(1, 0) + 1, height: reach(0, -1) + reach(0, 1) + 1 };
    };
    // Stable allowlist key: tag + first class, or tag + the nearest classed ancestor's first class.
    const firstClass = (el) => String(el.getAttribute('class') ?? '').trim().split(/\s+/)[0];
    const keyOf = (el) => {
        if (firstClass(el)) return `${el.tagName.toLowerCase()}.${firstClass(el)}`;
        let p = el.parentElement;
        while (p && !firstClass(p)) p = p.parentElement;
        return `${el.tagName.toLowerCase()}${p ? ` in .${firstClass(p)}` : ''}`;
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
            // WCAG 2.5.8 inline exception: a link or text button inside a sentence.
            if (getComputedStyle(el).display === 'inline') continue;
            const hit = hitBox(el, r);
            if (!hit || (hit.width >= 44 && hit.height >= 44)) continue;
            if (r.width < 44 || r.height < 44) smallTargets.push({ key: keyOf(el), text: `${label(el)} ${Math.round(r.width)}×${Math.round(r.height)} hit ${hit.width}×${hit.height}` });
        }
    }
    // B-798: labelled actions laid out as 0×0 (display:none until a hover touch never sends) inside a row that is on screen.
    const hiddenActions = [];
    if (matchMedia('(pointer: coarse)').matches) {
        for (const el of document.querySelectorAll('button[aria-label], [role="button"][aria-label]')) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) continue;
            if (el.closest('[aria-hidden="true"], [hidden], [inert], .app-sidebar--parked, .app-sidebar--drawer:not(.is-open)')) continue;
            let host = el.parentElement;
            for (let i = 0; host && i < 3; i++, host = host.parentElement) {
                const hr = host.getBoundingClientRect();
                if (hr.width > 0 && hr.height > 0) break;
            }
            const hr = host?.getBoundingClientRect();
            if (!hr || hr.width === 0 || hr.height === 0 || hr.bottom < 0 || hr.top > innerHeight || hr.right < 0 || hr.left > vw) continue;
            hiddenActions.push({ key: keyOf(el), text: label(el) });
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
    return { navHits, overlaysUnderNav, overflowX: doc.scrollWidth - doc.clientWidth, outside, hoverOnly, inInset, back: back ? `${Math.round(back.left)},${Math.round(back.top)}` : null, smallTargets, hiddenActions, shell: document.querySelector('.app-shell')?.className ?? null };
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
                if (p.prepare === 'offline' || p.prepare === 'recovered') {
                    // B-799: the bar has its own row — no visible shell button may start above its bottom edge,
                    // and its text stays clear of the side insets.
                    const nb = await page.evaluate((sa) => {
                        const bar = document.querySelector('.net-bar');
                        if (!bar) return null;
                        const r = bar.getBoundingClientRect();
                        const text = bar.querySelector('span').getBoundingClientRect();
                        // The on-screen part of a button: clipped by every scrolling / overflow-hidden ancestor
                        // (chat rows scrolled out of the list are not "under the bar").
                        const shown = (el) => {
                            let { top, bottom, left, right } = el.getBoundingClientRect();
                            for (let a = el.parentElement; a && bottom > top && right > left; a = a.parentElement) {
                                const cs = getComputedStyle(a);
                                if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
                                const ar = a.getBoundingClientRect();
                                top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom);
                                left = Math.max(left, ar.left); right = Math.min(right, ar.right);
                            }
                            return bottom > top && right > left ? { top, bottom } : null;
                        };
                        const covered = [...document.querySelectorAll('.app-shell button')].filter((b) => {
                            if (getComputedStyle(b).visibility === 'hidden') return false;
                            const v = shown(b);
                            return v !== null && v.top < r.bottom - 0.5 && v.bottom > 0;
                        }).map((b) => b.getAttribute('aria-label') || b.textContent.trim().slice(0, 20));
                        const headerTop = Math.min(...[...document.querySelectorAll('.app-shell button')].map(shown).filter(Boolean).map((v) => v.top));
                        const left = sa?.left ?? 0, right = innerWidth - (sa?.right ?? 0);
                        return { bottom: r.bottom, firstButtonTop: headerTop, covered, textInInset: text.left < left || text.right > right, phase: bar.dataset.netPhase, label: bar.textContent };
                    }, d.safeArea ?? null);
                    console.log(`  net bar: ${JSON.stringify(nb)}`);
                    if (!nb) fail(`${tag}: no net bar`);
                    else {
                        if (nb.covered.length) fail(`${tag}: net bar covers shell buttons: ${nb.covered.join(', ')}`);
                        if (nb.textInInset) fail(`${tag}: net bar text runs into the side inset`);
                    }
                }
                console.log(`── ${tag} (${d.width}×${d.height}) overflowX=${m.overflowX} small=${m.smallTargets.length} shell="${m.shell}" back=${m.back ?? '-'}`);
                if (p.back && d.width < 600 && !m.back) fail(`${tag}: no back control at the top-left on a phone`);
                if (m.overflowX > 0) fail(`${tag}: document overflows horizontally by ${m.overflowX}px`);
                if (m.navHits.length) console.log(`  prompt nav: hits=${m.navHits.join(',')} overlaysUnder=${m.overlaysUnderNav}`);
                if (m.navHits.some((h) => h !== 'nav')) fail(`${tag}: a prompt-nav tap lands on ${m.navHits.filter((h) => h !== 'nav').join(', ')}`);
                if (m.outside.length) fail(`${tag}: outside viewport: ${m.outside.join(', ')}`);
                if (m.inInset.length) fail(`${tag}: controls under the safe-area inset: ${m.inInset.join(', ')}`);
                if (m.hoverOnly.length) fail(`${tag}: hover-only controls on a touch screen: ${m.hoverOnly.join(', ')}`);
                if (args.includes('--verbose') && m.smallTargets.length) console.log(`  small: ${m.smallTargets.map(t => `${t.text} (${t.key})`).join(' | ')}`);
                const small = notAllowed(m.smallTargets, SMALL_TARGET_ALLOWLIST);
                if (small.length) fail(`${tag}: touch targets under 44px (not in SMALL_TARGET_ALLOWLIST): ${small.map(t => `${t.text} (${t.key})`).join(', ')}`);
                const hidden = notAllowed(m.hiddenActions, HIDDEN_ACTION_ALLOWLIST);
                if (hidden.length) fail(`${tag}: labelled actions laid out 0×0 on touch (long-press only?): ${hidden.map(t => `${t.text} (${t.key})`).join(', ')}`);
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

/**
 * B-800 edge gestures, driven by native CDP touch events one frame at a time. Each event carries an
 * explicit `timestamp` (`frameMs` apart) — the gesture reads `timeStamp` for velocity, and the CDP
 * round-trip jitter of a loaded runner would otherwise turn a flick into a slow drag.
 */
async function drag(cdp, page, from, to, { steps = 12, frameMs = 16, onMid } = {}) {
    const at = (p) => [{ x: p.x, y: p.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
    // +1 s: a timestamp already in the past makes Chromium drop the later events of the stroke.
    const t0 = Date.now() / 1000 + 1;
    const ts = (i) => t0 + (i * frameMs) / 1000;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from), timestamp: ts(0) });
    for (let i = 1; i <= steps; i++) {
        const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
        await page.waitForTimeout(frameMs);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(p), timestamp: ts(i) });
        if (i === Math.round(steps / 2) && onMid) await onMid();
    }
    await page.waitForTimeout(frameMs);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: ts(steps + 1) });
    await page.waitForTimeout(450);
}

async function gestureChecks(browser) {
    const check = (name, ok, detail = '') => (ok ? console.log(`── gesture ${name}: ok ${detail}`) : fail(`gesture ${name} ${detail}`));

    // ── drawer shell (unfolded Duo, browser tab) ──
    {
        const { page, cdp, context, errors } = await openDevice(browser, 'duo-open-land', 'light');
        await goto(page, '/session/dev-board');
        const isOpen = () => page.evaluate(() => !!document.querySelector('.app-sidebar--drawer.is-open'));
        const y = 300;
        let mid = null;
        await drag(cdp, page, { x: 24, y }, { x: 360, y: y + 8 }, {
            steps: 20, frameMs: 30,
            onMid: async () => {
                mid = await page.evaluate(() => { const a = document.querySelector('.app-sidebar--drawer'); return { ml: parseFloat(a.style.marginLeft), w: a.offsetWidth, scrim: Number(document.querySelector('.app-drawer-scrim').style.opacity) }; });
                if (outDir) writeFileSync(join(outDir, 'gesture-drawer-mid.png'), await shot(page, cdp, DEVICES['duo-open-land']));
            },
        });
        check('drawer follows the finger', mid && mid.ml > -mid.w && mid.ml < 0 && mid.scrim > 0 && mid.scrim < 1, JSON.stringify(mid));
        if (outDir) writeFileSync(join(outDir, 'gesture-drawer-open.png'), await shot(page, cdp, DEVICES['duo-open-land']));
        check('edge swipe right opens the drawer', await isOpen());
        check('inline drag styles cleared after release', await page.evaluate(() => document.querySelector('.app-sidebar--drawer').style.marginLeft === ''));
        await drag(cdp, page, { x: 220, y }, { x: 20, y: y - 6 }, { steps: 14, frameMs: 30 });
        check('swipe left on the drawer closes it', !await isOpen());
        await drag(cdp, page, { x: 24, y }, { x: 84, y }, { steps: 20, frameMs: 40 });
        check('a short slow drag snaps back closed', !await isOpen());
        await drag(cdp, page, { x: 24, y }, { x: 120, y }, { steps: 3, frameMs: 8 });
        check('a short fast flick opens it', await isOpen());
        await drag(cdp, page, { x: 220, y }, { x: 140, y }, { steps: 20, frameMs: 40 });
        check('a short slow drag on the open drawer snaps back open', await isOpen());
        await drag(cdp, page, { x: 220, y }, { x: 230, y: y + 200 }, { steps: 12, frameMs: 20 });
        check('a vertical stroke on the drawer (list scroll) leaves it open', await isOpen());
        // A slow runner can turn that stroke into a row long-press: its menu (not the scrim) takes the next tap.
        if (await page.locator('.vh-menu[data-state="open"]').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
        await page.mouse.click(860, 300);
        await page.waitForTimeout(400);
        check('scrim tap closes it', !await isOpen());
        await drag(cdp, page, { x: 6, y }, { x: 360, y }, { steps: 20, frameMs: 30 });
        check('browser tab: the outermost strip stays the browser\'s', !await isOpen());
        await drag(cdp, page, { x: 30, y: 200 }, { x: 30, y: 500 }, { steps: 12, frameMs: 20 });
        check('a vertical stroke from the rail does not open it', !await isOpen());
        if (errors.length) fail(`gesture drawer pageerror: ${errors.join(' | ')}`);
        await context.close();
    }

    // ── drawer with a 47px left inset (landscape notch) + reduced motion ──
    {
        const { page, cdp, context, errors } = await openDevice(browser, 'duo-open-land', 'dark');
        await context.addInitScript(simulateSafeArea, { top: 0, right: 0, bottom: 0, left: 47 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await goto(page, '/session/dev-board');
        const isOpen = () => page.evaluate(() => !!document.querySelector('.app-sidebar--drawer.is-open'));
        await drag(cdp, page, { x: 8, y: 300 }, { x: 360, y: 300 }, { steps: 20, frameMs: 30 });
        check('inset 47: a browser-strip start (x=8) stays the browser\'s', !await isOpen());
        await drag(cdp, page, { x: 60, y: 300 }, { x: 360, y: 300 }, { steps: 20, frameMs: 30 });
        check('inset 47: a start on the rail past the inset opens', await isOpen());
        const dur = await page.evaluate(() => [getComputedStyle(document.querySelector('.app-sidebar--drawer')).transitionDuration, getComputedStyle(document.querySelector('.app-drawer-scrim')).transitionDuration]);
        check('reduced motion: drawer and scrim settle without a transition', dur.every((d) => d.split(',').every((x) => parseFloat(x) === 0)), dur.join(' / '));
        if (outDir) writeFileSync(join(outDir, 'gesture-drawer-inset-dark.png'), await shot(page, cdp, DEVICES['duo-open-land']));
        if (errors.length) fail(`gesture inset pageerror: ${errors.join(' | ')}`);
        await context.close();
    }

    // ── phone: session page, browser tab vs standalone ──
    for (const standalone of [false, true]) {
        const { page, cdp, context, errors } = await openDevice(browser, 'phone', 'light');
        if (standalone) await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true }));
        await goto(page, '');
        const open = async () => {
            await page.evaluate(() => window.__vhDevNavigate('/dev/device/session/dev-plain'));
            await page.waitForSelector('.app-detail .cl-scroll', { timeout: 15_000 });
            await page.waitForTimeout(600);
        };
        await open();
        const path = () => page.evaluate(() => location.pathname);
        const tag = standalone ? 'standalone' : 'browser';
        let cue = null;
        await drag(cdp, page, { x: 6, y: 420 }, { x: 200, y: 428 }, {
            steps: 16, frameMs: 30,
            onMid: async () => {
                cue = await page.evaluate(() => { const c = document.querySelector('.vh-edge-back'); return c ? Number(c.style.getPropertyValue('--edge-progress')) : null; });
                if (outDir && standalone) writeFileSync(join(outDir, 'gesture-back-cue.png'), await shot(page, cdp, DEVICES.phone));
            },
        });
        if (standalone) {
            check(`${tag}: back cue follows the finger`, cue !== null && cue > 0, `progress=${cue}`);
            check(`${tag}: edge swipe right = back to the list`, await path() === '/dev/device', await path());
            check(`${tag}: cue removed after release`, !await page.locator('.vh-edge-back').count());
            for (const [what, html] of [
                ['code block', '<pre style="margin:0;padding:24px 8px;overflow-x:auto;white-space:pre">' + 'const x = 1; '.repeat(40) + '</pre>'],
                ['horizontal scroller', '<div style="overflow-x:auto"><div style="width:2000px;height:60px">wide</div></div>'],
            ]) {
                await open();
                await page.evaluate((h) => {
                    const el = document.createElement('div');
                    el.id = 'gesture-hscroll';
                    el.style.cssText = 'position:fixed;left:0;top:380px;width:300px;z-index:5000;background:var(--bg-2)';
                    el.innerHTML = h;
                    document.querySelector('.app-detail').appendChild(el);
                }, html);
                await drag(cdp, page, { x: 6, y: 410 }, { x: 220, y: 412 }, { steps: 16, frameMs: 30 });
                check(`${tag}: swiping inside a ${what} does not go back`, await path() === '/dev/device/session/dev-plain', await path());
            }
            await page.evaluate(() => document.getElementById('gesture-hscroll')?.remove());
            await drag(cdp, page, { x: 6, y: 300 }, { x: 40, y: 600 }, { steps: 12, frameMs: 20 });
            check(`${tag}: a vertical stroke from the edge does not go back`, await path() === '/dev/device/session/dev-plain');
            await drag(cdp, page, { x: 60, y: 420 }, { x: 300, y: 420 }, { steps: 16, frameMs: 30 });
            check(`${tag}: a swipe away from the edge does not go back`, await path() === '/dev/device/session/dev-plain');
        } else {
            check(`${tag}: no cue (the browser owns the edge)`, cue === null);
            check(`${tag}: edge swipe right is not taken over`, await path() === '/dev/device/session/dev-plain', await path());
        }
        if (errors.length) fail(`gesture ${tag} pageerror: ${errors.join(' | ')}`);
        await context.close();
    }
}

const browser = await chromium.launch({ executablePath: exe });
try {
    if (args.includes('--gestures')) await gestureChecks(browser);
    else if (args.includes('--fold')) { await foldRoundTrip(browser); await drawerChecks(browser); }
    else await captureAll(browser);
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
