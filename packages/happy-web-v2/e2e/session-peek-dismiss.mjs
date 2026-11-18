#!/usr/bin/env node
/**
 * B-941 — the sidebar's hover preview (B-588 SessionPeek) must never stay up
 * once the pointer is no longer on its row. End to end against a local
 * standalone server, Chromium and WebKit; not part of CI — run by hand:
 *
 *   DATA_DIR=<tmp> PORT=5390 pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts migrate
 *   DATA_DIR=<tmp> PORT=5390 SIGNUP_MODE=open pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts serve
 *   VH_SERVER_URL=http://127.0.0.1:5390 pnpm -C packages/happy-web-v2 exec vite --port 5391 --strictPort
 *   node packages/happy-web-v2/e2e/session-peek-dismiss.mjs --base http://127.0.0.1:5391 --server http://127.0.0.1:5390 \
 *     [--browser chromium|webkit] [--out <dir>] [--expect stuck|closed]
 *
 * Every scenario opens the hover preview the real way (mouse rests on a row
 * 600ms+), then does ONE thing that does not pass through the row's
 * pointerleave, and reports whether the preview is still up and whether the
 * pointer is still on its row:
 *   TIP        the one-time 「会话预览」 feature tip: its ✕ closes it, a reload does not bring it back
 *   WHEEL      wheel-scroll the list under a resting pointer
 *   SCROLLJS   the list scrolls by itself (scrollbar / keyboard / momentum)
 *   MISSEDLEAVE the row's pointerleave is lost, then the pointer goes to the main pane (and clicks)
 *   DOMMOVE    the hovered row's node is detached + reinserted (a keyed reorder), then the pointer leaves
 *   ESC        Escape pressed while the pointer rests on the row
 *   ESC-INPUT  …with focus in a session's composer: it still receives an Escape nobody default-prevented
 *   CLICKOUT   a click outside the row, made without moving the pointer first
 *              (a second pointer device / a programmatic click elsewhere)
 *   BLUR       window blur + page hidden (⌘Tab / switching tabs)
 *   LEAVEWIN   the pointer leaves the browser window straight from the row
 *   EXPLICIT   menu 「预览」 → Esc closes, outside click closes, clicking the row closes
 * `--expect stuck` (before the fix) exits 0 when at least one scenario leaves the
 * preview up; `--expect closed` (default, after the fix) exits 1 on any one.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium, webkit } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const BASE = opt('base', 'http://127.0.0.1:5391');
const SERVER = opt('server', 'http://127.0.0.1:5390');
const BROWSER = opt('browser', 'chromium');
const OUT = opt('out', null);
const EXPECT = opt('expect', 'closed');
const SESSIONS = Number(opt('sessions', '40'));
if (OUT) mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const browser = BROWSER === 'webkit' ? await webkit.launch() : await chromium.launch({ executablePath: findChromium() });
const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, locale: 'zh-CN', serviceWorkers: 'block' });
// Block anything that is not this local stack (a test build must never talk to production).
await context.route((url) => !url.href.startsWith(BASE) && !url.href.startsWith(SERVER) && !url.href.startsWith('ws'), (r) => r.abort());
await context.addInitScript(() => {
    try {
        localStorage.setItem('vh-pwa-install-never-v1', '1');
    } catch { /* ignore */ }
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));

async function signUp() {
    const username = `peek${randomBytes(4).toString('hex')}`;
    await page.goto(`${BASE}/signup`);
    const toggle = page.locator('.auth-method-toggle');
    await page.locator('input[autocomplete="username"]').or(toggle).first().waitFor({ timeout: 60_000 });
    const usernameInput = page.locator('input[autocomplete="username"]');
    if (!(await usernameInput.isVisible())) await usernameInput.waitFor({ timeout: 1_500 }).catch(() => toggle.click());
    await usernameInput.fill(username);
    const pw = `pw-${randomBytes(6).toString('hex')}`;
    const pws = page.locator('input[autocomplete="new-password"]');
    await pws.nth(0).fill(pw);
    await pws.nth(1).fill(pw);
    await page.locator('form.auth-password-form button[type="submit"]').click();
    await page.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 60_000, polling: 300 });
}

