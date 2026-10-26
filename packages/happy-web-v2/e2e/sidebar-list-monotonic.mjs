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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createTcpServer, connect as tcpConnect } from 'node:net';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const BASE = opt('base', 'http://127.0.0.1:8799');
const OUT = opt('out', null);
const DATA_DIR = opt('data-dir', null);
const PORT = opt('port', '3199');
const DEVICE = opt('device', 'desktop');
const MODE = opt('mode', 'subscribe');
// --shape owner: the biggest production account (10-27: 2832 rows, 381 unarchived,
// 343 of them outside the 150 newest) — ARCHIVED_OLD light archived rows first,
// and every row the list returns carries real-weight metadata (~12KB, B-818 FAT).
const SHAPE = opt('shape', 'small');
const OWNER = SHAPE === 'owner';
const ARCHIVED_OLD = Number(opt('archived-old', OWNER ? '2307' : '0'));
const LIVE_OLD = Number(opt('live-old', OWNER ? '343' : '40'));
const ARCHIVED = Number(opt('archived', OWNER ? '112' : '170'));
const LIVE_NEW = Number(opt('live-new', OWNER ? '38' : '20'));
// --save-auth <file>: write the seeded account's credentials + expected count;
// --reuse-auth <file>: skip sign-up, seeding and the long-lived-tab scenarios on an
// already seeded --data-dir and run only LIST WEIGHT + COLD (server-side A/B on one dataset).
const SAVE_AUTH = opt('save-auth', null);
const REUSE_AUTH = opt('reuse-auth', null);
// --dist fat (default for owner): every listed row ~12KB of ciphertext (B-818 FAT_SLOW).
// --dist real: production's distribution (10-27, the Owner's 381 unarchived rows:
// mean 3.6KB, p90 11.6KB, max 16.2KB) — 9 in 10 rows 2–4KB, 1 in 10 11–16KB.
const DIST = opt('dist', OWNER ? 'fat' : 'none');
const FAT_PAD = DIST === 'none' ? 0 : 8_600; // plaintext chars → ~12KB base64 ciphertext per row
// WEAK: a returning visit over Lighthouse slow 4G (B-818: 1.6Mbps down, 150ms RTT).
const WEAK_DOWN_BPS = 200_000;
const WEAK_RTT_MS = 150;
const WEAK_LIMIT_MS = 15_000;
const FILL_LIMIT_MS = 2_000;
const COLD_RUNS = Number(opt('cold-runs', '3'));
// --dist <dir>: serve a production build (vite build) on --base's port, with the API and
// socket proxied to the server — dev-mode React (and its module graph) is not what a phone runs.
const DIST_DIR = opt('dist', null);
const WEAK_PROXY_PORT = Number(opt('weak-proxy-port', String(Number(new URL(opt('base', 'http://127.0.0.1:8799')).port) + 2))); // B-818 FAT_LIMIT_MS: the list is ready ≤ 15s
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
        env: { ...process.env, DATA_DIR, PORT, METRICS_PORT: String(Number(PORT) + 6000), SIGNUP_MODE: 'open', MAX_SESSIONS_PER_ACCOUNT: '0', MAX_SESSION_STATE_WRITE_UNITS_PER_ACCOUNT_PER_MINUTE: '1000000', ...(MODE === 'legacy' ? { SYNC_SUBSCRIBE_DISABLED: '1' } : {}) },
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

/**
 * slow 4G in front of Vite (which proxies the API and the socket): while
 * throttled, every server→browser byte shares one WEAK_DOWN_BPS downlink and
 * every chunk in either direction waits WEAK_RTT_MS / 2. Headers arrive as
 * soon as they are sent; a big body streams (B-818's idle deadline applies).
 * Only API / socket.io traffic is throttled (a connection's mode follows its
 * last request line): the app's modules come from the SW cache in production,
 * and Vite dev would add an RTT per source module.
 */
