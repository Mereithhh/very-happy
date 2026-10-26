#!/usr/bin/env node
/**
 * B-833: in 「只看我和负责人」 every text the lead writes in a member / system
 * turn stays on screen — mid-turn and while the turn is still running — and
 * the newest batch of member messages shows their text under its fold row
 * (6 lines + 「展开全文」 in place). Owner 10-26: 「折叠的成员消息还是会把一些
 * 文字给隐藏，特别是在最后一个的时候」. Runs against the vite dev server's
 * `/dev/lead-view` harness (real session page, seeded stores, no server).
 * Not part of CI — run by hand:
 *
 *   pnpm -C packages/happy-web-v2 exec vite --port 8799 --strictPort
 *   node packages/happy-web-v2/e2e/lead-view-text.mjs --base http://127.0.0.1:8799 [--out <dir>]
 *
 * Per device (phone 390×844 touch, desktop 1440×900) × theme (light, dark):
 *   1. the reader scrolls up a little (detached), then `__leadLive(1..7)` lands
 *      a member's long submission and the lead's live turn on it, one message
 *      every 400ms, and the turn ends; every rAF records each lead text's
 *      copies in the DOM and its offset in the transcript: each must appear
 *      while the turn is live, never disappear (no flash), never be doubled,
 *      and not move when the turn ends (live segments → the finished rows) —
 *      also for a reader following the live end (desktop · light · follow);
 *   2. the unseen badge counts the three lead texts, not the tools between them;
 *   3. the newest fold previews both member messages; the long one shows 6
 *      lines, 「展开全文」 renders it in full in place, 「收起」 folds it back;
 *   4. the fold row still opens and closes the folded run.
 * Screenshots: <out>/<device>-<theme>-{bottom,full}.png. Exit code 1 on any failed check.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const BASE = opt('base', 'http://127.0.0.1:8799');
const OUT = opt('out', null);
const DEVICES = {
    phone: { width: 390, height: 844, dpr: 3, coarse: true },
    desktop: { width: 1440, height: 900, dpr: 1, coarse: false },
};
const THEMES = opt('themes', 'light,dark').split(',');
const RUNS = [...Object.keys(DEVICES).flatMap((device) => THEMES.map((theme) => ({ device, theme, follow: false }))), { device: 'desktop', theme: 'light', follow: true }];
const LEAD_TEXTS = ['部署失败了，同意最小修法。', '已经让成员 A 按最小修法重推。', '重推成功，已经上线。'];
const STEPS = 7; // LIVE_TAIL in src/dev/leadSessionFixture.ts

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
if (OUT) mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: findChromium() });
for (const { device: name, theme, follow } of RUNS) {
    const d = DEVICES[name];
    console.log(`\n${name} · ${theme}${follow ? ' · follow' : ''}`);
    const context = await browser.newContext({
        viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.dpr, colorScheme: theme,
        hasTouch: d.coarse, locale: 'zh-CN', serviceWorkers: 'block',
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    if (d.coarse) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
    }
    const press = (sel) => (d.coarse ? page.tap(sel) : page.click(sel));
    await page.goto(`${BASE}/dev/lead-view/session/dev-lead`);
    await page.waitForSelector('.cl-inner .lv-fold', { timeout: 30_000 });
    await sleep(800);
    // Each lead text: first frame seen, and frames where it was gone after that.
    await page.evaluate((texts) => {
        const state = Object.fromEntries(texts.map((t) => [t, { seen: -1, gone: 0, doubled: 0, top: null }]));
        let frame = 0;
        const tick = () => {
            frame++;
            const inner = document.querySelector('.cl-inner');
            for (const t of texts) {
                const s = state[t];
                const hits = inner ? document.evaluate(`.//p[contains(., '${t}')]`, inner, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null) : null;
                const n = hits?.snapshotLength ?? 0;
                if (n > 1) s.doubled++;
                if (n > 0) {
                    if (s.seen < 0) s.seen = frame;
                    s.top = Math.round(hits.snapshotItem(0).getBoundingClientRect().top - inner.getBoundingClientRect().top);
                } else if (s.seen >= 0) s.gone++;
            }
            window.__flashRaf = requestAnimationFrame(tick);
        };
        window.__flash = state;
        tick();
    }, LEAD_TEXTS);
    await page.evaluate(() => window.__leadLive(1));
    await sleep(500);
    // Detach: the reader is a little above the live end (a follower stays at the bottom).
    if (!follow) await page.evaluate(() => { const el = document.querySelector('.cl-scroll'); el.scrollTop = el.scrollHeight - el.clientHeight - 400; el.dispatchEvent(new Event('scroll')); });
    await sleep(400);
    const liveSeen = [];
    for (let n = 2; n <= STEPS; n++) {
        await page.evaluate((k) => window.__leadLive(k, true), n);
        await sleep(400);
        liveSeen.push(await page.evaluate((texts) => texts.filter((t) => document.querySelector('.cl-inner').textContent.includes(t)).length, LEAD_TEXTS));
    }
    // The turn ends: its live segments become the finished turn's rows.
    const tops = () => page.evaluate(() => Object.fromEntries(Object.entries(window.__flash).map(([t, s]) => [t, s.top])));
    const beforeEnd = await tops();
    await page.evaluate((k) => window.__leadLive(k, false), STEPS);
    await sleep(1000);
    const afterEnd = await tops();
    const flash = await page.evaluate(() => { cancelAnimationFrame(window.__flashRaf); return window.__flash; });
    check(liveSeen.join(',') === '0,1,1,2,2,3', 'lead text shows while the turn is live', `texts on screen after steps 2–7: ${liveSeen.join(',')}`);
    check(LEAD_TEXTS.every((t) => flash[t].seen >= 0 && flash[t].gone === 0), 'no lead text ever disappears once shown (no flash)', JSON.stringify(flash));
    check(LEAD_TEXTS.every((t) => flash[t].doubled === 0), 'no lead text is ever on screen twice');
    check(JSON.stringify(beforeEnd) === JSON.stringify(afterEnd), 'the turn ending moves no lead text', `${JSON.stringify(beforeEnd)} → ${JSON.stringify(afterEnd)}`);
    if (!follow) {
        const badge = await page.evaluate(() => document.querySelector('.cl-jump-badge')?.textContent ?? null);
        check(badge === '3', 'unseen badge counts the 3 lead texts, not the tools', `badge=${badge}`);
    } else {
        const gap = await page.evaluate(() => { const el = document.querySelector('.cl-scroll'); return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight); });
        check(gap <= 2, 'a follower stays at the live end', `${gap}px from the bottom`);
        await context.close();
        continue;
    }

    // Back at the bottom: the newest fold previews its member messages.
    await page.evaluate(() => { const el = document.querySelector('.cl-scroll'); el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
    await sleep(500);
    const preview = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.lv-preview .team-message-card')];
        const long = cards.find((c) => c.textContent.includes('提交：PR 已开'));
        const more = long?.querySelector('.team-message-more');
        return {
            cards: cards.length,
            lines: long ? long.querySelectorAll('.msg-preview-line').length : 0,
            more: more?.textContent ?? null,
            moreH: more ? Math.round(more.getBoundingClientRect().height) : 0,
            previews: document.querySelectorAll('.lv-preview').length,
            overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
    });
    check(preview.previews === 1 && preview.cards === 2, 'only the newest fold previews, both member messages of the batch', JSON.stringify(preview));
    check(preview.lines === 6 && preview.more === '展开全文', 'the long submission shows 6 lines + 「展开全文」', `lines=${preview.lines} more=${preview.more}`);
    if (d.coarse) check(preview.moreH >= 44, '「展开全文」 is a 44px touch target', `${preview.moreH}px`);
    check(preview.overflowX === 0, 'no horizontal overflow', `${preview.overflowX}px`);
    if (OUT) await page.screenshot({ path: join(OUT, `${name}-${theme}-bottom.png`) });

    await press('.lv-preview .team-message-more');
    await sleep(300);
    const full = await page.evaluate(() => ({
        full: document.querySelector('.lv-preview .team-message-full')?.textContent ?? '',
        more: document.querySelector('.lv-preview .team-message-more')?.textContent ?? null,
        dialog: !!document.querySelector('[role="dialog"]'),
    }));
    check(full.full.includes('风险：只改 Web') && full.more === '收起' && !full.dialog, '「展开全文」 renders the whole text in place (no reader dialog)', JSON.stringify({ more: full.more, dialog: full.dialog }));
    if (OUT) {
        await page.evaluate(() => document.querySelector('.lv-preview .team-message-full')?.scrollIntoView({ block: 'center' }));
        await sleep(200);
        await page.screenshot({ path: join(OUT, `${name}-${theme}-full.png`) });
    }
    await press('.lv-preview .team-message-more');
    await sleep(300);
    const back = await page.evaluate(() => document.querySelectorAll('.lv-preview .team-message-card .msg-preview-line').length);
    check(back >= 6 && !(await page.$('.lv-preview .team-message-full')), '「收起」 folds it back to the preview');

    // The fold row still opens and closes the run (the preview gives way to the full rows).
    await page.evaluate(() => document.querySelector('.lv-preview').previousElementSibling.setAttribute('data-e2e-fold', ''));
    await press('[data-e2e-fold]');
    await sleep(300);
    const opened = await page.evaluate(() => ({ open: !!document.querySelector('.lv-fold--open'), previews: document.querySelectorAll('.lv-preview').length }));
    check(opened.open && opened.previews === 0, 'fold row expands the run', JSON.stringify(opened));
    await press('.lv-fold--open');
    await sleep(300);
    check(await page.evaluate(() => !document.querySelector('.lv-fold--open') && document.querySelectorAll('.lv-preview').length === 1), 'and collapses back to the preview');
    await context.close();
}
await browser.close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
