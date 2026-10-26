#!/usr/bin/env node
/**
 * Sidebar session count never drops (Owner 10-27: 「侧边栏的会话会突然变少，然后再加载回完整的 list」).
 * End to end in Chromium against a local standalone server; not part of CI — run by hand:
 *
 *   DATA_DIR=<tmp> PORT=3199 pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts migrate
 *   VH_SERVER_URL=http://127.0.0.1:3199 pnpm -C packages/happy-web-v2 exec vite --port 8799 --strictPort
 *   node packages/happy-web-v2/e2e/sidebar-list-monotonic.mjs --base http://127.0.0.1:8799 --data-dir <tmp> \
 *     [--port 3199] [--device desktop|phone] [--mode subscribe|legacy] [--out <dir>]
 *
 * The script starts the server itself (`--mode legacy` = SYNC_SUBSCRIBE_DISABLED=1).
 * A big account: more rows than the list's 150-row window, with live sessions
 * on both sides of it — LIVE_OLD live sessions first, then ARCHIVED archived
 * ones (newer `updatedAt`, so they fill the window), then LIVE_NEW live ones.
 *
 * In the page, every animation frame (and a 50ms timer while hidden) records
 * how many session rows the sidebar renders (`[data-dragkey]` keys that are
 * session ids). No real delete or archive happens inside a scenario, so each
 * one asserts the sidebar never shows fewer sessions than it had when the
 * scenario started (a reload's empty loading frame is not a list) and ends
 * with the whole live set. The seeding tab holds every session (the store
 * merges each one in), like the Owner's long-lived tab:
 *   RESUME     hidden 3s → visible (resumeSync)
 *   SOCKET     socket closed → reconnect (first-connect catch-up / reconnect list)
 *   OFFLINE    context offline 4s → online
 *   NEWSESSION tab2 creates a session (the `new-session` backstop refetches the list)
 *   RELOAD#n   a fresh page load — a reload, a new build taking over (the SW
 *              update path ends in exactly this reload; the context blocks the
 *              SW so the reload is the whole of it), a phone restoring a
 *              discarded tab — then 10 old live sessions get a message, the way
 *              heartbeating sessions keep moving (先少后多 before the fix:
 *              61 → 21 → 31; the server listed only the 150 newest rows).
 * Exit code 1 on any failed check.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const BASE = opt('base', 'http://127.0.0.1:8799');
const OUT = opt('out', null);
const DATA_DIR = opt('data-dir', null);
const PORT = opt('port', '3199');
const DEVICE = opt('device', 'desktop');
const MODE = opt('mode', 'subscribe');
const LIVE_OLD = Number(opt('live-old', '40'));
const ARCHIVED = Number(opt('archived', '170'));
const LIVE_NEW = Number(opt('live-new', '20'));
if (OUT) mkdirSync(OUT, { recursive: true });
if (!DATA_DIR) {
    console.error('--data-dir <migrated standalone data dir> is required');
    process.exit(2);
}
const serverDir = resolve(import.meta.dirname, '../../happy-server');
let server = null;
async function startServer() {
    server = spawn(resolve(serverDir, '../../node_modules/.bin/tsx'), ['--env-file=.env.dev', './sources/standalone.ts', 'serve'], {
        cwd: serverDir,
        env: { ...process.env, DATA_DIR, PORT, METRICS_PORT: String(Number(PORT) + 6000), SIGNUP_MODE: 'open', ...(MODE === 'legacy' ? { SYNC_SUBSCRIBE_DISABLED: '1' } : {}) },
        stdio: 'ignore',
    });
    for (let i = 0; i < 150; i++) {
        try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return; } catch { /* starting */ }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not come up');
}
async function stopServer() {
    if (!server) return;
    const proc = server;
    server = null;
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
}

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

/** In-page: one sample per animation frame of the sidebar's session-row count. */
const SAMPLER = () => {
    const w = window;
    if (w.__sbSampler) return;
    w.__sbSamples = [];
    const t0 = performance.timeOrigin;
    const count = () => {
        const keys = new Set();
        for (const el of document.querySelectorAll('[data-dragkey]')) {
            const k = el.getAttribute('data-dragkey') || '';
            if (k && !k.startsWith('t:') && !k.includes(':')) keys.add(k);
        }
        return keys.size;
    };
    w.__sbCount = count;
    let last = -1;
    const tick = () => {
        const n = count();
        if (n !== last) {
            w.__sbSamples.push([Math.round(t0 + performance.now()), n]);
            last = n;
        }
        w.__sbSampler = requestAnimationFrame(tick);
    };
    // rAF stops in a hidden tab; a timer keeps sampling there too.
    setInterval(() => { const n = count(); if (n !== last) { w.__sbSamples.push([Math.round(t0 + performance.now()), n]); last = n; } }, 50);
    w.__sbSampler = requestAnimationFrame(tick);
};