function createSessions(n) {
    return page.evaluate(async (n) => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const { encodeBase64 } = await import('/src/encryption/base64.ts');
        for (let i = 0; i < 150 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
        const ids = [];
        for (let i = 0; i < n; i++) {
            const enc = await sync.encryption.openEncryption(null);
            const [metadata] = await enc.encrypt([{ path: `/tmp/peek/s-${i}`, host: 'e2e', flavor: 'claude', summary: { text: `peek ${i}`, updatedAt: Date.now() } }]);
            const res = await apiSocket.request('/v1/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState: null, dataEncryptionKey: null }),
            });
            if (!res.ok) throw new Error(`seed POST ${res.status}`);
            ids.push((await res.json()).session.id);
        }
        return ids;
    }, n);
}

async function dismissDialogs() {
    await page.locator('.wn-card').waitFor({ timeout: 2_000 }).catch(() => {});
    for (const name of ['知道了', '暂不', 'Got it', 'Not now']) {
        for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 1_000 }).catch(() => {});
    }
}

/** What the page shows right now: the hover preview, the row it belongs to, the row under the pointer. */
const state = (pt) => page.evaluate(({ x, y }) => {
    const peek = document.querySelector('.sb-peek');
    const peekId = peek?.id?.replace(/^sb-peek-/, '') ?? null;
    const under = document.elementFromPoint(x, y)?.closest('.sb-row');
    const underHref = under?.querySelector('[data-href]')?.getAttribute('data-href') ?? null;
    const peekRow = peekId ? [...document.querySelectorAll('.sb-row')].find((r) => r.querySelector('[data-href]')?.getAttribute('data-href')?.includes(peekId)) : null;
    const pr = peek?.getBoundingClientRect();
    const rr = peekRow?.getBoundingClientRect();
    return {
        peek: peek ? (peek.classList.contains('sb-peek--hover') ? 'hover' : 'explicit') : null,
        peekId,
        pointerOnItsRow: !!peekId && !!underHref?.includes(peekId),
        peekTop: pr ? Math.round(pr.top) : null,
        rowTop: rr ? Math.round(rr.top) : null,
    };
}, pt);

const rows = () => page.locator('.sb-row:has([data-href^="/session/"])');
async function hoverRow(i) {
    await page.evaluate(() => { const l = document.querySelector('.sb-scroll'); if (l) l.scrollTop = 0; });
    await sleep(200);
    const box = await rows().nth(i).boundingBox();
    const pt = { x: Math.round(box.x + box.width / 2 - 30), y: Math.round(box.y + box.height / 2) };
    await page.mouse.move(5, 5);
    await sleep(100);
    await page.mouse.move(pt.x, pt.y, { steps: 4 });
    const opened = await page.waitForSelector('.sb-peek--hover', { timeout: 3_000 }).then(() => true, () => false);
    if (!opened) {
        await shot(`hover-${i}-did-not-open`);
        throw new Error(`hover on row ${i} did not open the preview: ${JSON.stringify(await state(pt))}`);
    }
    return pt;
}
async function reset() {
    await page.keyboard.press('Escape').catch(() => {});
    await page.mouse.move(900, 400, { steps: 3 });
    await page.mouse.move(905, 400);
    await page.evaluate(() => { const l = document.querySelector('.sb-row')?.closest('.sb-scroll, .sb-list, [class*="scroll"]'); if (l) l.scrollTop = 0; });
    await sleep(300);
}
const shot = async (name) => { if (OUT) await page.screenshot({ path: join(OUT, `${BROWSER}-${name}.png`) }); };

const results = [];
function record(name, s, note = '') {
    const stuck = !!s.peek && !s.pointerOnItsRow;
    results.push({ name, stuck, ...s, note });
    console.log(`${stuck ? '  ✗ STUCK ' : '  ✓ ok    '} ${name.padEnd(10)} peek=${s.peek ?? '-'} pointerOnItsRow=${s.pointerOnItsRow} peekTop=${s.peekTop} rowTop=${s.rowTop}${note ? ` — ${note}` : ''}`);
}