/** --dist: the build on BASE's port; /v1 /v2 /v3 /health /socket.io (and its upgrade) go to the server. */
const distServer = (() => {
    if (!DIST_DIR) return { listen: async () => {}, close: async () => {} };
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' };
    const api = /^\/(v\d+|health|socket\.io)(\/|\?|$)/;
    const server = createHttpServer((req, res) => {
        if (api.test(req.url)) {
            const up = httpRequest({ host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
            up.on('error', () => { res.writeHead(502); res.end(); });
            req.pipe(up);
            return;
        }
        const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        let file = join(DIST_DIR, path);
        if (!file.startsWith(DIST_DIR) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST_DIR, 'index.html');
        res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
        res.end(readFileSync(file));
    });
    server.on('upgrade', (req, socket, head) => {
        const up = tcpConnect(Number(PORT), '127.0.0.1', () => {
            up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
            if (head?.length) up.write(head);
            up.pipe(socket); socket.pipe(up);
        });
        up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
    });
    return {
        listen: () => new Promise((r) => server.listen(Number(new URL(BASE).port), '127.0.0.1', r)),
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
    };
})();

const weakProxy = (() => {
    let on = false;
    let linkFreeAt = 0;
    const target = new URL(BASE);
    const relay = (from, to, down, conn) => {
        let queue = Promise.resolve();
        from.on('data', (chunk) => {
            if (!down) {
                const line = /^[A-Z]+ (\S+) HTTP/.exec(chunk.subarray(0, 512).toString('latin1'));
                if (line) conn.api = /^\/(v\d+|socket\.io)\//.test(line[1]);
            }
            if (!on || !conn.api) { to.write(chunk); return; }
            from.pause();
            queue = queue.then(async () => {
                let delay = WEAK_RTT_MS / 2;
                if (down) {
                    const now = Date.now();
                    linkFreeAt = Math.max(linkFreeAt, now) + (chunk.length / WEAK_DOWN_BPS) * 1000;
                    delay = Math.max(delay, linkFreeAt - now);
                }
                await sleep(delay);
                if (!to.destroyed) to.write(chunk);
                from.resume();
            });
        });
        // Close only once the queued (delayed) chunks are out — a destroy here truncates the body.
        const finish = () => { queue.then(() => { if (!to.destroyed) to.end(); }); };
        from.on('end', finish);
        from.on('close', finish);
        from.on('error', () => to.destroy());
    };
    const server = createTcpServer((client) => {
        const upstream = tcpConnect(Number(target.port), target.hostname);
        const conn = { api: false };
        relay(client, upstream, false, conn);
        relay(upstream, client, true, conn);
    });
    return {
        listen: () => new Promise((r) => server.listen(WEAK_PROXY_PORT, '127.0.0.1', r)),
        close: () => new Promise((r) => server.close(() => r())),
        throttle: (value) => { on = value; linkFreeAt = 0; },
    };
})();

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
if (process.env.VH_E2E_DEBUG) { page.on('response', (r) => { if (r.status() >= 400) console.log('HTTP', r.status(), r.request().method(), r.url()); }); page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log('NAV', f.url()); }); }

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
    // The toggle can render a moment before the form it would reveal; clicking it then hides the form (sync-resume.mjs).
    const usernameInput = p.locator('input[autocomplete="username"]');
    if (!(await usernameInput.isVisible())) await usernameInput.waitFor({ timeout: 1_500 }).catch(() => toggle.click());
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
function createSessions(p, prefix, n, archive = false, pad = 0) {
    return p.evaluate(async ({ prefix, n, archive, pad, dist }) => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const { encodeBase64 } = await import('/src/encryption/base64.ts');
        for (let i = 0; i < 100 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
        const ids = [];
        const one = async (i) => {
            const enc = await sync.encryption.openEncryption(null);
            // The weight of a real row: tools / slashCommands / skills / models lists.
            // dist real: a per-row size from a fixed sequence (repeatable runs); ciphertext ≈ 4/3 × plaintext.
            const rowPad = !pad ? 0 : dist !== 'real' ? pad
                : i % 10 === 7 ? Math.round((11_000 + ((i * 2654435761) % 5_000)) * 0.75) - 250
                : Math.round((2_000 + ((i * 40503) % 2_000)) * 0.75) - 250;
            const tools = rowPad > 0 ? Array.from({ length: 86 }, (_, k) => `t${k}_${i}_${'x'.repeat(Math.max(0, Math.floor(rowPad / 86) - 10))}`) : undefined;
            const [metadata] = await enc.encrypt([{ path: `/tmp/sbm/${prefix}-${i}`, host: 'e2e', flavor: 'claude', summary: { text: `${prefix} ${i}`, updatedAt: Date.now() }, ...(tools ? { tools } : {}) }]);
            const res = await apiSocket.request('/v1/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState: null, dataEncryptionKey: null }),
            });
            if (!res.ok) throw new Error(`seed POST ${res.status}`);
            const id = (await res.json()).session.id;
            if (archive) await apiSocket.request(`/v1/sessions/${id}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            ids.push(id);
        };
        // A loaded machine drops the odd request (Failed to fetch): retry a row, never skip it.
        const retried = async (i) => {
            for (let attempt = 1; ; attempt++) {
                try { return await one(i); } catch (error) { if (attempt >= 5) throw error; await new Promise((r) => setTimeout(r, 500 * attempt)); }
            }
        };
        for (let i = 0; i < n; i += 16) await Promise.all(Array.from({ length: Math.min(16, n - i) }, (_, j) => retried(i + j)));
        return ids;
    }, { prefix, n, archive, pad, dist: DIST });
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
    if (REUSE_AUTH) {
        // The seeded rows sat past the server's 10-minute presence timeout, whose
        // write also restamps updatedAt (every live row jumps into the window).
        // Put the fixture back before the server opens the DB: unarchived rows
        // running (the sidebar's list view shows active || hibernated), updatedAt
        // back in seeding order. No other column is touched.
        const { PGlite } = createRequire(join(serverDir, 'package.json'))('@electric-sql/pglite');
        const pg = new PGlite(join(DATA_DIR, 'pglite'));
        await pg.query(`UPDATE "Session" SET "updatedAt" = COALESCE("archivedAt", "createdAt"), active = ("archivedAt" IS NULL), "lastActiveAt" = CASE WHEN "archivedAt" IS NULL THEN now() ELSE "lastActiveAt" END`);
        await pg.close();
    }
    await startServer();
    await distServer.listen();
    await weakProxy.listen();
    let expected;
    let bearer;
    let auth;
    if (REUSE_AUTH) {
        ({ auth, expected } = JSON.parse(readFileSync(REUSE_AUTH, 'utf8')));
        bearer = JSON.parse(auth).token;
    } else {
    step(`sign up (${DEVICE}, ${MODE})`);
    await signUp(page);
    step(`seed (${SHAPE}): ${ARCHIVED_OLD} archived, ${LIVE_OLD} live, ${ARCHIVED} archived, ${LIVE_NEW} live`);
    if (ARCHIVED_OLD) await createSessions(page, 'archold', ARCHIVED_OLD, true);
    const oldIds = await createSessions(page, 'old', LIVE_OLD, false, FAT_PAD);
    await createSessions(page, 'arch', ARCHIVED, true, FAT_PAD);
    await createSessions(page, 'new', LIVE_NEW, false, FAT_PAD);
    step('seeded');

    expected = LIVE_OLD + LIVE_NEW;
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
    bearer = JSON.parse(token).token;
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

    auth = await page.evaluate(() => localStorage.getItem('auth_credentials'));
    if (SAVE_AUTH) writeFileSync(SAVE_AUTH, JSON.stringify({ auth, expected }));
    }

    step('LIST WEIGHT (raw bytes on the wire per encoding)');
    const weight = {};
    for (const encoding of ['br', 'gzip', 'identity']) {
        const t = Date.now();
        const { bytes, body } = await new Promise((resolveIt, reject) => {
            httpRequest({ host: '127.0.0.1', port: PORT, path: '/v1/sessions', headers: { Authorization: `Bearer ${bearer}`, 'Accept-Encoding': encoding } }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => { const b = Buffer.concat(chunks); resolveIt({ bytes: b.length, body: b }); });
            }).on('error', reject).end();
        });
        weight[encoding] = bytes;
        const rows = encoding === 'identity' ? JSON.parse(body.toString()).sessions.length : null;
        console.log(`    /v1/sessions ${encoding}: ${(bytes / 1e6).toFixed(2)}MB${rows !== null ? `, ${rows} rows` : ''} (${Date.now() - t}ms locally)`);
    }

    // A returning visit in a fresh context (same account): a working link, then slow 4G.
    // Measured from the DOM only (works on a production build, --dist): `shown` = the
    // first frame with sidebar rows (the list renders only once the data is ready),
    // `whole` = the first frame with every unarchived session, both from navigation
    // start. COLD_RUNS each; the median is what the checks use (a loaded machine).
    const median = (xs) => { const v = xs.filter((x) => x !== null).sort((a, b) => a - b); return v.length === xs.length ? v[Math.floor((v.length - 1) / 2)] : null; };
    for (const link of ['fast', 'slow4g']) {
        const runs = [];
        for (let run = 1; run <= COLD_RUNS; run++) {
            step(`COLD ${link} #${run} (${DEVICE}${DIST_DIR ? ', production build' : ''}): a fresh tab of the same account`);
            const ctx = await browser.newContext(ctxOpts);
            await ctx.addInitScript((a) => { try { if (!sessionStorage.getItem('sbm-seeded')) { sessionStorage.setItem('sbm-seeded', '1'); localStorage.setItem('auth_credentials', a); localStorage.setItem('vh-pwa-install-never-v1', '1'); } } catch { /* ignore */ } }, auth);
            if (DIST_DIR) await ctx.addInitScript(() => { window.__HAPPY_CONFIG__ = { serverUrl: 'same-origin' }; });
            await ctx.addInitScript(SAMPLER);
            const p = await ctx.newPage();
            // slow4g: through the throttling proxy (its own origin, so its own storage).
            const origin = link === 'slow4g' ? `http://127.0.0.1:${WEAK_PROXY_PORT}` : BASE;
            // Warm the HTTP cache / module graph unthrottled (production boots from the SW cache).
            await p.goto(`${origin}/`);
            await p.waitForFunction(() => (window.__sbCount?.() ?? 0) > 0, null, { timeout: 180_000, polling: 200 });
            if (DEVICE === 'phone') await (await ctx.newCDPSession(p)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
            if (link === 'slow4g') weakProxy.throttle(true);
            const lists = [];
            const t0 = Date.now();
            p.on('request', (r) => { if (/\/v1\/sessions(\?|$)/.test(r.url()) && r.method() === 'GET') lists.push({ r, url: r.url().replace(/^.*\/v1/, '/v1'), at: Date.now() - t0, outcome: 'pending' }); });
            p.on('requestfinished', async (r) => { const x = lists.find((l) => l.r === r); if (!x) return; x.done = Date.now() - t0; x.outcome = 'ok'; x.bytes = (await r.sizes().catch(() => null))?.responseBodySize ?? null; });
            p.on('requestfailed', (r) => { const x = lists.find((l) => l.r === r); if (x) { x.done = Date.now() - t0; x.outcome = r.failure()?.errorText ?? 'failed'; } });
            await p.reload({ waitUntil: 'commit' });
            while (Date.now() - t0 < 75_000) {
                const n = await p.evaluate(() => window.__sbCount?.() ?? 0).catch(() => 0);
                if (n >= expected) break;
                await sleep(100);
            }
            await sleep(500);
            const { samples: s, origin0 } = await p.evaluate(() => ({ samples: window.__sbSamples ?? [], origin0: Math.round(performance.timeOrigin) }));
            weakProxy.throttle(false);
            if (OUT) await p.screenshot({ path: join(OUT, `cold-${link}-${run}.png`) }).catch(() => {});
            await ctx.close();
            const shownAt = s.find(([, n]) => n > 0);
            const wholeAt = s.find(([, n]) => n >= expected);
            const r = { shown: shownAt ? shownAt[0] - origin0 : null, firstShown: shownAt?.[1] ?? null, whole: wholeAt ? wholeAt[0] - origin0 : null, samples: s };
            runs.push(r);
            console.log(`    ${link} #${run}: rows shown +${r.shown ?? '—'}ms (${r.firstShown}), whole (${expected}) +${r.whole ?? '—'}ms; ${timeline(s.map(([t, n]) => [t - origin0, n]))}; GETs ${lists.map((x) => `${x.url} +${x.at}→${x.done ?? '…'}ms ${x.outcome}${x.bytes ? ` ${(x.bytes / 1e6).toFixed(2)}MB` : ''}`).join(' | ')}`);
            let prevN = 0;
            const dropAt = s.find(([, n]) => { const d = n < prevN; prevN = n; return d && n > 0; });
            check(!dropAt, `COLD ${link} #${run}: the count never drops`, timeline(s.map(([t, n]) => [t - origin0, n])));
        }
        const shown = median(runs.map((r) => r.shown));
        const whole = median(runs.map((r) => r.whole));
        console.log(`    ${link} median of ${COLD_RUNS}: rows shown +${shown ?? '—'}ms, whole +${whole ?? '—'}ms`);
        allResults.push({ name: `COLD-${link}`, shown, whole, runs, weight });
        // Lead 10-27: on a working link the rest may land just after the first rows
        // (decoded in idle batches), but the sidebar is whole ≤ FILL_LIMIT_MS after them.
        // Slow 4G (B-818): in ≤ WEAK_LIMIT_MS on the first list; the rest only adds rows.
        if (link === 'fast') check(whole !== null && shown !== null && whole - shown <= FILL_LIMIT_MS, `COLD fast: the sidebar is whole ≤ ${FILL_LIMIT_MS}ms after its first rows (median)`, `whole ${whole === null || shown === null ? '—' : `+${whole - shown}`}ms after them`);
        else {
            check(shown !== null && shown <= WEAK_LIMIT_MS, `COLD slow4g: a big account still gets in — rows shown ≤ ${WEAK_LIMIT_MS}ms (median)`, `${shown ?? '—'}ms`);
            check(whole !== null, 'COLD slow4g: the sidebar ends whole', `${whole ?? '—'}ms`);
        }
    }

    if (OUT) writeFileSync(join(OUT, `samples-${DEVICE}-${MODE}.json`), JSON.stringify({ device: DEVICE, mode: MODE, results: allResults }, null, 1));
} catch (error) {
    console.error(error);
    failures += 1;
} finally {
    await browser.close();
    await stopServer();
    await weakProxy.close();
    await distServer.close();
}
console.log(failures === 0 ? 'PASS' : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