const browser = await chromium.launch({ executablePath: findChromium() });
const viewport = DEVICE === 'phone' ? { width: 390, height: 844 } : { width: 1400, height: 900 };
const ctxOpts = { viewport, locale: 'zh-CN', deviceScaleFactor: DEVICE === 'phone' ? 2 : 1, hasTouch: DEVICE === 'phone', isMobile: DEVICE === 'phone', serviceWorkers: 'block' };
const context = await browser.newContext(ctxOpts);
await context.addInitScript(() => { try { localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch { /* ignore */ } });
await context.addInitScript(SAMPLER);
const page = await context.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));

const samples = () => page.evaluate(() => window.__sbSamples ?? []);
const resetSamples = () => page.evaluate(() => { window.__sbSamples = []; });
/** Settled count: the last sample once nothing changed for `quietMs`. */
async function settle(quietMs = 2_500, timeoutMs = 30_000) {
    const t0 = Date.now();
    let prev = null;
    let since = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const cur = await page.evaluate(() => window.__sbCount?.() ?? null);
        if (cur !== prev) { prev = cur; since = Date.now(); }
        if (cur !== null && cur > 0 && Date.now() - since >= quietMs) return cur;
        await sleep(200);
    }
    return prev;
}
const timeline = (s) => s.map(([t, n]) => `${n}@${t % 100000}`).join(' ');
const allResults = [];
/**
 * One scenario: the sidebar showed `before` rows when it started. Every list
 * it shows afterwards (a reload's empty loading frame is not a list) must
 * hold at least `before` rows — no real delete / archive happens inside a
 * scenario — and it ends with `expected`.
 */
function assertNoDrop(name, s, before, expected) {
    const shown = s.filter(([, n]) => n > 0);
    const low = shown.find(([, n]) => n < before) ?? null;
    let prev = 0;
    let drop = null;
    for (const [t, n] of shown) { if (n < prev && !drop) drop = { t, from: prev, to: n }; prev = n; }
    const last = shown.length ? shown[shown.length - 1][1] : before;
    allResults.push({ name, before, expected, samples: s, low, drop, last });
    check(!low && !drop, `${name}: the sidebar never shows fewer than the ${before} sessions it had`,
        low ? `shows ${low[1]} (先少后多: ${timeline(s)})` : drop ? `${drop.from} → ${drop.to}: ${timeline(s)}` : timeline(s) || 'unchanged');
    check(last === expected, `${name}: ends with the whole list`, `last ${last}, expected ${expected}`);
    return last;
}

async function openSidebar() {
    if (DEVICE !== 'phone') return;
    // Phone: the session list is the home screen. In-app navigation — a goto would be a fresh load.
    if (new URL(page.url()).pathname !== '/') {
        await page.evaluate(() => { history.pushState({}, '', '/'); dispatchEvent(new PopStateEvent('popstate')); });
        await page.waitForFunction(() => location.pathname === '/');
    }
}

async function signUp(p) {
    const username = `sbm${randomBytes(4).toString('hex')}`;
    await p.goto(`${BASE}/signup`);
    const toggle = p.locator('.auth-method-toggle');
    await p.locator('input[autocomplete="username"]').or(toggle).first().waitFor({ timeout: 60_000 });
    if (!(await p.locator('input[autocomplete="username"]').isVisible())) await toggle.click();
    await p.locator('input[autocomplete="username"]').fill(username);
    const pw = `pw-${randomBytes(6).toString('hex')}`;
    const pws = p.locator('input[autocomplete="new-password"]');
    await pws.nth(0).fill(pw);
    await pws.nth(1).fill(pw);
    await p.locator('form.auth-password-form button[type="submit"]').click();
    await p.waitForFunction(() => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().socketStatus === 'connected'), null, { timeout: 60_000, polling: 300 });
    await p.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 30_000, polling: 300 });
}

