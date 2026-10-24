#!/usr/bin/env node
/**
 * B-804 draft — A4 + B6 against a local standalone server (moves into
 * e2e/sync-resume.mjs once B-803 lands). A TCP proxy in front of Vite plays
 * the dead link: a stalled connection never answers and never closes.
 *
 *   node packages/happy-web-v2/e2e/syncDockA4.mjs --base http://127.0.0.1:8884 --server http://127.0.0.1:3284 [--out <dir>] [--hold-ms 20000]
 *
 * A4: a prompt waits in the server queue (dock) → tab to background, link dead
 *     → the queue head is dispatched (the wrapper's pop; called over REST, no
 *     daemon needed) → foreground, the first after_seq GET rides the dead link
 *     → switch session and back → the dead request fails (RST).
 *     Every 250ms: the prompt is in the dock or in the transcript; at the end
 *     it is in the transcript and not in the dock.
 * B6: another device sends while the tab is in background; on resume the GET
 *     rides the dead link → 「同步中」 shows within 1s, and is gone ≤2s after
 *     the tab caught up.
 */
import net from 'node:net';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const BASE = opt('base', 'http://127.0.0.1:8884');
const SERVER = opt('server', 'http://127.0.0.1:3284');
const OUT = opt('out', null);
/** How long the dead request hangs before the link resets (stand-in for the browser giving up). */
const HOLD_MS = Number(opt('hold-ms', '20000'));
if (OUT) mkdirSync(OUT, { recursive: true });

