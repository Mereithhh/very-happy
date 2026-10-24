#!/usr/bin/env node
/**
 * B-803 (from the B-802 harness): message catch-up across background / dead
 * links / reconnects / session switches / two tabs, end to end in Chromium
 * against a local standalone server. Not part of CI — run by hand:
 *
 *   DATA_DIR=<tmp> PORT=3199 pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts migrate
 *   VH_SERVER_URL=http://127.0.0.1:3199 pnpm -C packages/happy-web-v2 exec vite --port 8799 --strictPort
 *   node packages/happy-web-v2/e2e/sync-resume.mjs --base http://127.0.0.1:8799 --data-dir <tmp> \
 *     [--port 3199] [--proxy-port 8798] [--timeout-ms 10000] [--hold-ms 30000] [--out <dir>] [--only B3,B6]
 *
 * The script starts the server itself, plus an in-process TCP proxy in front
 * of Vite. tab1 ("the phone") loads the app THROUGH the proxy; tab2 ("another
 * device", same account) loads it directly. The proxy can make links dead the
 * way a sleeping phone sees them — bytes go nowhere, no FIN, no RST:
 *   blackhole   every link (existing and new) stalls
 *   healNew     new links pass; the stalled ones stay stalled (pooled dead sockets)
 *   stallMatch  the next request whose head contains <text> rides a dead link
 *   resetStalled  RST the stalled links (what an OS TCP timeout eventually does)
 * Vite's HMR socket is exempt (a reset would full-reload the page).
 *
 * No daemon/agent is needed: a message tab2 sends is stored by the server and
 * pushed to tab1 as a `new-message` update with the next seq, exactly like an
 * agent reply would be.
 *
 * Scenarios (B-802 REPORT §4 PR-1; T = --timeout-ms, the catch-up deadline):
 *   B3   a forward GET is in flight when the link dies; tab1 goes to the
 *        background, tab2 sends; back in the foreground → caught up ≤ T + 2s.
 *   B6   the link dies in the background; the resume GET itself rides a dead
 *        pooled link; tab2 sends while hidden and again after the resume →
 *        caught up ≤ T + 2s, and the post-resume message visible ≤ 2s.
 *   LIVE a catch-up GET hangs while tab1 is in the foreground; a message
 *        tab2 sends meanwhile is visible in tab1 ≤ 2s (the session lock is not
 *        held across the request).
 *   NET  dead link for 15s while visible (tab2 sends), then RST + heal; and a
 *        forced socket close → caught up ≤ T + 2s.
 *   A1   tab1 sends then switches session at 0ms and back → its message is
 *        visible ≤ 2s after coming back.
 *   TABS tab1 and tab2 interleave 6 sends → both show all of them and end on
 *        the same lastSeq ≤ 2s after the last send.
 * Prints one line per measurement (`MEASURE <scenario> <ms|never>`) for the
 * before/after table. Exit code 1 on any failed check.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const BASE = opt('base', 'http://127.0.0.1:8799');
const OUT = opt('out', null);
const DATA_DIR = opt('data-dir', null);
const PORT = opt('port', '3199');
const PROXY_PORT = Number(opt('proxy-port', '8798'));
const TIMEOUT_MS = Number(opt('timeout-ms', '10000'));
const HOLD_MS = Number(opt('hold-ms', '30000'));
const ONLY = opt('only', null)?.split(',') ?? null;
const CATCH_UP_LIMIT_MS = TIMEOUT_MS + 2_000;
const LIVE_LIMIT_MS = 2_000;
if (OUT) mkdirSync(OUT, { recursive: true });
if (!DATA_DIR) {
    console.error('--data-dir <migrated standalone data dir> is required');
    process.exit(2);
}
const viteUrl = new URL(BASE);
const PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}`;

// ── standalone server (same as e2e/offline.mjs) ───────────────────────
const serverDir = resolve(import.meta.dirname, '../../happy-server');
let server = null;
async function startServer() {
    server = spawn(resolve(serverDir, '../../node_modules/.bin/tsx'), ['--env-file=.env.dev', './sources/standalone.ts', 'serve'], {
        cwd: serverDir,
        env: { ...process.env, DATA_DIR, PORT, METRICS_PORT: String(Number(PORT) + 6000), SIGNUP_MODE: 'open' },
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

// ── dead-link TCP proxy (tab1 → proxy → Vite) ─────────────────────────
const proxy = (() => {
    let mode = 'pass';
    let stallMatch = null;
    const links = new Set();
    const srv = net.createServer((client) => {
        const upstream = net.connect(Number(viteUrl.port), viteUrl.hostname);
        const link = { client, upstream, stalled: mode === 'blackhole', exempt: false };
        links.add(link);
        let first = true;
        client.on('data', (chunk) => {
            const head = chunk.toString('latin1', 0, Math.min(chunk.length, 400));
            if (first) {
                first = false;
                if (head.includes('vite-hmr')) { link.exempt = true; link.stalled = false; }
            }
            // keep-alive reuse: every request head on this link is checked
            if (stallMatch && !link.stalled && !link.exempt && head.includes(stallMatch)) {
                stallMatch = null;
                link.stalled = true;
            }
            if (!link.stalled) upstream.write(chunk);
        });
        upstream.on('data', (chunk) => { if (!link.stalled) client.write(chunk); });
        // A dead path tells the browser nothing: upstream closing must not reach a stalled link.
        const end = () => { links.delete(link); client.destroy(); upstream.destroy(); };
        const upstreamEnd = () => { if (link.stalled) { upstream.destroy(); return; } end(); };
        client.on('close', end);
        client.on('error', end);
        upstream.on('close', upstreamEnd);
        upstream.on('error', upstreamEnd);
    });
    return {
        listen: () => new Promise((r) => srv.listen(PROXY_PORT, '127.0.0.1', r)),
        close: () => new Promise((r) => { for (const l of links) { l.client.destroy(); l.upstream.destroy(); } srv.close(r); }),
        blackhole() { mode = 'blackhole'; for (const l of links) if (!l.exempt) l.stalled = true; },
        healNew() { mode = 'pass'; },
        stallNext(text) { stallMatch = text; },
        resetStalled() {
            for (const l of [...links]) if (l.stalled) { l.client.resetAndDestroy?.() ?? l.client.destroy(); l.upstream.destroy(); }
        },
        pass() { mode = 'pass'; stallMatch = null; this.resetStalled(); },
        stalledCount: () => [...links].filter((l) => l.stalled).length,
    };
})();

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
const measures = [];
function measure(name, ms) {
    measures.push([name, ms]);
    console.log(`MEASURE ${name} ${ms === null ? 'never' : `${ms}ms`}`);
}
const fmt = (ms) => (ms === null ? `never (>${HOLD_MS}ms)` : `${ms}ms`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = (name) => !ONLY || ONLY.includes(name);

// ── page helpers ──────────────────────────────────────────────────────
async function dismissDialogs(page) {
    for (const name of ['知道了', '暂不', 'Got it', 'Not now']) {
        for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 1_000 }).catch(() => {});
    }
}
async function waitConnected(page, timeout = 30_000) {
    await page.waitForFunction(() => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().socketStatus === 'connected'), null, { timeout, polling: 200 });
}
async function openSession(page, base, sessionId) {
    await page.goto(`${base}/session/${sessionId}`);
    await page.locator('textarea.ci-textarea').waitFor({ timeout: 60_000 });
    await waitConnected(page, 60_000);
    await dismissDialogs(page);
}
/** In-app navigation (no reload), like tapping another session in the sidebar. */
async function nav(page, sessionId) {
    await page.evaluate((id) => { history.pushState({}, '', `/session/${id}`); dispatchEvent(new PopStateEvent('popstate')); }, sessionId);
}
async function send(page, text) {
    await page.fill('textarea.ci-textarea', text);
    const value = await page.inputValue('textarea.ci-textarea');
    if (value !== text) throw new Error('harness: composer did not take the text (dialog focus?)');
    await page.press('textarea.ci-textarea', 'Enter');
}
/** Does tab's store (and, when on that session, its transcript DOM) hold `token`? */
async function probe(page, sessionId, token) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await probeOnce(page, sessionId, token);
        } catch (error) {
            // A dev-mode reload (a lazy module request RST by the proxy) — wait it out.
            if (attempt >= 3 || !/context was destroyed|navigation/i.test(String(error?.message))) throw error;
            await page.locator('textarea.ci-textarea').waitFor({ timeout: 60_000 }).catch(() => {});
        }
    }
}
async function probeOnce(page, sessionId, token) {
    return page.evaluate(async ({ sessionId, token }) => {
        const { storage } = await import('/src/sync/storage.ts');
        const { sync } = await import('/src/sync/sync.ts');
        const messages = storage.getState().sessionMessages[sessionId]?.messages ?? [];
        const inStore = messages.some((m) => typeof m.text === 'string' && m.text.includes(token));
        const onScreen = location.pathname.endsWith(sessionId);
        const inDom = onScreen ? (document.querySelector('.cl-inner')?.textContent ?? '').includes(token) : null;
        return { inStore, inDom, lastSeq: sync.sessionLastSeq.get(sessionId) ?? null, socket: storage.getState().socketStatus };
    }, { sessionId, token });
}
/** ms until `token` is in tab's transcript (store + DOM), or null after `holdMs`. */
async function timeUntilVisible(page, sessionId, token, holdMs, t0 = Date.now()) {
    while (Date.now() - t0 < holdMs) {
        const p = await probe(page, sessionId, token);
        if (p.inStore && p.inDom !== false) return Date.now() - t0;
        await sleep(100);
    }
    return null;
}
async function setHidden(page, hidden) {
    await page.evaluate((hidden) => {
        if (hidden) {
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        } else {
            delete document.visibilityState;
            delete document.hidden;
        }
        document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
}
/** Fire a catch-up GET in tab1 now (what any incoming message does today). */
const pokeCatchUp = (page, sessionId) => page.evaluate((id) => import('/src/sync/sync.ts').then(({ sync }) => sync.onSessionVisible(id)), sessionId);
const closeSocket = (page) => page.evaluate(() => import('/src/sync/apiSocket.ts').then(({ apiSocket }) => apiSocket['socket']?.io?.engine?.close()));
const token = (tag) => `${tag}x${randomBytes(3).toString('hex')}`;

/**
 * After a scenario: if tab1 never caught up (pre-fix behaviour), RST the dead
 * links and record how long recovery takes then; leave both tabs in sync.
 */
async function settle(name, page1, page2, sessionId, lastToken) {
    const caught = await probe(page1, sessionId, lastToken);
    if (!(caught.inStore && caught.inDom !== false)) {
        const t1 = Date.now();
        proxy.resetStalled();
        const ms = await timeUntilVisible(page1, sessionId, lastToken, 30_000, t1);
        measure(`${name}-after-rst`, ms);
    }
    proxy.pass();
    await waitConnected(page1, 30_000).catch(() => {});
    const a = await probe(page1, sessionId, lastToken);
    const b = await probe(page2, sessionId, lastToken);
    if (a.lastSeq !== b.lastSeq) await sleep(1_000);
}

// ── run ───────────────────────────────────────────────────────────────
await startServer();
await proxy.listen();
const browser = await chromium.launch({ executablePath: findChromium(), args: ['--disable-background-timer-throttling'] });
const ctxOpts = { serviceWorkers: 'block', viewport: { width: 1280, height: 860 }, locale: 'zh-CN' };
const ctx2 = await browser.newContext(ctxOpts);
await ctx2.addInitScript(() => { try { localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch { /* ignore */ } });
const page2 = await ctx2.newPage();
page2.on('pageerror', (e) => console.log('tab2 pageerror', e.message));
let ctx1 = null;
const shot = async (page, name) => { if (OUT) await page.screenshot({ path: join(OUT, `${name}.png`) }).catch(() => {}); };

try {
    step('sign up (tab2, direct)');
    const username = `b803${randomBytes(4).toString('hex')}`;
    await page2.goto(`${BASE}/signup`);
    const toggle = page2.locator('.auth-method-toggle');
    await page2.locator('input[autocomplete="username"]').or(toggle).first().waitFor({ timeout: 60_000 });
    if (!(await page2.locator('input[autocomplete="username"]').isVisible())) await toggle.click();
    await page2.locator('input[autocomplete="username"]').fill(username);
    const pw = `pw-${randomBytes(6).toString('hex')}`;
    const pws = page2.locator('input[autocomplete="new-password"]');
    await pws.nth(0).fill(pw);
    await pws.nth(1).fill(pw);
    await page2.locator('form.auth-password-form button[type="submit"]').click();
    await waitConnected(page2);

    step('create two sessions in-page');
    await page2.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 30_000, polling: 300 });
    const [S1, S2] = await page2.evaluate(async () => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const { encodeBase64 } = await import('/src/encryption/base64.ts');
        for (let i = 0; i < 100 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
        const ids = [];
        for (const path of ['/tmp/b803-e2e-1', '/tmp/b803-e2e-2']) {
            const enc = await sync.encryption.openEncryption(null);
            const [metadata] = await enc.encrypt([{ path, host: 'e2e', flavor: 'claude' }]);
            const res = await apiSocket.request('/v1/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState: null, dataEncryptionKey: null }),
            });
            ids.push((await res.json()).session.id);
        }
        return ids;
    });
    await openSession(page2, BASE, S1);
    await send(page2, token('seed'));
    await sleep(500);

    step('tab1 (through the proxy) with the same account');
    const storageDump = await page2.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    ctx1 = await browser.newContext(ctxOpts);
    await ctx1.addInitScript((entries) => {
        if (sessionStorage.getItem('b803-seeded')) return;
        sessionStorage.setItem('b803-seeded', '1');
        for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    }, storageDump);
    const page1 = await ctx1.newPage();
    page1.on('pageerror', (e) => console.log('tab1 pageerror', e.message));
    page1.on('framenavigated', (f) => { if (f === page1.mainFrame()) console.log(`    tab1 navigated → ${f.url().replace(PROXY_BASE, '')}`); });
    page1.on('requestfailed', (r) => { if (!/\/v3\/|\/v1\/|socket\.io/.test(r.url())) console.log(`    tab1 request failed ${r.url().replace(PROXY_BASE, '')} ${r.failure()?.errorText}`); });
    await openSession(page1, PROXY_BASE, S1);
    await sleep(1_500);
    await shot(page1, '0-tab1-ready');

    // ── B3: GET in flight when the link dies, then background ─────────
    if (want('B3')) {
        step('B3 forward GET in flight when the link dies → background → resume');
        proxy.stallNext('after_seq');
        await pokeCatchUp(page1, S1);
        await sleep(300);
        proxy.blackhole();
        await setHidden(page1, true);
        const tok = token('B3');
        await send(page2, tok);
        await sleep(20_000);
        proxy.healNew();
        const t0 = Date.now();
        await setHidden(page1, false);
        const ms = await timeUntilVisible(page1, S1, tok, HOLD_MS, t0);
        measure('B3', ms);
        check(ms !== null && ms <= CATCH_UP_LIMIT_MS, `B3 caught up ≤ ${CATCH_UP_LIMIT_MS}ms after resume`, fmt(ms));
        await shot(page1, 'B3');
        await settle('B3', page1, page2, S1, tok);
    }

    // ── B6: the resume GET itself rides a dead pooled link ─────────────
    if (want('B6')) {
        step('B6 dead link in background; the resume GET rides a dead pooled link');
        proxy.stallNext('after_seq');
        proxy.blackhole();
        await setHidden(page1, true);
        const tok = token('B6a');
        await send(page2, tok);
        await sleep(30_000);
        proxy.healNew();
        const t0 = Date.now();
        await setHidden(page1, false);
        const ms = await timeUntilVisible(page1, S1, tok, HOLD_MS, t0);
        measure('B6', ms);
        check(ms !== null && ms <= CATCH_UP_LIMIT_MS, `B6 caught up ≤ ${CATCH_UP_LIMIT_MS}ms after resume`, fmt(ms));
        // another device sends after the resume: visible ≤ 2s
        const tok2 = token('B6b');
        const t1 = Date.now();
        await send(page2, tok2);
        const ms2 = await timeUntilVisible(page1, S1, tok2, Math.max(HOLD_MS - (Date.now() - t0), 5_000), t1);
        measure('B6-live-after-resume', ms2);
        check(ms2 !== null && ms2 <= LIVE_LIMIT_MS, `B6 a message sent after the resume is visible ≤ ${LIVE_LIMIT_MS}ms`, fmt(ms2));
        await shot(page1, 'B6');
        await settle('B6', page1, page2, S1, tok2);
    }

    // ── LIVE: a hung catch-up does not block live messages ───────────
    if (want('LIVE')) {
        step('LIVE a catch-up GET hangs in the foreground; tab2 sends meanwhile');
        await sleep(1_000);
        proxy.stallNext('after_seq');
        await pokeCatchUp(page1, S1);
        await sleep(500);
        const stalled = proxy.stalledCount();
        const tok = token('LIVE');
        const t0 = Date.now();
        await send(page2, tok);
        const ms = await timeUntilVisible(page1, S1, tok, HOLD_MS, t0);
        measure('LIVE', ms);
        check(stalled >= 1, 'the catch-up GET really was stalled', `stalled links=${stalled}`);
        check(ms !== null && ms <= LIVE_LIMIT_MS, `LIVE message visible ≤ ${LIVE_LIMIT_MS}ms while a GET hangs`, fmt(ms));
        await settle('LIVE', page1, page2, S1, tok);
    }

    // ── NET: dead link while visible, then reconnect; forced socket close ──
    if (want('NET')) {
        step('NET dead link 15s while visible, then RST + heal');
        proxy.blackhole();
        const tok = token('NETa');
        await send(page2, tok);
        await sleep(15_000);
        const t0 = Date.now();
        proxy.pass();
        const ms = await timeUntilVisible(page1, S1, tok, HOLD_MS, t0);
        measure('NET-heal', ms);
        check(ms !== null && ms <= CATCH_UP_LIMIT_MS, `NET caught up ≤ ${CATCH_UP_LIMIT_MS}ms after the link is back`, fmt(ms));
        await settle('NET', page1, page2, S1, tok);

        step('NET forced socket close with a GET hanging');
        proxy.stallNext('after_seq');
        await pokeCatchUp(page1, S1);
        await sleep(300);
        await closeSocket(page1);
        const tok2 = token('NETb');
        const t1 = Date.now();
        await send(page2, tok2);
        const ms2 = await timeUntilVisible(page1, S1, tok2, HOLD_MS, t1);
        measure('NET-socket-close', ms2);
        check(ms2 !== null && ms2 <= CATCH_UP_LIMIT_MS, `NET caught up ≤ ${CATCH_UP_LIMIT_MS}ms after a forced socket close`, fmt(ms2));
        await settle('NET2', page1, page2, S1, tok2);
    }

    // ── A1: send, switch away at 0ms, come back ───────────────────────
    if (want('A1')) {
        step('A1 send then switch session at 0ms and back');
        const tok = token('A1');
        await send(page1, tok);
        await nav(page1, S2);
        await sleep(3_000);
        const t0 = Date.now();
        await nav(page1, S1);
        const ms = await timeUntilVisible(page1, S1, tok, HOLD_MS, t0);
        measure('A1', ms);
        check(ms !== null && ms <= LIVE_LIMIT_MS, `A1 own message visible ≤ ${LIVE_LIMIT_MS}ms after switching back`, fmt(ms));
        const other = await timeUntilVisible(page2, S1, tok, 5_000);
        check(other !== null, 'A1 the other device sees it too', fmt(other));
        await settle('A1', page1, page2, S1, tok);
    }

    // ── TABS: two tabs interleave sends ───────────────────────────────
    if (want('TABS')) {
        step('TABS tab1 and tab2 interleave 6 sends');
        const toks = [];
        for (let i = 0; i < 6; i++) {
            const tok = token(`T${i}`);
            toks.push(tok);
            await send(i % 2 === 0 ? page1 : page2, tok);
            await sleep(300);
        }
        const t0 = Date.now();
        let ok = false;
        let seqs = null;
        while (Date.now() - t0 < HOLD_MS) {
            const a = await Promise.all(toks.map((t) => probe(page1, S1, t)));
            const b = await Promise.all(toks.map((t) => probe(page2, S1, t)));
            seqs = [a[0].lastSeq, b[0].lastSeq];
            if (a.every((p) => p.inStore) && b.every((p) => p.inStore) && seqs[0] === seqs[1]) { ok = true; break; }
            await sleep(100);
        }
        const ms = ok ? Date.now() - t0 : null;
        measure('TABS', ms);
        check(ok && ms <= LIVE_LIMIT_MS, `TABS both tabs show all 6 and agree on lastSeq ≤ ${LIVE_LIMIT_MS}ms`, `${fmt(ms)} lastSeq=${JSON.stringify(seqs)}`);
        await shot(page1, 'TABS-tab1');
        await shot(page2, 'TABS-tab2');
    }
} catch (error) {
    failures += 1;
    console.error(error);
} finally {
    await browser.close().catch(() => {});
    await proxy.close().catch(() => {});
    await stopServer();
}
console.log(`MEASURES ${JSON.stringify(Object.fromEntries(measures))}`);
console.log(failures === 0 ? 'sync-resume e2e: all checks passed' : `sync-resume e2e: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
