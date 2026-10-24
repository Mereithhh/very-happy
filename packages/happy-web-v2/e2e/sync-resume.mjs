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
 *        B-804: 「同步中」 (top bar or the chat's line) shows ≤ 1s after the
 *        resume and is gone ≤ 2s after catching up.
 *   A4   (B-804, symptom A) a prompt waits in the server queue (dock); tab1
 *        goes to the background on a dead link and the queue head is dispatched
 *        (the wrapper's pop, over REST); the resume GET rides a dead link; switch
 *        session and back → sampled every 250ms the prompt is always in the dock
 *        or the transcript, and ends in the transcript with the dock empty
 *        ≤ T + 2s after the resume.
 *   LIVE a catch-up GET hangs while tab1 is in the foreground; a message
 *        tab2 sends meanwhile is visible in tab1 ≤ 2s (the session lock is not
 *        held across the request).
 *   NET  dead link for 15s while visible (tab2 sends), then RST + heal; and a
 *        forced socket close → caught up ≤ T + 2s.
 *   A1   tab1 sends then switches session at 0ms and back → its message is
 *        visible ≤ 2s after coming back.
 *   TABS tab1 and tab2 interleave 6 sends → both show all of them and end on
 *        the same lastSeq ≤ 2s after the last send.
 * B-805 (PR-3; live messages cost no history GET — counted per tab):
 *   TURN  tab2 (the "agent") stores TURN_RECORDS agent records 150ms apart
 *         while tab1 views the session → tab1 shows them all, in order, with
 *         0 after_seq GETs.
 *   BURST tab1 and tab2 alternate 50 sends as fast as the composer takes
 *         them → both show exactly 50, same order, matching a fresh load
 *         (server seq order); 0 after_seq GETs in either tab.
 *   UNOPENED records for a session no tab has opened → each tab loads its
 *         latest page at most once (board previews / subagent counts read
 *         it) and does 0 after_seq; opening it in tab1 shows every record.
 * B-808 (edit and resend, opened from history):
 *   EDIT  for the first / last / middle of three seeded turns, a fresh tab1
 *         page opens the session from history and edits that prompt through
 *         the ✏️ UI (the `conversation-rewind` RPC is stubbed ok — no agent;
 *         the tombstone and the new prompt are the real writes), then tab2
 *         stores the "agent" reply → without a reload the new prompt is
 *         visible ≤ 2s after submit and the reply ≤ 2s after it was stored;
 *         the edited prompt and everything after it are gone; tab1, tab2 and
 *         a fresh load show the same transcript. The proxy holds tab1's
 *         `new-message` frames 400ms so the POST ack lands first, as in
 *         production. `own-turn` (control): tab1 first sends a prompt itself.
 *         `--only EDIT` with B-808 reverted fails every case.
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
const TURN_RECORDS = 30;
const BURST_SENDS = 50;
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
    let delayMatch = null;
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
                // the upgrade header can sit past the first 400 bytes (cookies, UA)
                if (chunk.toString('latin1').includes('vite-hmr')) { link.exempt = true; link.stalled = false; }
            }
            // keep-alive reuse: every request head on this link is checked
            if (stallMatch && !link.stalled && !link.exempt && head.includes(stallMatch)) {
                stallMatch = null;
                link.stalled = true;
            }
            if (!link.stalled) upstream.write(chunk);
        });
        // B-808 `delayDown`: a downstream chunk containing the text holds it and
        // everything after it on that link for `ms` (order kept) — a slow update
        // socket, so a POST response on another link lands first.
        let held = null;
        upstream.on('data', (chunk) => {
            if (link.stalled) return;
            if (held) { held.push(chunk); return; }
            if (delayMatch && !link.exempt && chunk.toString('latin1').includes(delayMatch.text)) {
                held = [chunk];
                setTimeout(() => { const out = held; held = null; for (const c of out) if (!link.stalled) client.write(c); }, delayMatch.ms);
                return;
            }
            client.write(chunk);
        });
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
        delayDown(text, ms) { delayMatch = text ? { text, ms } : null; },
        resetStalled() {
            for (const l of [...links]) if (l.stalled) { l.client.resetAndDestroy?.() ?? l.client.destroy(); l.upstream.destroy(); }
        },
        pass() { mode = 'pass'; stallMatch = null; delayMatch = null; this.resetStalled(); },
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
/** B-805: a request count for the before/after table. */
function count(name, n) {
    measures.push([name, n]);
    console.log(`MEASURE ${name} ${n}`);
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
        // B-808: shown with its server seq — not just the optimistic copy.
        const confirmed = messages.some((m) => typeof m.text === 'string' && m.text.includes(token) && typeof m.seq === 'number');
        const onScreen = location.pathname.endsWith(sessionId);
        const inDom = onScreen ? (document.querySelector('.cl-inner')?.textContent ?? '').includes(token) : null;
        return { inStore, confirmed, inDom, lastSeq: sync.sessionLastSeq.get(sessionId) ?? null, socket: storage.getState().socketStatus };
    }, { sessionId, token });
}
/** ms until `token` is in tab's transcript (store + DOM), or null after `holdMs`. */
async function timeUntilVisible(page, sessionId, token, holdMs, t0 = Date.now(), { confirmed = false } = {}) {
    while (Date.now() - t0 < holdMs) {
        const p = await probe(page, sessionId, token);
        if ((confirmed ? p.confirmed : p.inStore) && p.inDom !== false) return Date.now() - t0;
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
const pokeCatchUp = (page, sessionId) => page.evaluate((id) => import('/src/sync/sync.ts').then(({ sync }) => sync.onSessionEnter(id)), sessionId);
const closeSocket = (page) => page.evaluate(() => import('/src/sync/apiSocket.ts').then(({ apiSocket }) => apiSocket['socket']?.io?.engine?.close()));
const token = (tag) => `${tag}x${randomBytes(3).toString('hex')}`;
/** B-804: what tab shows of `token` and of the catch-up right now. */
const onScreen = (page, token) => page.evaluate((token) => ({
    dock: [...document.querySelectorAll('.ci-queue-item')].find((e) => e.textContent.includes(token))?.getAttribute('data-queue-item-source') ?? null,
    transcript: (document.querySelector('.cl-inner')?.textContent ?? '').includes(token),
    syncing: document.querySelector('.net-bar')?.getAttribute('data-net-phase') === 'syncing' || !!document.querySelector('.chat-sync'),
    route: location.pathname.slice(-6),
    body: (document.querySelector('.sd-body')?.textContent ?? '').slice(0, 80),
}), token).catch(() => null);
/** B-804: sample 「同步中」 (top bar / chat line) every 100ms until stop(); first / last time seen, from `t0`. */
function watchSyncing(page, t0) {
    let running = true;
    const seen = { first: null, last: null };
    const done = (async () => {
        while (running) {
            const s = await page.evaluate(() => document.querySelector('.net-bar')?.getAttribute('data-net-phase') === 'syncing' || !!document.querySelector('.chat-sync')).catch(() => false);
            if (s) { seen.first ??= Date.now() - t0; seen.last = Date.now() - t0; }
            await sleep(100);
        }
    })();
    return { stop: async () => { running = false; await done; return seen; } };
}

/** B-805: history GETs a tab issues, per session and kind (`after` = after_seq, `before` = latest page). */
function countHistoryGets(page) {
    const counts = new Map();
    page.on('request', (request) => {
        if (request.method() !== 'GET') return;
        const match = /\/v3\/sessions\/([^/]+)\/messages\?(after_seq|before_seq)=/.exec(request.url());
        if (match) counts.set(`${match[1]}:${match[2] === 'after_seq' ? 'after' : 'before'}`, (counts.get(`${match[1]}:${match[2] === 'after_seq' ? 'after' : 'before'}`) ?? 0) + 1);
    });
    return { get: (sid, kind) => counts.get(`${sid}:${kind}`) ?? 0, reset: () => counts.clear() };
}
/** The "CLI": store agent text records one by one, `gapMs` apart (pushed to every tab as `new-message`). */
async function agentSay(page, sessionId, texts, gapMs) {
    await page.evaluate(async ({ sessionId, texts, gapMs }) => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        let encryption = null;
        for (let i = 0; i < 100 && !(encryption = sync.encryption.getSessionEncryption(sessionId)); i++) await new Promise((r) => setTimeout(r, 100));
        for (const text of texts) {
            const record = {
                role: 'agent',
                content: { type: 'output', data: { type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'assistant', model: 'e2e', content: [{ type: 'text', text }] } } },
            };
            const content = await encryption.encryptRawRecord(record);
            const res = await apiSocket.request(`/v3/sessions/${sessionId}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: [{ localId: crypto.randomUUID(), content }] }),
            });
            if (!res.ok) throw new Error(`agent POST ${res.status}`);
            await new Promise((r) => setTimeout(r, gapMs));
        }
    }, { sessionId, texts, gapMs });
}
/** B-808: the "user" (another device) stores prompt records one by one, like `agentSay`. */
async function userSay(page, sessionId, texts) {
    await page.evaluate(async ({ sessionId, texts }) => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        let encryption = null;
        for (let i = 0; i < 100 && !(encryption = sync.encryption.getSessionEncryption(sessionId)); i++) await new Promise((r) => setTimeout(r, 100));
        for (const text of texts) {
            const content = await encryption.encryptRawRecord({ role: 'user', content: { type: 'text', text } });
            const res = await apiSocket.request(`/v3/sessions/${sessionId}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: [{ localId: crypto.randomUUID(), content }] }),
            });
            if (!res.ok) throw new Error(`user POST ${res.status}`);
        }
    }, { sessionId, texts });
}
async function createSessions(page, paths) {
    return page.evaluate(async (paths) => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const { encodeBase64 } = await import('/src/encryption/base64.ts');
        for (let i = 0; i < 100 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
        const ids = [];
        for (const path of paths) {
            const enc = await sync.encryption.openEncryption(null);
            // `prompt-queue-v1`: the composer's queue lives on the server (B-509) — A4's dock.
            const [metadata] = await enc.encrypt([{ path, host: 'e2e', flavor: 'claude', capabilities: ['prompt-queue-v1'] }]);
            const res = await apiSocket.request('/v1/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState: null, dataEncryptionKey: null }),
            });
            ids.push((await res.json()).session.id);
        }
        return ids;
    }, paths);
}
/** User/agent texts in the tab's reduced transcript, oldest first, that start with `prefix`. */
const transcript = (page, sessionId, prefix) => page.evaluate(async ({ sessionId, prefix }) => {
    const { storage } = await import('/src/sync/storage.ts');
    const messages = storage.getState().sessionMessages[sessionId]?.messages ?? [];
    return [...messages].reverse()
        .map((m) => (m.kind === 'user-text' || m.kind === 'agent-text' ? m.text : null))
        .filter((text) => typeof text === 'string' && text.startsWith(prefix));
}, { sessionId, prefix });
async function waitTranscript(page, sessionId, prefix, n, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if ((await transcript(page, sessionId, prefix)).length >= n) return Date.now() - t0;
        await sleep(100);
    }
    return null;
}

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

    step('create three sessions in-page (S3: never opened by any tab)');
    await page2.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 30_000, polling: 300 });
    const [S1, S2, S3] = await createSessions(page2, ['/tmp/b803-e2e-1', '/tmp/b803-e2e-2', '/tmp/b805-e2e-unopened']);
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
    const gets1 = countHistoryGets(page1);
    const gets2 = countHistoryGets(page2);
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
        const syncing = watchSyncing(page1, t0);
        await setHidden(page1, false);
        const ms = await timeUntilVisible(page1, S1, tok, HOLD_MS, t0);
        measure('B6', ms);
        check(ms !== null && ms <= CATCH_UP_LIMIT_MS, `B6 caught up ≤ ${CATCH_UP_LIMIT_MS}ms after resume`, fmt(ms));
        // B-804: the catch-up was visible, and is gone ≤ 2s after it landed.
        await sleep(2_500);
        const seen = await syncing.stop();
        measure('B6-syncing-shown', seen.first);
        check(seen.first !== null && seen.first <= 1_000, 'B6 「同步中」 shows ≤ 1000ms after the resume', fmt(seen.first));
        const goneAfter = ms === null || seen.last === null ? null : Math.max(0, seen.last - ms);
        measure('B6-syncing-gone-after-catch-up', goneAfter);
        check(goneAfter !== null && goneAfter <= 2_000 && !(await onScreen(page1, tok))?.syncing, 'B6 「同步中」 gone ≤ 2000ms after catching up', fmt(goneAfter));
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

    // ── A4: dock → transcript hand-off across background + dead link + session switch ──
    if (want('A4')) {
        step('A4 queued prompt dispatched in the background; resume GET on a dead link; switch session and back');
        const tok = token('A4');
        await page1.evaluate(({ sid, text }) => import('/src/sync/promptQueue.ts').then(({ enqueuePrompt }) => enqueuePrompt(sid, text, {})), { sid: S1, text: tok });
        await page1.waitForFunction((t) => [...document.querySelectorAll('.ci-queue-item')].some((e) => e.textContent.includes(t)), tok, { timeout: 10_000 });
        await shot(page1, 'A4-0-docked');
        proxy.stallNext('after_seq');
        proxy.blackhole();
        await setHidden(page1, true);
        await sleep(2_000);
        const authToken = await page2.evaluate(() => import('/src/sync/sync.ts').then(({ sync }) => sync['credentials'].token));
        const popped = await (await fetch(`http://127.0.0.1:${PORT}/v1/sessions/${S1}/prompt-queue/dispatch`, { method: 'POST', headers: { Authorization: `Bearer ${authToken}` } })).json();
        check(!!popped.dispatched, 'A4 the server dispatched the queue head (wrapper pop)', JSON.stringify(popped.dispatched ?? popped));
        await sleep(5_000);
        proxy.healNew();
        const t0 = Date.now();
        // Every DOM change (not a sampling interval) is checked in-page: a frame with the prompt in neither
        // the dock nor the transcript is a gap, however short.
        await page1.evaluate((t) => {
            const state = { gaps: [], dock: new Set(), transcriptSeen: false, checks: 0 };
            const check = () => {
                state.checks += 1;
                const row = [...document.querySelectorAll('.ci-queue-item')].find((e) => e.textContent.includes(t));
                const inTranscript = (document.querySelector('.cl-inner')?.textContent ?? '').includes(t);
                if (row) state.dock.add(row.getAttribute('data-queue-item-source'));
                if (inTranscript) state.transcriptSeen = true;
                if (!row && !inTranscript && state.gaps.length < 20) state.gaps.push({ at: Math.round(performance.now() - state.t0), route: location.pathname.slice(-6), body: (document.querySelector('.sd-body')?.textContent ?? '').slice(0, 60) });
            };
            state.t0 = performance.now();
            state.observer = new MutationObserver(check);
            state.observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
            window.__a4 = state;
        }, tok);
        await setHidden(page1, false);
        const settledAt = async (untilMs) => {
            while (Date.now() - t0 < untilMs) {
                const s = await onScreen(page1, tok);
                if (s?.transcript && !s.dock) return Date.now() - t0;
                await sleep(100);
            }
            return null;
        };
        await sleep(4_000);
        await shot(page1, 'A4-1-foreground');
        await nav(page1, S2);
        await sleep(1_500);
        await nav(page1, S1);
        const settledMs = await settledAt(HOLD_MS);
        await sleep(500);
        await shot(page1, 'A4-2-settled');
        const seen = await page1.evaluate(() => { const s = window.__a4; s.observer.disconnect(); return { gaps: s.gaps, dock: [...s.dock], transcriptSeen: s.transcriptSeen, checks: s.checks }; });
        // The switch away to S2 is not a gap: the prompt belongs to S1's screen.
        const gaps = seen.gaps.filter((g) => !S2.endsWith(g.route));
        console.log(`    A4 ${seen.checks} DOM checks: dock states ${seen.dock.join('→') || '-'}, transcript ${seen.transcriptSeen}, gaps on S1 ${gaps.length}`);
        if (process.env.VH_E2E_DEBUG) for (const g of gaps) console.log('    gap', JSON.stringify(g));
        measure('A4-gap-frames', gaps.length);
        measure('A4-settled', settledMs);
        check(gaps.length === 0, 'A4 the prompt is always in the dock or the transcript (every DOM change)', gaps.length ? `${gaps.length} gaps, first at +${gaps[0].at}ms: ${gaps[0].body}` : '');
        check(settledMs !== null && settledMs <= CATCH_UP_LIMIT_MS + 1_500, `A4 in the transcript with the dock empty ≤ ${CATCH_UP_LIMIT_MS + 1_500}ms after the resume (incl. the 1.5s away)`, fmt(settledMs));
        await settle('A4', page1, page2, S1, tok);
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

    // ── B-805 TURN: an agent turn costs the viewing tab no after_seq ──
    if (want('TURN')) {
        step(`TURN tab2 stores ${TURN_RECORDS} agent records 150ms apart; tab1 views the session`);
        gets1.reset();
        gets2.reset();
        const prefix = token('turn');
        const texts = Array.from({ length: TURN_RECORDS }, (_, i) => `${prefix}-${String(i + 1).padStart(3, '0')}`);
        await agentSay(page2, S1, texts, 150);
        const ms = await waitTranscript(page1, S1, prefix, TURN_RECORDS, HOLD_MS);
        await sleep(1_500);
        const seen = await transcript(page1, S1, prefix);
        check(ms !== null && JSON.stringify(seen) === JSON.stringify(texts), `TURN tab1 shows all ${TURN_RECORDS} records in order`, `${seen.length}`);
        const after = gets1.get(S1, 'after');
        count('TURN-after_seq-GETs-tab1', after);
        count('TURN-after_seq-GETs-tab2', gets2.get(S1, 'after'));
        check(after === 0, 'TURN tab1 issued 0 after_seq GETs for the turn', `${after}`);
    }

    // ── B-805 BURST: two tabs alternate 50 sends ──────────────────────
    if (want('BURST')) {
        step(`BURST tab1 and tab2 alternate ${BURST_SENDS} sends`);
        gets1.reset();
        gets2.reset();
        const prefix = token('burst');
        const sent = [[], []];
        for (let i = 1; i <= BURST_SENDS; i++) {
            const text = `${prefix}-${String(i).padStart(3, '0')}`;
            sent[i % 2].push(text);
            await send(i % 2 ? page1 : page2, text);
        }
        const a = await waitTranscript(page1, S1, prefix, BURST_SENDS, HOLD_MS);
        const b = await waitTranscript(page2, S1, prefix, BURST_SENDS, HOLD_MS);
        await sleep(2_000);
        const list1 = await transcript(page1, S1, prefix);
        const list2 = await transcript(page2, S1, prefix);
        check(a !== null && b !== null && list1.length === BURST_SENDS && list2.length === BURST_SENDS && new Set(list1).size === BURST_SENDS,
            `BURST both tabs show exactly ${BURST_SENDS}, no duplicates`, `tab1=${list1.length} tab2=${list2.length}`);
        check(JSON.stringify(list1) === JSON.stringify(list2), 'BURST same order in both tabs');
        const keeps = (own) => JSON.stringify(list1.filter((t) => own.includes(t))) === JSON.stringify(own);
        check(keeps(sent[0]) && keeps(sent[1]), 'BURST each tab\'s sends keep their send order');
        const fresh = await ctx2.newPage();
        await openSession(fresh, BASE, S1);
        await waitTranscript(fresh, S1, prefix, BURST_SENDS, 15_000);
        const server = await transcript(fresh, S1, prefix);
        await fresh.close();
        check(JSON.stringify(server) === JSON.stringify(list1), 'BURST tabs match a fresh load (server seq order)');
        count('BURST-after_seq-GETs-tab1', gets1.get(S1, 'after'));
        count('BURST-after_seq-GETs-tab2', gets2.get(S1, 'after'));
        check(gets1.get(S1, 'after') === 0 && gets2.get(S1, 'after') === 0, 'BURST 0 after_seq GETs in either tab', `${gets1.get(S1, 'after')}/${gets2.get(S1, 'after')}`);
    }

    // ── B-805 UNOPENED: a session nobody opened ───────────────────────
    if (want('UNOPENED')) {
        step('UNOPENED 5 records for a session no tab has opened');
        gets1.reset();
        gets2.reset();
        const prefix = token('unopened');
        const texts = Array.from({ length: 5 }, (_, i) => `${prefix}-${i + 1}`);
        await agentSay(page2, S3, texts, 150);
        await sleep(2_000);
        const pages = [gets1.get(S3, 'before'), gets2.get(S3, 'before')];
        const forwards = [gets1.get(S3, 'after'), gets2.get(S3, 'after')];
        count('UNOPENED-page-GETs', pages.join('/'));
        count('UNOPENED-after_seq-GETs', forwards.join('/'));
        check(pages.every((n) => n <= 1) && forwards.every((n) => n === 0), 'UNOPENED each tab: at most one page load, 0 after_seq', `before=${pages} after=${forwards}`);
        const held = await transcript(page1, S3, prefix);
        check(JSON.stringify(held) === JSON.stringify(texts), 'UNOPENED tab1 already holds every record (board previews / subagent counts)', `${held.length}`);
        await nav(page1, S3);
        const ms = await waitTranscript(page1, S3, prefix, 5, 10_000);
        check(ms !== null && JSON.stringify(await transcript(page1, S3, prefix)) === JSON.stringify(texts), 'UNOPENED opening it shows every record in order', fmt(ms));
        await nav(page1, S1);
    }

    // ── B-808 EDIT: edit and resend in a tab that opened the session from history ──
    if (want('EDIT')) {
        // `own-turn`: control — tab1 first runs a turn itself, then edits that prompt.
        for (const [which, index] of [['first', 0], ['last', 2], ['middle', 1], ['own-turn', 3]]) {
            step(`EDIT ${which}: tab1 opens a 3-turn session from history, edits prompt #${index + 1}`);
            const prefix = token(`edit${which}`);
            const [S] = await createSessions(page2, [`/tmp/b808-e2e-${which}`]);
            const seeded = [];
            for (let turn = 1; turn <= 3; turn++) {
                const prompt = `${prefix}-q${turn}`;
                const answer = `${prefix}-a${turn}`;
                await userSay(page2, S, [prompt]);
                await agentSay(page2, S, [answer], 0);
                seeded.push(prompt, answer);
            }
            await nav(page2, S);
            check(await waitTranscript(page2, S, prefix, 6, 10_000) !== null, `EDIT ${which} tab2 holds the 3 seeded turns`);
            const page = await ctx1.newPage();
            page.on('pageerror', (e) => console.log(`tab1/${which} pageerror`, e.message));
            try {
                await openSession(page, PROXY_BASE, S);
                check(await waitTranscript(page, S, prefix, 6, 15_000) !== null, `EDIT ${which} tab1 loaded the 3 turns from history`);
                if (index === 3) {
                    const prompt = `${prefix}-q4`;
                    const answer = `${prefix}-a4`;
                    await send(page, prompt);
                    await waitTranscript(page, S, prefix, 7, 5_000);
                    await agentSay(page2, S, [answer], 0);
                    check(await waitTranscript(page, S, prefix, 8, 5_000) !== null, `EDIT ${which} tab1 ran its own turn`);
                    seeded.push(prompt, answer);
                    await sleep(500);
                }
                // No agent here: the wrapper's rewind is stubbed ok. The tombstone and the new prompt are real writes.
                await page.evaluate(() => import('/src/sync/apiSocket.ts').then(({ apiSocket }) => {
                    const original = apiSocket.sessionRPC.bind(apiSocket);
                    apiSocket.sessionRPC = (sid, method, params, opts) => (method === 'conversation-rewind' ? Promise.resolve({ ok: true }) : original(sid, method, params, opts));
                }));
                const target = seeded[index * 2];
                const bubble = page.locator('.msg--user').filter({ hasText: target });
                await bubble.scrollIntoViewIfNeeded();
                await bubble.hover();
                await bubble.getByRole('button', { name: '编辑', exact: true }).click();
                const editor = page.locator('.msg-edit-inline textarea');
                const edited = `${prefix}-edited`;
                await editor.fill(edited);
                // Production order (QA6 r2dbg): the POST response beats the update
                // socket's `new-message`. Locally either can win, so make it so.
                proxy.delayDown('"new-message"', 400);
                const t0 = Date.now();
                await page.locator('.msg-edit-inline').getByRole('button', { name: '发送', exact: true }).click();
                const promptMs = await timeUntilVisible(page, S, edited, HOLD_MS, t0, { confirmed: true });
                measure(`EDIT-${which}-prompt`, promptMs);
                check(promptMs !== null && promptMs <= LIVE_LIMIT_MS, `EDIT ${which} the edited prompt is visible ≤ ${LIVE_LIMIT_MS}ms, no reload`, fmt(promptMs));
                // The "agent" answers once the new prompt is stored.
                const reply = `${prefix}-reply`;
                const t1 = Date.now();
                await agentSay(page2, S, [reply], 0);
                const replyMs = await timeUntilVisible(page, S, reply, HOLD_MS, t1);
                measure(`EDIT-${which}-reply`, replyMs);
                check(replyMs !== null && replyMs <= LIVE_LIMIT_MS, `EDIT ${which} the reply is visible ≤ ${LIVE_LIMIT_MS}ms, no reload`, fmt(replyMs));
                const expected = [...seeded.slice(0, index * 2), edited, reply];
                await waitTranscript(page2, S, prefix, expected.length, 5_000);
                await sleep(500);
                const list1 = await transcript(page, S, prefix);
                const list2 = await transcript(page2, S, prefix);
                const fresh = await ctx2.newPage();
                await openSession(fresh, BASE, S);
                await waitTranscript(fresh, S, prefix, expected.length, 15_000);
                const server = await transcript(fresh, S, prefix);
                await fresh.close();
                check(JSON.stringify(list1) === JSON.stringify(expected), `EDIT ${which} tab1 shows the rewritten transcript`, JSON.stringify(list1.map((t) => t.slice(prefix.length))));
                check(JSON.stringify(list2) === JSON.stringify(expected), `EDIT ${which} tab2 shows the same`, JSON.stringify(list2.map((t) => t.slice(prefix.length))));
                check(JSON.stringify(server) === JSON.stringify(expected), `EDIT ${which} a fresh load shows the same`, JSON.stringify(server.map((t) => t.slice(prefix.length))));
                await shot(page, `EDIT-${which}`);
            } finally {
                proxy.delayDown(null);
                await page.close();
            }
        }
        await nav(page2, S1);
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