// ── dead-link proxy ──────────────────────────────────────────────────────
const upstream = new URL(BASE);
const conns = new Set();
let blackhole = false;
let stallMatch = null;
const proxy = net.createServer((c) => {
    const up = net.connect(Number(upstream.port), upstream.hostname);
    const rec = { c, up, stalled: blackhole, exempt: false };
    conns.add(rec);
    let first = true;
    c.on('data', (d) => {
        const head = d.toString('latin1').slice(0, 400);
        // Vite's HMR socket is dev plumbing: a reset would full-reload the page.
        if (first) { first = false; if (d.toString('latin1').includes('vite-hmr')) { rec.exempt = true; rec.stalled = false; } }
        if (stallMatch && !rec.stalled && !rec.exempt && head.includes(stallMatch)) { stallMatch = null; rec.stalled = true; }
        if (!rec.stalled) up.write(d);
    });
    up.on('data', (d) => { if (!rec.stalled) c.write(d); });
    const end = () => { conns.delete(rec); c.destroy(); up.destroy(); };
    c.on('close', end); c.on('error', end);
    up.on('close', () => (rec.stalled ? up.destroy() : end())); up.on('error', () => (rec.stalled ? up.destroy() : end()));
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const PROXIED = `http://127.0.0.1:${proxy.address().port}`;
const link = {
    blackhole() { blackhole = true; for (const r of conns) if (!r.exempt) r.stalled = true; },
    healNew() { blackhole = false; },
    stallNext(match) { stallMatch = match; },
    resetStalled() { let n = 0; for (const r of conns) if (r.stalled) { n += 1; r.c.resetAndDestroy?.() ?? r.c.destroy(); r.up.destroy(); } return n; },
};

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

const started = Date.now();
const step = (name) => console.log(`[+${((Date.now() - started) / 1000).toFixed(1)}s] ${name}`);
let failures = 0;
function check(ok, what, detail = '') {
    console.log(`${ok ? '  ✓' : '  ✗'} ${what}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: findChromium(), args: ['--disable-background-timer-throttling'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', deviceScaleFactor: 2, hasTouch: true, isMobile: true });
await context.addInitScript(() => { try { localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch { /* ignore */ } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('load', () => console.log(`    [page load +${((Date.now() - started) / 1000).toFixed(1)}s] ${page.url().slice(-40)}`));
page.on('console', (m) => { if (process.env.VH_E2E_DEBUG && /vite|reload|hmr/i.test(m.text())) console.log('    console', m.text().slice(0, 160)); });
const shot = async (p, name) => { if (OUT) await p.screenshot({ path: join(OUT, `${name}.png`) }); };

const setHidden = (hidden) => page.evaluate((hidden) => {
    if (hidden) {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    } else {
        delete document.visibilityState;
        delete document.hidden;
    }
    document.dispatchEvent(new Event('visibilitychange'));
}, hidden);
const nav = (p, sid) => p.evaluate((sid) => { history.pushState({}, '', `/session/${sid}`); dispatchEvent(new PopStateEvent('popstate')); }, sid);
/** Where the token shows on screen right now. */
const where = (p, token) => p.evaluate(async (token) => ({
    store: (await import('/src/sync/storage.ts')).storage.getState().sessionMessages[location.pathname.split('/').pop()]?.messages?.some((m) => JSON.stringify(m).includes(token)) ?? null,
    dock: [...document.querySelectorAll('.ci-queue-item')].some((e) => e.textContent.includes(token)),
    dockState: [...document.querySelectorAll('.ci-queue-item')].find((e) => e.textContent.includes(token))?.getAttribute('data-queue-item-source') ?? null,
    transcript: (document.querySelector('.cl-inner')?.textContent ?? '').includes(token),
    bar: document.querySelector('.net-bar')?.getAttribute('data-net-phase') ?? null,
    line: document.querySelector('.chat-sync')?.getAttribute('data-sync-phase') ?? null,
    route: location.pathname.slice(-6),
}), token);

async function signUp() {
    const username = `b804${randomBytes(4).toString('hex')}`;
    await page.goto(`${PROXIED}/signup`);
    const toggle = page.locator('.auth-method-toggle');
    await page.locator('input[autocomplete="username"]').or(toggle).first().waitFor({ timeout: 60_000 });
    for (let i = 0; i < 20 && !(await page.locator('input[autocomplete="username"]').isVisible()); i++) {
        await toggle.click().catch(() => {});
        await sleep(500);
    }
    await page.locator('input[autocomplete="username"]').fill(username);
    const pw = `pw-${randomBytes(6).toString('hex')}`;
    const pws = page.locator('input[autocomplete="new-password"]');
    await pws.nth(0).fill(pw);
    await pws.nth(1).fill(pw);
    await page.locator('form.auth-password-form button[type="submit"]').click();
    await page.waitForFunction(() => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().socketStatus === 'connected'), null, { timeout: 60_000, polling: 300 });
    await page.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 30_000, polling: 300 });
}
const createSession = (p, path) => p.evaluate(async (path) => {
    const { sync } = await import('/src/sync/sync.ts');
    const { apiSocket } = await import('/src/sync/apiSocket.ts');
    const { encodeBase64 } = await import('/src/encryption/base64.ts');
    // the post-signup navigation may still be initialising the engine
    for (let i = 0; i < 100 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
    const enc = await sync.encryption.openEncryption(null);
    // `prompt-queue-v1`: the composer's queue lives on the server (B-509).
    const [metadata] = await enc.encrypt([{ path, host: 'e2e', flavor: 'claude', capabilities: ['prompt-queue-v1'] }]);
    const res = await apiSocket.request('/v1/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState: null, dataEncryptionKey: null }),
    });
    return (await res.json()).session.id;
}, path);
async function openSession(p, sid) {
    await nav(p, sid);
    await p.locator('textarea.ci-textarea').waitFor({ timeout: 30_000 });
    for (const name of ['知道了', '暂不', 'Got it', 'Not now']) {
        for (const b of await p.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 1_000 }).catch(() => {});
    }
}

try {
    step('sign up, two sessions');
    await signUp();
    const S1 = await createSession(page, '/tmp/b804-a4');
    const S2 = await createSession(page, '/tmp/b804-other');
    const token = await page.evaluate(() => import('/src/sync/sync.ts').then(({ sync }) => sync['credentials'].token));
    await openSession(page, S1);
    await sleep(1500);

    // ── A4 ──────────────────────────────────────────────────────────
    step('A4 a prompt waits in the server queue');
    const tA = `A4q${Date.now() % 100000}`;
    await page.evaluate(({ sid, text }) => import('/src/sync/promptQueue.ts').then(({ enqueuePrompt }) => enqueuePrompt(sid, text, {})), { sid: S1, text: tA });
    await page.waitForFunction((t) => [...document.querySelectorAll('.ci-queue-item')].some((e) => e.textContent.includes(t)), tA, { timeout: 10_000 });
    await shot(page, 'A4-0-docked');

    step('A4 background, link dead; the wrapper pops it meanwhile');
    link.stallNext('after_seq');
    link.blackhole();
    await setHidden(true);
    await sleep(2000);
    const popped = await (await fetch(`${SERVER}/v1/sessions/${S1}/prompt-queue/dispatch`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).json();
    check(!!popped.dispatched, 'server dispatched the queue head', JSON.stringify(popped.dispatched ?? popped));
    await sleep(5000);

    step('A4 foreground; the first after_seq GET rides the dead link');
    link.healNew();
    await setHidden(false);
    const samples = [];
    const sampleFor = async (ms, label) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            samples.push({ label, at: Date.now() - started, ...(await where(page, tA)) });
            await sleep(250);
        }
    };
    await sampleFor(4000, 'fg');
    await shot(page, 'A4-1-foreground');
    step('A4 switch session and back');
    await nav(page, S2);
    await sleep(1500);
    await openSession(page, S1);
    await sampleFor(Math.max(0, HOLD_MS - 5500), 'back');
    await shot(page, 'A4-2-back-hung');
    step(`A4 the dead request fails (reset ${link.resetStalled()} stalled conns)`);
    const tReset = Date.now();
    let caughtUpMs = null;
    while (Date.now() - tReset < 15_000) {
        const s = await where(page, tA);
        samples.push({ label: 'after-reset', at: Date.now() - started, ...s });
        if (s.transcript && !s.dock) { caughtUpMs = Date.now() - tReset; break; }
        await sleep(250);
    }
    await sleep(500);
    await shot(page, 'A4-3-settled');
    const lost = samples.filter((s) => !s.dock && !s.transcript);
    const both = samples.filter((s) => s.dock && s.transcript);
    console.log(`    ${samples.length} samples; dock=${samples.filter((s) => s.dock).length} transcript=${samples.filter((s) => s.transcript).length} neither=${lost.length} both=${both.length}`);
    if (process.env.VH_E2E_DEBUG) for (const x of samples) console.log('     ', (x.at / 1000).toFixed(2), x.label, x.dockState, x.transcript, 'store=' + x.store, x.bar, x.line, x.route ?? '');
    console.log(`    dock row states: ${[...new Set(samples.map((s) => s.dockState).filter(Boolean))].join(',')}`);
    check(lost.length === 0, 'A4: the prompt is always in the dock or the transcript', lost.length ? `first gap at +${(lost[0].at / 1000).toFixed(1)}s (${lost[0].label})` : '');
    check(caughtUpMs !== null, 'A4: in the transcript, dock empty, after the dead request failed', caughtUpMs === null ? 'not within 15s' : `${caughtUpMs}ms`);
    check(samples.some((s) => s.line === 'slow' || s.line === 'syncing' || s.bar === 'syncing'), 'A4: the hung catch-up was shown (同步中 / 连接不稳定)');

    // ── B6 ──────────────────────────────────────────────────────────
    step('B6 another device sends while this tab is in background on a dead link');
    // The same account on a direct link (its own origin: copy the login over).
    const state = await context.storageState();
    state.origins = state.origins.map((o) => ({ ...o, origin: o.origin === PROXIED ? new URL(BASE).origin : o.origin }));
    const ctx2 = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 860 } });
    const page2 = await ctx2.newPage();
    await page2.goto(`${BASE}/session/${S1}`);
    await page2.locator('textarea.ci-textarea').waitFor({ timeout: 60_000 });
    await page2.waitForFunction(() => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().socketStatus === 'connected'), null, { timeout: 30_000, polling: 300 });
    link.stallNext('after_seq');
    link.blackhole();
    await setHidden(true);
    const tB = `B6x${Date.now() % 100000}`;
    await page2.evaluate(({ sid, text }) => import('/src/sync/sync.ts').then(({ sync }) => sync.sendMessage(sid, text, { source: 'chat' })), { sid: S1, text: tB });
    await sleep(8000);
    link.healNew();
    const tResume = Date.now();
    await setHidden(false);
    let syncingAt = null;
    while (Date.now() - tResume < 3000) {
        const s = await where(page, tB);
        if (s.bar === 'syncing' || s.line === 'syncing') { syncingAt = Date.now() - tResume; break; }
        await sleep(100);
    }
    check(syncingAt !== null && syncingAt <= 1000, 'B6: 「同步中」 within 1s of the resume', syncingAt === null ? 'never' : `${syncingAt}ms`);
    await shot(page, 'B6-0-syncing');
    await sleep(Math.max(0, HOLD_MS - (Date.now() - tResume)));
    const hung = await where(page, tB);
    console.log(`    while hung: transcript=${hung.transcript} bar=${hung.bar} line=${hung.line}`);
    await shot(page, 'B6-1-hung');
    link.resetStalled();
    const tR = Date.now();
    let inAt = null;
    let clearAt = null;
    while (Date.now() - tR < 15_000) {
        const s = await where(page, tB);
        if (s.transcript && inAt === null) inAt = Date.now() - tR;
        if (inAt !== null && s.bar !== 'syncing' && !s.line) { clearAt = Date.now() - tR; break; }
        await sleep(100);
    }
    check(inAt !== null, 'B6: caught up after the dead request failed', inAt === null ? 'not within 15s' : `${inAt}ms`);
    check(clearAt !== null && clearAt - inAt <= 2000, 'B6: 「同步中」 gone ≤2s after catching up', clearAt === null ? 'still shown' : `${clearAt - inAt}ms after`);
    await shot(page, 'B6-2-caught-up');
    await ctx2.close();
} catch (error) {
    failures += 1;
    console.log('  ✗ script error —', error?.stack ?? error);
    await shot(page, 'error').catch(() => {});
} finally {
    link.resetStalled();
    await browser.close();
    proxy.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