try {
    console.log(`[${BROWSER}] sign up + seed ${SESSIONS} sessions`);
    await signUp();
    const ids = await createSessions(SESSIONS);
    await page.goto(`${BASE}/`);
    await page.waitForFunction((n) => document.querySelectorAll('.sb-row [data-href^="/session/"]').length >= n, Math.min(SESSIONS, 20), { timeout: 60_000 });
    await dismissDialogs();
    // TIP: the one-time 「会话预览」 tip (first row). The earlier tips are marked seen so this one is next.
    await page.evaluate(() => localStorage.setItem('vh.featureTips.seen.v1', JSON.stringify(['quick-open@1', 'prompt-rail@1', 'review-all@1'])));
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.sb-row [data-href^="/session/"]');
    const tipShown = await page.waitForSelector('.vh-tip', { timeout: 8_000 }).then(() => true, () => false);
    const tipText = tipShown ? await page.locator('.vh-tip-text').textContent() : '';
    await shot('tip');
    if (tipShown) await page.locator('.vh-tip-close').click();
    await sleep(300);
    const tipGone = !(await page.$('.vh-tip'));
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.sb-row [data-href^="/session/"]');
    await sleep(5_000);
    const tipBack = !!(await page.$('.vh-tip'));
    console.log(`  TIP shown=${tipShown} (${tipText}) closeButtonCloses=${tipGone} backAfterReload=${tipBack}`);
    results.push({ name: 'TIP', stuck: !(tipShown && tipGone && !tipBack) });
    await dismissDialogs();

    const scroller = await page.evaluate(() => {
        let el = document.querySelector('.sb-row');
        while (el && el !== document.body) { const cs = getComputedStyle(el); if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) return el.className; el = el.parentElement; }
        return null;
    });
    console.log(`  list scroller: ${scroller}`);

    // BASE: hover opens, leaving closes.
    let pt = await hoverRow(2);
    let s = await state(pt);
    console.log(`  BASE hover opened: ${s.peek}`);
    await page.mouse.move(900, 400, { steps: 3 });
    await sleep(200);
    console.log(`  BASE after leave: ${(await state(pt)).peek}`);

    // WHEEL
    pt = await hoverRow(3);
    await page.mouse.wheel(0, 360);
    await sleep(600);
    s = await state(pt);
    record('WHEEL', s, 'pointer still, list wheel-scrolled 360px');
    await shot('wheel');
    await reset();

    // SCROLLJS
    pt = await hoverRow(3);
    await page.evaluate(() => { let el = document.querySelector('.sb-row'); while (el && !(/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight)) el = el.parentElement; if (el) el.scrollTop += 300; });
    await sleep(600);
    s = await state(pt);
    record('SCROLLJS', s, 'list scrolled 300px without a wheel event');
    await shot('scrolljs');
    await reset();

    // MISSEDLEAVE: a pointerleave that never reaches the row (blocked here; in the wild: a row node
    // moved under a resting pointer, an OS window over the browser, a missed boundary event) — then the
    // pointer goes elsewhere. Before B-941 nothing else could close the preview.
    pt = await hoverRow(3);
    await page.evaluate(() => { window.__b941Block = (e) => e.stopImmediatePropagation(); for (const t of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) window.addEventListener(t, window.__b941Block, true); });
    await page.mouse.move(900, 400, { steps: 5 });
    await sleep(400);
    s = await state({ x: 900, y: 400 });
    record('MISSEDLEAVE', s, 'row never got its pointerleave; pointer moved to the main pane');
    await shot('missedleave');
    await page.mouse.move(700, 300, { steps: 5 });
    await page.mouse.click(700, 300);
    await sleep(300);
    s = await state({ x: 700, y: 300 });
    record('MISSED+CLK', s, '…and clicked in the main pane');
    await page.evaluate(() => { for (const t of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) window.removeEventListener(t, window.__b941Block, true); });
    await reset();

    // DOMMOVE: the same thing without the app — the hovered row's node is detached and put back in place
    // (what React's keyed reorder does to every row it moves), then the pointer leaves.
    pt = await hoverRow(3);
    await page.evaluate(({ x, y }) => { const row = document.elementFromPoint(x, y).closest('.sb-row'); const p = row.parentNode; const next = row.nextSibling; p.removeChild(row); p.insertBefore(row, next); }, pt);
    await sleep(200);
    await page.mouse.move(900, 400, { steps: 5 });
    await sleep(400);
    s = await state({ x: 900, y: 400 });
    record('DOMMOVE', s, 'hovered row node detached + reinserted, then the pointer left the sidebar');
    await shot('dommove-left');
    await reset();

    // ESC
    pt = await hoverRow(2);
    await page.keyboard.press('Escape');
    await sleep(300);
    s = await state(pt);
    results.push({ name: 'ESC', stuck: !!s.peek, ...s });
    console.log(`  ${s.peek ? '✗ OPEN  ' : '✓ closed'} ESC        peek=${s.peek ?? '-'} (Esc with the pointer on the row)`);
    await shot('esc');
    await reset();

    // ESC-INPUT: focus in the composer of an open session, pointer resting on a row, Esc —
    // the preview closes AND the composer still gets an Escape nobody default-prevented (#515).
    await rows().nth(0).locator('[data-href]').click();
    const composer = page.locator('textarea').first();
    await composer.waitFor({ timeout: 15_000 });
    await composer.click();
    await page.evaluate(() => { window.__b941Esc = null; document.querySelector('textarea').addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__b941Esc = { prevented: e.defaultPrevented, active: document.activeElement?.tagName }; }); });
    pt = await hoverRow(2);
    await page.keyboard.press('Escape');
    await sleep(300);
    s = await state(pt);
    const escSeen = await page.evaluate(() => window.__b941Esc);
    results.push({ name: 'ESC-INPUT', stuck: !!s.peek || !escSeen || escSeen.prevented });
    console.log(`  ${s.peek ? '✗ OPEN  ' : '✓ closed'} ESC-INPUT  peek=${s.peek ?? '-'} composerGotEsc=${JSON.stringify(escSeen)}`);
    await shot('esc-input');
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.sb-row [data-href^="/session/"]');
    await reset();

    // CLICKOUT: a click elsewhere without a pointer move (programmatic / other device).
    pt = await hoverRow(2);
    await page.evaluate(() => { const t = document.querySelector('main, .app-main, body'); for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) t.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, clientX: 900, clientY: 400 })); });
    await sleep(300);
    s = await state(pt);
    results.push({ name: 'CLICKOUT', stuck: !!s.peek, ...s });
    console.log(`  ${s.peek ? '✗ OPEN  ' : '✓ closed'} CLICKOUT   peek=${s.peek ?? '-'}`);
    await reset();

    // BLUR: ⌘Tab / switching tab — blur + hidden, the pointer never "leaves".
    pt = await hoverRow(2);
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        window.dispatchEvent(new Event('blur'));
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(300);
    s = await state(pt);
    results.push({ name: 'BLUR', stuck: !!s.peek, ...s });
    console.log(`  ${s.peek ? '✗ OPEN  ' : '✓ closed'} BLUR       peek=${s.peek ?? '-'}`);
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
    });
    await reset();

    // LEAVEWIN: the pointer leaves the browser window straight from the row.
    pt = await hoverRow(2);
    await page.mouse.move(-20, pt.y, { steps: 2 });
    await sleep(300);
    s = await state(pt);
    results.push({ name: 'LEAVEWIN', stuck: !!s.peek, ...s });
    console.log(`  ${s.peek ? '✗ OPEN  ' : '✓ closed'} LEAVEWIN   peek=${s.peek ?? '-'}`);
    await reset();

    // EXPLICIT: row menu 「预览」, then Esc / outside click / row click.
    const explicit = {};
    async function openExplicit() {
        await page.mouse.move(900, 400);
        await page.goto(`${BASE}/`);
        await page.waitForSelector('.sb-row [data-href^="/session/"]');
        const row = rows().nth(1);
        await row.click({ button: 'right', position: { x: 40, y: 10 } });
        await page.getByRole('menuitem', { name: /预览|Preview/ }).click();
        await page.mouse.move(900, 400);
        await page.waitForSelector('.sb-peek:not(.sb-peek--hover)', { timeout: 3_000 }).catch(() => {});
        return !!(await page.$('.sb-peek:not(.sb-peek--hover)'));
    }
    explicit.opened = await openExplicit();
    await shot('explicit-open');
    await page.keyboard.press('Escape');
    await sleep(300);
    explicit.esc = !(await page.$('.sb-peek'));
    await openExplicit();
    await page.mouse.click(900, 400);
    await sleep(300);
    explicit.outside = !(await page.$('.sb-peek'));
    await openExplicit();
    await rows().nth(1).locator('[data-href]').click();
    await sleep(300);
    explicit.rowClick = !(await page.$('.sb-peek'));
    console.log(`  EXPLICIT opened=${explicit.opened} escCloses=${explicit.esc} outsideClickCloses=${explicit.outside} rowClickCloses=${explicit.rowClick}`);
    results.push({ name: 'EXPLICIT', stuck: !(explicit.opened && explicit.esc && explicit.outside && explicit.rowClick), ...explicit });

    const stuck = results.filter((r) => r.stuck).map((r) => r.name);
    console.log(`[${BROWSER}] left up: ${stuck.join(', ') || 'none'}`);
    process.exitCode = EXPECT === 'stuck' ? (stuck.length ? 0 : 1) : (stuck.length ? 1 : 0);
} catch (error) {
    console.error(error);
    await shot('error');
    process.exitCode = 2;
} finally {
    await browser.close();
}