/** Create `n` sessions in-page; `archive` archives each right after it is created. */
function createSessions(p, prefix, n, archive = false) {
    return p.evaluate(async ({ prefix, n, archive }) => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const { encodeBase64 } = await import('/src/encryption/base64.ts');
        for (let i = 0; i < 100 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
        const ids = [];
        const one = async (i) => {
            const enc = await sync.encryption.openEncryption(null);
            const [metadata] = await enc.encrypt([{ path: `/tmp/sbm/${prefix}-${i}`, host: 'e2e', flavor: 'claude', summary: { text: `${prefix} ${i}`, updatedAt: Date.now() } }]);
            const res = await apiSocket.request('/v1/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState: null, dataEncryptionKey: null }),
            });
            const id = (await res.json()).session.id;
            if (archive) await apiSocket.request(`/v1/sessions/${id}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            ids.push(id);
        };
        for (let i = 0; i < n; i += 8) await Promise.all(Array.from({ length: Math.min(8, n - i) }, (_, j) => one(i + j)));
        return ids;
    }, { prefix, n, archive });
}
const setHidden = (p, hidden) => p.evaluate((hidden) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
    if (!hidden) window.dispatchEvent(new Event('focus'));
}, hidden);

async function dismissDialogs() {
    await page.locator('.wn-card').waitFor({ timeout: 3_000 }).catch(() => {});
    for (const name of ['知道了', '暂不', 'Got it', 'Not now']) {
        for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 1_000 }).catch(() => {});
    }
}

try {
    await startServer();
    step(`sign up (${DEVICE}, ${MODE})`);
    await signUp(page);
    step(`seed: ${LIVE_OLD} live, ${ARCHIVED} archived, ${LIVE_NEW} live`);
    const oldIds = await createSessions(page, 'old', LIVE_OLD);
    await createSessions(page, 'arch', ARCHIVED, true);
    await createSessions(page, 'new', LIVE_NEW);

    let expected = LIVE_OLD + LIVE_NEW;
    // The tab that created them holds every session (the store merges each one in) — no reload here.
    await dismissDialogs();
    await openSidebar();
    let shown = await settle();
    check(shown === expected, 'the long-lived tab shows every live session', `${shown} / ${expected}`);

    const tab2 = await (await browser.newContext({ ...ctxOpts, viewport: { width: 1200, height: 800 } })).newPage();
    const token = await page.evaluate(() => localStorage.getItem('auth_credentials'));
    await tab2.goto(`${BASE}/`);
    await tab2.evaluate((t) => localStorage.setItem('auth_credentials', t), token);
    await tab2.goto(`${BASE}/`);
    await tab2.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 60_000, polling: 300 });
    const bearer = JSON.parse(token).token;
    /** A message on a session tab1 may not hold: the server bumps its updatedAt, tab1 refetches the list. */
    const touch = (ids) => Promise.all(ids.map((id) => fetch(`http://127.0.0.1:${PORT}/v3/sessions/${id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ localId: crypto.randomUUID(), content: 'AAAA' }] }),
    })));

    step('RESUME (hidden 3s → visible)');
    await resetSamples();
    await setHidden(page, true);
    await sleep(3_000);
    await setHidden(page, false);
    await sleep(500);
    await settle();
    shown = assertNoDrop('RESUME', await samples(), shown, expected);

    step('SOCKET (close → reconnect)');
    await resetSamples();
    await page.evaluate(() => import('/src/sync/apiSocket.ts').then(({ apiSocket }) => apiSocket['socket']?.io?.engine?.close()));
    await sleep(1_000);
    await settle();
    shown = assertNoDrop('SOCKET', await samples(), shown, expected);

    step('OFFLINE (4s → online)');
    await resetSamples();
    await context.setOffline(true);
    await sleep(4_000);
    await context.setOffline(false);
    await sleep(1_000);
    await settle(3_000);
    shown = assertNoDrop('OFFLINE', await samples(), shown, expected);

    step('NEWSESSION (tab2 creates one; tab1 refetches the list)');
    await resetSamples();
    await createSessions(tab2, 'tab2', 1);
    expected += 1;
    await sleep(1_000);
    await settle();
    shown = assertNoDrop('NEWSESSION', await samples(), shown, expected);

    // A fresh page load — a reload, a new build taking over (the SW update path
    // ends in exactly this reload), a phone restoring a discarded tab. Then the
    // old sessions get activity, the way heartbeating ones do (先少后多).
    for (let round = 1; round <= 2; round++) {
        step(`RELOAD #${round} (+ activity on ${Math.min(10, LIVE_OLD)} old sessions)`);
        await page.reload();
        await openSidebar();
        await settle();
        await touch(oldIds.slice((round - 1) * 10, round * 10));
        await sleep(1_500);
        await settle();
        shown = assertNoDrop(`RELOAD#${round}`, await samples(), shown, expected);
    }

    if (OUT) writeFileSync(join(OUT, `samples-${DEVICE}-${MODE}.json`), JSON.stringify({ device: DEVICE, mode: MODE, results: allResults }, null, 1));
} catch (error) {
    console.error(error);
    failures += 1;
} finally {
    await browser.close();
    await stopServer();
}
console.log(failures === 0 ? 'PASS' : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
