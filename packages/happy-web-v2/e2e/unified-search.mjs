#!/usr/bin/env node
/**
 * B-865: one search entry (Owner 11-02 「搜索入口需要 all in one」). Runs against
 * the vite dev server's `/dev/device#search` harness (the real AppLayout,
 * sidebar and ⌘K palette; `dev-machine` answers `history-search` in-page,
 * `dev-laptop` is offline). Not part of CI — run by hand:
 *
 *   pnpm -C packages/happy-web-v2 exec vite --port 8865 --strictPort
 *   node packages/happy-web-v2/e2e/unified-search.mjs --base http://127.0.0.1:8865 [--out <dir>]
 *
 * Per device (desktop 1440×900, phone 390×844 touch) × theme (light, dark) × locale (zh-CN, en-US):
 *   1. ⌘K (Ctrl+K here), ⌘⇧F (Ctrl+Shift+F) and the sidebar 🔍 open the same
 *      `.cp-panel` (no second search panel exists); on the phone it fills the screen;
 *   2. a word only a machine's transcript index holds lands in 「对话内容」 with a
 *      highlighted snippet, after a 「正在搜索 1 台机器」 state, with 「1 台机器离线」
 *      reported; typing it key by key sends ONE history-search;
 *   3. a query matching a session's title AND its messages shows that session
 *      once — in 「会话」, its snippets underneath — never again in 「对话内容」;
 *   4. ↑/↓ from the search box walks every group into 「对话内容」;
 *   5. the status chip: archived sessions are left out until 「含归档」; Esc closes
 *      the open menu first, the palette only on the next Esc;
 *   6. clicking a snippet opens the session with a jump to that message, and the
 *      jump lands it on screen mid-transcript;
 *   7. phone: close button, rows and snippets are ≥44px tall.
 * Screenshots: <out>/<device>-<theme>-<lang>-{content,dedup,filters,jump}.png. Exit 1 on a failed check.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const BASE = opt('base', 'http://127.0.0.1:8865');
const OUT = opt('out', null);
const DEVICES = {
    desktop: { width: 1440, height: 900, dpr: 1, coarse: false },
    phone: { width: 390, height: 844, dpr: 3, coarse: true },
};
const THEMES = opt('themes', 'light,dark').split(',');
const LANGS = opt('langs', 'zh-CN,en-US').split(',');
const ONLY_WORD = 'zebracorn';
const PROMPT_WORD = 'rollout-flag'; // an early prompt of `dev-search` (src/dev/searchSeed.ts)
const COPY = {
    'zh-CN': { title: '修复构建里的类型错误', jumpTitle: '支付回调重试', dedup: '类型错误', build: '构建', archived: '旧的构建实验', offline: '1 台机器离线', searching: '正在搜索 1 台机器', content: '对话内容', includeArchived: '含归档', search: '搜索' },
    'en-US': { title: 'Fix the type errors in the build', jumpTitle: 'Payment callback retries', dedup: 'type errors', build: 'build', archived: 'Old build experiment', offline: '1 machine offline', searching: 'Searching 1 machine', content: 'Conversation content', includeArchived: 'Include archived', search: 'Search' },
};

function findChromium() {
    for (const dir of [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]) {
        if (!existsSync(dir)) continue;
        for (const entry of readdirSync(dir).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
            for (const rel of ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
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
if (OUT) mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: findChromium() });
for (const [name, d] of Object.entries(DEVICES)) {
    for (const theme of THEMES) {
        for (const lang of LANGS) {
            const c = COPY[lang];
            console.log(`\n${name} · ${theme} · ${lang}`);
            const context = await browser.newContext({
                viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.dpr, colorScheme: theme,
                hasTouch: d.coarse, isMobile: d.coarse, locale: lang, serviceWorkers: 'block',
            });
            await context.addInitScript(() => {
                try {
                    localStorage.setItem('vh-pwa-install-never-v1', '1');
                } catch { /* ignore */ }
                // Every in-app navigation, so the sign-in redirect after it cannot hide it.
                window.__vhNavs = [];
                for (const fn of ['pushState', 'replaceState']) {
                    const orig = history[fn].bind(history);
                    history[fn] = (state, title, url) => { if (url) window.__vhNavs.push(String(url)); return orig(state, title, url); };
                }
            });
            const page = await context.newPage();
            page.on('pageerror', (e) => console.log('pageerror', e.message));
            const shot = async (tag) => { if (OUT) await page.screenshot({ path: join(OUT, `${name}-${theme}-${lang}-${tag}.png`) }); };
            await page.goto(`${BASE}/dev/device#search`, { waitUntil: 'domcontentloaded' });
            await page.locator('.sb-header').first().waitFor({ timeout: 30_000 });
            // Release notes / tips would cover the palette: dismiss whatever came up.
            await sleep(800);
            await page.keyboard.press('Escape');

            const panel = page.locator('.cp-panel');
            const input = page.locator('.cp-search-input');
            const closePalette = async () => { if (await panel.isVisible()) await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached', timeout: 3000 }); };

            // 1. three entries, one panel
            if (!d.coarse) {
                await page.keyboard.press('Control+k');
                await panel.waitFor({ timeout: 5000 });
                check(await input.evaluate((el) => el === document.activeElement), 'Ctrl+K opens the palette, search focused');
                await closePalette();
                await page.keyboard.press('Control+Shift+F');
                await panel.waitFor({ timeout: 5000 });
                check(await input.evaluate((el) => el === document.activeElement), 'Ctrl+Shift+F opens the same palette, search focused');
                check((await page.locator('.ss-panel').count()) === 0, 'no separate session-search panel exists');
                await closePalette();
            }
            const searchBtn = page.locator(`.sb-icon-btn[aria-label="${c.search}"]`).first();
            await searchBtn.click();
            await panel.waitFor({ timeout: 5000 });
            check((await page.locator('.cp-panel').count()) === 1 && (await page.locator('.ss-panel').count()) === 0, 'sidebar 🔍 opens the same .cp-panel');
            check((await page.locator('.cp-filters .cp-filter').count()) === 5, 'filter row: status, project, machine, agent, time');
            if (d.coarse) {
                const box = await panel.boundingBox();
                check(box && box.width >= d.width - 1 && box.height >= d.height - 2, 'phone: the palette fills the screen', JSON.stringify(box));
                const close = await page.locator('.cp-close').boundingBox();
                check(close && close.height >= 43.5 && close.width >= 43.5, 'phone: close button ≥44px', JSON.stringify(close));
            }

            // 2. content only a machine's index holds; one RPC for the whole word
            await page.evaluate(() => { window.__vhSearchCalls.length = 0; });
            await input.pressSequentially(ONLY_WORD, { delay: 40 });
            const status = page.locator('.cp-group--content .cp-group-status');
            await status.waitFor({ timeout: 3000 });
            const early = await status.textContent();
            check(early.includes(c.searching) && early.includes(c.offline), 'searching state + offline machine named while content is pending', early);
            const contentRow = page.locator('.cp-group--content .cp-row', { hasText: c.title });
            await contentRow.waitFor({ timeout: 5000 });
            check((await contentRow.locator('mark.cp-mark', { hasText: ONLY_WORD }).count()) === 1, '「对话内容」 row with the highlighted daemon snippet');
            check(await contentRow.evaluate((el) => el.classList.contains('is-active')), 'the arrived result takes the highlight from 「新建对话」 (Enter opens it)');
            const late = await status.textContent();
            check(late.includes(c.offline) && !late.includes(c.searching), 'offline machine still reported after the search finished', late);
            const calls = await page.evaluate(() => [...window.__vhSearchCalls]);
            check(calls.length === 1 && calls[0] === ONLY_WORD, 'typing debounced into one history-search', JSON.stringify(calls));
            if (d.coarse) {
                const sn = await contentRow.locator('.cp-snippet').first().boundingBox();
                const item = await contentRow.locator('.cp-item').boundingBox();
                check(sn && sn.height >= 43.5 && item && item.height >= 43.5, 'phone: row and snippet ≥44px', `${item?.height} / ${sn?.height}`);
            }
            await shot('content');

            // 4. keyboard walks into the content group
            const rowCount = await page.locator('.cp-row').count();
            let reached = false;
            for (let i = 0; i < rowCount; i++) {
                if (await page.locator('.cp-group--content .cp-row.is-active').count()) { reached = true; break; }
                await page.keyboard.press('ArrowDown');
            }
            check(reached, '↓ from the search box reaches 「对话内容」', `${rowCount} rows`);

            // 3. title + content match: one row
            await input.fill(c.dedup);
            const titleRow = page.locator('.cp-group--sessions .cp-row', { hasText: c.title });
            await titleRow.waitFor({ timeout: 5000 });
            await titleRow.locator('.cp-snippet').first().waitFor({ timeout: 5000 });
            await sleep(700); // the daemon answer (400 ms in-page) has landed
            const everywhere = await page.locator('.cp-row .cp-item-title', { hasText: c.title }).count();
            check(everywhere === 1, 'title + content hit: one row (「会话」, snippets under it)', `${everywhere} rows`);
            check((await page.locator('.cp-group--content .cp-row', { hasText: c.title }).count()) === 0, 'not repeated in 「对话内容」');
            await shot('dedup');

            // 5. status filter + Esc layering
            await input.fill(c.build);
            await page.locator('.cp-group--sessions').first().waitFor({ timeout: 5000 });
            await sleep(300);
            check((await page.locator('.cp-row', { hasText: c.archived }).count()) === 0, 'archived session left out by default');
            await page.locator('.cp-filters .cp-filter').first().click();
            await page.getByRole('option', { name: c.includeArchived }).click();
            const archivedRow = page.locator('.cp-row', { hasText: c.archived });
            await archivedRow.waitFor({ timeout: 3000 });
            check((await archivedRow.locator('.cp-badge').count()) === 1, '含归档 shows it, with the archived badge');
            check((await page.locator('.cp-filters-reset').count()) === 1, 'reset appears once a filter is set');
            await shot('filters');
            await page.locator('.cp-filters .cp-filter').first().click();
            await page.getByRole('option').first().waitFor();
            await page.keyboard.press('Escape');
            await sleep(150);
            check(await panel.isVisible() && (await page.getByRole('option').count()) === 0, 'Esc closes the open filter menu only');
            await input.focus();
            await page.keyboard.press('Escape');
            await panel.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
            check(!(await panel.isVisible()), 'the next Esc closes the palette');

            // 6. a snippet opens the session on that message
            await searchBtn.click();
            await panel.waitFor({ timeout: 5000 });
            await input.fill(PROMPT_WORD);
            const hitRow = page.locator('.cp-group--content .cp-row', { hasText: c.jumpTitle });
            await hitRow.waitFor({ timeout: 5000 });
            // The jump request the click makes (the harness exposes the app's chatJump module).
            await page.evaluate(() => {
                window.__vhNavs.length = 0;
                const jump = window.__vhChatJump;
                window.__vhJump = null;
                jump.onChatJumpRequest('dev-search', () => { window.__vhJump = jump.peekChatJump('dev-search'); });
            });
            await hitRow.locator('.cp-snippet').first().click();
            await sleep(300);
            const navs = await page.evaluate(() => [...window.__vhNavs]);
            check(navs[0] && /^\/session\/dev-search$/.test(new URL(navs[0], BASE).pathname), 'snippet click opens the session', JSON.stringify(navs));
            const req = await page.evaluate(() => window.__vhJump);
            check(!!req?.messageId && req.terms?.[0] === PROMPT_WORD, 'with a jump to the hit message', JSON.stringify(req));
            // The app's /session route needs a sign-in (the harness has none: it bounced to /login,
            // and the session page mounted on the way consumed the request). The harness renders the
            // same session page at /dev/device/session/:id — replay that exact request there.
            await page.evaluate((r) => {
                window.__vhDevNavigate('/dev/device/session/dev-search');
                window.__vhChatJump.requestChatJump('dev-search', r);
            }, req);
            // An anchored message is landed by scrolling it to the middle (B-766: no text highlight on it).
            const landed = await page.waitForFunction((id) => {
                const el = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
                const all = document.querySelectorAll('[data-message-id]');
                const last = all[all.length - 1];
                if (!el || !last || el === last) return false;
                const r = el.getBoundingClientRect();
                return r.top >= 0 && r.bottom <= innerHeight && last.getBoundingClientRect().top > innerHeight;
            }, req?.messageId ?? '', { timeout: 8000 }).then(() => true, () => false);
            check(landed, 'the session opens on the hit: that early prompt is on screen, the live end is not');
            await shot('jump');
            await context.close();
        }
    }
}
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
