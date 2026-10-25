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
 *   stallNext   the next <n> requests whose head contains <text> ride dead links
 *   resetStalled  RST the stalled links (what an OS TCP timeout eventually does)
 * Vite's HMR socket is exempt (a reset would full-reload the page); tab1 must
 * never reload — every full document load after the first is logged as
 * `tab1 navigated (full page load)` and fails the run.
 *
 * --h2 (production shape: veryhappy.dev is CloudFront h2 + Alt-Svc h3): a
 * local TLS h2 front sits between the proxy and Vite, so all of tab1's REST
 * rides ONE connection and the WebSockets their own HTTP/1.1 ones. The proxy
 * sees only ciphertext there, so request matching (stallNext) is off and the
 * scenarios that need it (B3, LIVE, POOL, NET's socket-close half) are skipped.
 *
 * No daemon/agent is needed: a message tab2 sends is stored by the server and
 * pushed to tab1 as a `new-message` update with the next seq, exactly like an
 * agent reply would be.
 *
 * Scenarios (B-802 REPORT §4 PR-1; T = --timeout-ms, the catch-up deadline):
 *   HEALTHY (B-803b) HEALTHY_RUNS catch-ups on a healthy link → each is ONE
 *        after_seq GET (no hedge fired) and answers < HEDGE_AFTER_MS.
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
 *   POOL (B-803b) several pooled links are dead on resume: the whole link
 *        dies while hidden, tab2 sends, and the resume GET plus the next
 *        POOL_DEAD - 1 after_seq requests (hedges, the reconnect restart) each
 *        ride a dead link → caught up ≤ T + 2s.
 *   H2POOL (B-803b, --h2 only) both connection pools hold an h2 session when
 *        the link dies in the background → caught up ≤ H2_BOTH_POOLS_DEAD_LIMIT_MS
 *        (Chrome's h2 PING bound; one dead pool is B6, ~2s).
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
 * B-813 (PR-6a, the IndexedDB message cache; a third context "the phone after
 * a restart" through the proxy with RTT = CACHE_RTT_MS):
 *   COLD  a 200-record session: a fresh page opens it COLD_RUNS times with
 *         the cache and COLD_RUNS times with `vh.sync.cache=off` (today's
 *         path), each time after tab2 added a message → with the cache the
 *         newest cached record is on screen sooner (median, from navigation
 *         start) than the network page brings it; the new message is caught
 *         up (补齐) ≤ 5s; medians of both printed (`COLD-*`). On a build
 *         without the cache only the `off`-equivalent numbers are meaningful.
 *   TAMPER one session's cached row is corrupted, then a fresh page opens it
 *         → its transcript equals the server's (cold path), the other
 *         session's cache still hits.
 *   QUOTA the origin's storage quota is forced to 1 byte (CDP) → every
 *         transcript loads from the network, complete, twice in a row.
 * B-814 (PR-6b, the persistent outbox; a fourth context straight to Vite;
 * page.route makes every message POST fail on the way — retried, never
 * answered — until the page goes away):
 *   OUTBOX_REFRESH a message is sent, its POST fails on the way; the page
 *         reloads → it is on the server exactly once, under its localId.
 *         Twice: once the server never saw the POST (re-sent once), once it
 *         stored it and only the answer was lost (the latest page already holds
 *         that localId: recognised, not sent again). The outbox ends empty.
 *   OUTBOX_STALE the unsent messages' rows are aged past 10 minutes, then the
 *         page reloads → 「未发送 · 重发 / 丢弃」, nothing sent for 3s; 重发 →
 *         on the server once; a second one 丢弃 → gone, never on the server.
 *   OUTBOX_TABS two pages of one browser on the session; the first sends with
 *         its POSTs failing → the second does not send it while the first is
 *         open (3s); the first closes → the second takes it over (≤ the 15s
 *         reclaim pass) and sends it, exactly once.
 *   OUTBOX_DRAFT (B-801) a pending session's first message: the spawn RPC is
 *         stubbed (a REST-created session); the message's POST fails and the
 *         page reloads right after it landed → exactly once.
 * Prints one line per measurement (`MEASURE <scenario> <ms|never>`) for the
 * before/after table. Exit code 1 on any failed check.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import http2 from 'node:http2';
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
const DEBUG = args.includes('--debug');
// Production (veryhappy.dev behind CloudFront) speaks h2 (and offers h3): one
// multiplexed connection per origin, the socket.io WebSocket on its own
// HTTP/1.1 connection. --h2 puts a local TLS h2 front between the dead-link
// proxy and Vite so tab1 sees that shape: every REST read rides ONE pooled
// connection, and blackhole kills it as a whole.
const H2 = args.includes('--h2');
const H2_PORT = PROXY_PORT - 1;
const CATCH_UP_LIMIT_MS = TIMEOUT_MS + 2_000;
const LIVE_LIMIT_MS = 2_000;
// --h2 with BOTH connection pools (default + credentials-omit, hedgedRead.ts)
// holding a dead session: no browser-side way around them, Chrome drops them
// when its h2 PING goes unanswered (~10–14s measured). A known bound until the
// catch-up can ride the reconnected socket (B-807); asserted against regression.
const H2_BOTH_POOLS_DEAD_LIMIT_MS = 16_000;
const TURN_RECORDS = 30;
const BURST_SENDS = 50;
const POOL_DEAD = 3;
const HEALTHY_RUNS = 20;
const HEDGE_AFTER_MS = 2_000; // src/sync/hedgedRead.ts
const SYNCING_SHOW_MS = 300; // CATCH_UP_SHOW_MS, src/sync/catchUpStatus.ts
const CACHE_RTT_MS = Number(opt('cache-rtt-ms', '150')); // spec B-807 §9.3: proxy RTT 150ms
const COLD_RECORDS = 200;
const COLD_RUNS = Number(opt('cold-runs', '5'));
const COLD_RENDER_LIMIT_MS = 300; // spec B-807 G4, from the app being interactive
if (OUT) mkdirSync(OUT, { recursive: true });
if (!DATA_DIR) {
    console.error('--data-dir <migrated standalone data dir> is required');
    process.exit(2);
}
const viteUrl = new URL(BASE);
const PROXY_BASE = `${H2 ? 'https' : 'http'}://127.0.0.1:${PROXY_PORT}`;

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
    let stallLeft = 0;
    let linkSeq = 0;
    // B-813: the whole RTT on the way back, per chunk, on API and socket.io traffic only;
    // order kept (equal timeouts fire in creation order). Requests go up at once, so a
    // keep-alive link Vite is about to close never eats a delayed request. Not on the app's
    // own modules: Vite dev serves ~1000 of them; production boots from the HTTP / SW cache.
    let latencyMs = 0;
    const later = (link, fn) => (latencyMs > 0 && link.api && !link.exempt ? setTimeout(fn, latencyMs) : fn());
    const links = new Set();
    const srv = net.createServer((client) => {
        const upstream = H2 ? net.connect(H2_PORT, '127.0.0.1') : net.connect(Number(viteUrl.port), viteUrl.hostname);
        const link = { id: ++linkSeq, client, upstream, stalled: mode === 'blackhole', exempt: false };
        links.add(link);
        if (DEBUG && H2) console.log(`    [+${((Date.now() - started) / 1000).toFixed(1)}s proxy] link#${link.id} connect${link.stalled ? ' DEAD' : ''}`);
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
                if (--stallLeft <= 0) stallMatch = null;
                link.stalled = true;
            }
            if (/^(GET|POST|PUT|DELETE) /.test(head)) link.last = head.slice(0, Math.min(80, head.indexOf(' HTTP/')));
            if (/^(GET|POST|PUT|DELETE|OPTIONS|PATCH) /.test(head)) link.api = /^\S+ \/(v\d|socket\.io)\//.test(head);
            if (DEBUG && /^(GET|POST|PUT|DELETE) /.test(head)) console.log(`    [+${((Date.now() - started) / 1000).toFixed(1)}s proxy] link#${link.id}${link.stalled ? ' DEAD' : ''} ${head.slice(0, head.indexOf(' HTTP/'))}`);
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
            later(link, () => { if (!link.stalled) client.write(chunk); });
        });
        // A dead path tells the browser nothing: upstream closing must not reach a stalled link.
        const end = () => { links.delete(link); client.destroy(); upstream.destroy(); };
        // B-813: bytes still held back by the RTT reach the browser before the close does.
        const upstreamEnd = () => { if (link.stalled) { upstream.destroy(); return; } if (latencyMs > 0 && link.api) setTimeout(end, latencyMs + 5); else end(); };
        client.on('close', end);
        client.on('error', end);
        upstream.on('close', upstreamEnd);
        upstream.on('error', upstreamEnd);
    });
    return {
        listen: () => new Promise((r) => srv.listen(PROXY_PORT, '127.0.0.1', r)),
        close: () => new Promise((r) => { for (const l of links) { l.client.destroy(); l.upstream.destroy(); } srv.close(r); }),
        blackhole() { mode = 'blackhole'; for (const l of links) if (!l.exempt) l.stalled = true; },
        healNew() {
            mode = 'pass';
            if (DEBUG) console.log(`    [proxy] heal: ${this.stalledCount()} stalled links stay dead: ${[...links].filter((l) => l.stalled).map((l) => `#${l.id} ${l.last ?? '(idle since connect)'}`).join(' | ')}; exempt ${[...links].filter((l) => l.exempt).length}, open ${links.size}`);
        },
        stallNext(text, n = 1) { stallMatch = text; stallLeft = n; },
        /** B-813: RTT for API / socket.io requests through the proxy (0 = off). */
        rtt(ms) { latencyMs = ms; },
        stallsLeft: () => (stallMatch ? stallLeft : 0),
        delayDown(text, ms) { delayMatch = text ? { text, ms } : null; },
        /** --h2: the TLS front saw Vite's HMR upgrade on this upstream port (the proxy itself only sees ciphertext). */
        exemptUpstreamPort(port) {
            for (const l of links) if (l.upstream.localPort === port) { l.exempt = true; l.stalled = false; }
        },
        resetStalled() {
            for (const l of [...links]) if (l.stalled) { l.client.resetAndDestroy?.() ?? l.client.destroy(); l.upstream.destroy(); }
        },
        pass() { mode = 'pass'; stallMatch = null; stallLeft = 0; delayMatch = null; this.resetStalled(); },
        stalledCount: () => [...links].filter((l) => l.stalled).length,
    };
})();

// ── --h2: local TLS front (proxy → h2 server → Vite over HTTP/1.1) ─────
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'http2-settings', 'te']);
const h2front = H2 ? (() => {
    const dir = mkdtempSync(join(tmpdir(), 'vh-e2e-h2-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    const agent = new http.Agent({ keepAlive: true });
    const srv = http2.createSecureServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')), allowHTTP1: true });
    srv.on('request', (req, res) => {
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) if (!k.startsWith(':') && !HOP_HEADERS.has(k)) headers[k] = v;
        headers.host = req.headers[':authority'] ?? req.headers.host;
        const up = http.request({ host: viteUrl.hostname, port: viteUrl.port, method: req.method, path: req.url, headers, agent }, (upRes) => {
            const out = {};
            for (const [k, v] of Object.entries(upRes.headers)) if (!HOP_HEADERS.has(k)) out[k] = v;
            res.writeHead(upRes.statusCode, out);
            upRes.pipe(res);
        });
        up.on('error', () => res.destroy());
        res.on('close', () => { if (!res.writableFinished) up.destroy(); });
        req.pipe(up);
    });
    // WebSockets (socket.io, Vite HMR) come as HTTP/1.1 upgrades on their own connection, like on CloudFront.
    srv.on('upgrade', (req, socket, head) => {
        if (String(req.headers['sec-websocket-protocol'] ?? '').includes('vite-hmr')) proxy.exemptUpstreamPort(socket.remotePort);
        const up = net.connect(Number(viteUrl.port), viteUrl.hostname, () => {
            let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
            for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
            up.write(`${raw}\r\n`);
            if (head?.length) up.write(head);
            up.pipe(socket);
            socket.pipe(up);
        });
        const end = () => { up.destroy(); socket.destroy(); };
        up.on('error', end);
        socket.on('error', end);
        up.on('close', end);
        socket.on('close', end);
    });
    const sessions = new Set();
    srv.on('session', (session) => { sessions.add(session); session.on('close', () => sessions.delete(session)); });
    return {
        listen: () => new Promise((r) => srv.listen(H2_PORT, '127.0.0.1', r)),
        close: () => new Promise((r) => { for (const session of sessions) session.destroy(); srv.close(() => r()); setTimeout(r, 2_000); }),
    };
})() : null;

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
const NEEDS_PLAINTEXT = new Set(['B3', 'LIVE', 'POOL']);
const H2_ONLY = new Set(['H2POOL']);
const want = (name) => {
    if (ONLY && !ONLY.includes(name)) return false;
    if (!H2 && H2_ONLY.has(name)) return false;
    if (H2 && NEEDS_PLAINTEXT.has(name)) { console.log(`  - ${name} skipped under --h2 (needs request matching)`); return false; }
    return true;
};

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
    const seen = { first: null, last: null, samples: [] };
    const done = (async () => {
        while (running) {
            const s = await page.evaluate(() => document.querySelector('.net-bar')?.getAttribute('data-net-phase') === 'syncing' || !!document.querySelector('.chat-sync')).catch(() => false);
            if (s) { seen.first ??= Date.now() - t0; seen.last = Date.now() - t0; }
            // B-803b: what the chat line said, for "shown the whole time" checks
            const phase = await page.evaluate(() => document.querySelector('.chat-sync')?.getAttribute('data-sync-phase') ?? (document.querySelector('.net-bar')?.getAttribute('data-net-phase') === 'syncing' ? 'syncing' : null)).catch(() => null);
            seen.samples.push({ at: Date.now() - t0, shown: s, phase });
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
await h2front?.listen();
const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--disable-background-timer-throttling', ...(H2 ? ['--ignore-certificate-errors'] : [])],
});
const ctxOpts = { serviceWorkers: 'block', viewport: { width: 1280, height: 860 }, locale: 'zh-CN', ignoreHTTPSErrors: H2 };
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
    const usernameInput = page2.locator('input[autocomplete="username"]');
    await usernameInput.or(toggle).first().waitFor({ timeout: 60_000 });
    // The toggle can render a moment before the form it would reveal; clicking it then hides the form.
    if (!(await usernameInput.isVisible())) await usernameInput.waitFor({ timeout: 1_500 }).catch(() => toggle.click());
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
    // dev mode loads ~1000 modules: keep room for the REST entries the protocol check reads
    await ctx1.addInitScript(() => performance.setResourceTimingBufferSize(100_000));
    if (DEBUG) await ctx1.addInitScript(() => {
        const orig = window.fetch;
        window.fetch = function (input, init) {
            const url = String(input?.url ?? input);
            if (!/after_seq|before_seq|prompt-queue|\/v1\/sessions$/.test(url)) return orig.apply(this, arguments);
            const short = url.replace(/^.*?\/v[13]\//, '/').slice(0, 60);
            console.log(`[fetch] start ${short}${init?.credentials === 'omit' ? ' (omit)' : ''}`);
            const p = orig.apply(this, arguments);
            p.then((r) => console.log(`[fetch] ${r.status} ${short}`), (e) => console.log(`[fetch] fail ${short} ${e?.name}:${e?.message}`));
            return p;
        };
    });
    const page1 = await ctx1.newPage();
    let tab1PageErrors = 0;
    page1.on('pageerror', (e) => { tab1PageErrors += 1; console.log('tab1 pageerror', DEBUG ? e.stack : e.message); });
    if (DEBUG) page1.on('console', (m) => { if (/\[fetch\]|B-803|SyncSocket|liveness|restart/i.test(m.text())) console.log(`    [+${((Date.now() - started) / 1000).toFixed(1)}s tab1] ${m.text().slice(0, 200)}`); });
    // Full document loads only (an in-app route change is not a reload).
    let tab1Loaded = false;
    let tab1Reloads = 0;
    page1.on('domcontentloaded', () => {
        if (!tab1Loaded) return;
        tab1Reloads += 1;
        console.log(`    tab1 navigated (full page load) → ${page1.url().replace(PROXY_BASE, '')}`);
    });
    page1.on('requestfailed', (r) => { if (!/\/v3\/|\/v1\/|socket\.io/.test(r.url())) console.log(`    tab1 request failed ${r.url().replace(PROXY_BASE, '')} ${r.failure()?.errorText}`); });
    await openSession(page1, PROXY_BASE, S1);
    tab1Loaded = true;
    const timeOrigin = await page1.evaluate(() => performance.timeOrigin);
    // The connection shape tab1 really got (h2 = production; http/1.1 = a keep-alive pool).
    const protocols = await page1.evaluate(() => [...new Set(performance.getEntriesByType('resource')
        .filter((e) => /\/v[13]\//.test(e.name) && e.nextHopProtocol).map((e) => e.nextHopProtocol))]);
    console.log(`    tab1 REST protocol: ${protocols.join(',')}`);
    check(protocols.length === 1 && protocols[0] === (H2 ? 'h2' : 'http/1.1'), `tab1 REST rides ${H2 ? 'h2' : 'http/1.1'}`, protocols.join(','));
    const gets1 = countHistoryGets(page1);
    const gets2 = countHistoryGets(page2);
    await sleep(1_500);
    await shot(page1, '0-tab1-ready');

    // ── HEALTHY: hedging never fires on a healthy link ─────────────────
    if (want('HEALTHY')) {
        step(`HEALTHY ${HEALTHY_RUNS} catch-ups on a healthy link`);
        gets1.reset();
        const durations = await page1.evaluate(async ({ sid, n }) => {
            const { sync } = await import('/src/sync/sync.ts');
            const out = [];
            for (let i = 0; i < n; i++) {
                const t = performance.now();
                await sync['getMessagesSync'](sid).invalidateAndAwait();
                out.push(Math.round(performance.now() - t));
            }
            return out;
        }, { sid: S1, n: HEALTHY_RUNS });
        await sleep(HEDGE_AFTER_MS + 500);
        const sorted = [...durations].sort((a, b) => a - b);
        const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
        measure('HEALTHY-p95', p95);
        measure('HEALTHY-max', sorted.at(-1));
        count('HEALTHY-after_seq-GETs', gets1.get(S1, 'after'));
        check(sorted.at(-1) < HEDGE_AFTER_MS, `HEALTHY every catch-up answered < ${HEDGE_AFTER_MS}ms`, `p95 ${p95}ms, max ${sorted.at(-1)}ms`);
        check(gets1.get(S1, 'after') === HEALTHY_RUNS, `HEALTHY exactly ${HEALTHY_RUNS} after_seq GETs (0 hedges)`, `${gets1.get(S1, 'after')}`);
    }

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
        // B-803b: a catch-up that lands before CATCH_UP_SHOW_MS (300ms, catchUpStatus.ts) shows
        // nothing by design; `ms` is sampled every ~100ms, hence the slack.
        const tooFastToShow = ms !== null && ms <= SYNCING_SHOW_MS + 400;
        check(seen.first !== null ? seen.first <= 1_000 : tooFastToShow, 'B6 「同步中」 shows ≤ 1000ms after the resume (unless caught up before it is due)', seen.first === null && tooFastToShow ? `not due: caught up in ${ms}ms` : fmt(seen.first));
        const goneAfter = ms === null ? null : seen.last === null ? (tooFastToShow ? 0 : null) : Math.max(0, seen.last - ms);
        measure('B6-syncing-gone-after-catch-up', goneAfter);
        check(goneAfter !== null && goneAfter <= 2_000 && !(await onScreen(page1, tok))?.syncing, 'B6 「同步中」 gone ≤ 2000ms after catching up', fmt(goneAfter));
        // another device sends after the resume: visible ≤ 2s. Live delivery
        // rides the socket, whose own recovery (liveness probe ≤ 5s, then a
        // reconnect) is a separate clock — send once it is back.
        await waitConnected(page1, 15_000).catch(() => {});
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
        // --h2: B6 ran first, so both pools hold a (now dead) session — the H2POOL bound applies.
        const a4Limit = (H2 ? Math.max(CATCH_UP_LIMIT_MS, H2_BOTH_POOLS_DEAD_LIMIT_MS) : CATCH_UP_LIMIT_MS) + 1_500;
        check(settledMs !== null && settledMs <= a4Limit, `A4 in the transcript with the dock empty ≤ ${a4Limit}ms after the resume (incl. the 1.5s away)`, fmt(settledMs));
        await settle('A4', page1, page2, S1, tok);
    }

    // ── POOL: several dead pooled links on resume ─────────────────────
    if (want('POOL')) {
        step(`POOL the link dies in the background; the resume GET and the next ${POOL_DEAD - 1} after_seq ride dead links`);
        proxy.stallNext('after_seq', POOL_DEAD);
        proxy.blackhole();
        await setHidden(page1, true);
        const tok = token('POOL');
        await send(page2, tok);
        await sleep(30_000);
        proxy.healNew();
        const t0 = Date.now();
        await setHidden(page1, false);
        const ms = await timeUntilVisible(page1, S1, tok, HOLD_MS, t0);
        measure('POOL', ms);
        check(proxy.stallsLeft() === 0, `POOL ${POOL_DEAD} after_seq requests really rode dead links`, `left=${proxy.stallsLeft()}`);
        check(ms !== null && ms <= CATCH_UP_LIMIT_MS, `POOL caught up ≤ ${CATCH_UP_LIMIT_MS}ms after resume`, fmt(ms));
        await shot(page1, 'POOL');
        await settle('POOL', page1, page2, S1, tok);
    }

    // ── H2POOL: both connection pools dead on resume (--h2) ───────────
    if (want('H2POOL')) {
        step('H2POOL both connection pools hold an h2 session when the link dies in the background');
        // Put a session on the credentials-omit pool too (what an earlier won hedge leaves behind).
        await page1.evaluate(() => fetch('/health', { credentials: 'omit', cache: 'no-store' }).then((r) => r.status));
        proxy.blackhole();
        await setHidden(page1, true);
        const tok = token('H2POOL');
        await send(page2, tok);
        await sleep(30_000);
        const dead = proxy.stalledCount();
        proxy.healNew();
        const t0 = Date.now();
        const syncing = watchSyncing(page1, t0);
        await setHidden(page1, false);
        const ms = await timeUntilVisible(page1, S1, tok, HOLD_MS, t0);
        const seen = await syncing.stop();
        measure('H2POOL', ms);
        // The user waits up to ~14s here: 「同步消息中…」 / 「连接不稳定 · 重试」 must say so the whole time.
        const during = seen.samples.filter((x) => x.at >= 1_000 && ms !== null && x.at <= ms - 300);
        const blank = during.filter((x) => !x.shown);
        const phases = [...new Set(seen.samples.map((x) => x.phase).filter(Boolean))];
        console.log(`    H2POOL indicator: first ${seen.first}ms, phases ${phases.join('→') || '-'}, ${during.length} samples, ${blank.length} blank`);
        check(seen.first !== null && seen.first <= 1_000, 'H2POOL 「同步中」 shows ≤ 1000ms after the resume', fmt(seen.first));
        check(during.length > 0 && blank.length === 0, 'H2POOL the sync line stays on screen until caught up', blank.length ? `blank at +${blank[0].at}ms` : `${during.length} samples`);
        check(dead >= 3, 'H2POOL both h2 sessions (and the socket) were dead', `dead links=${dead}`);
        check(ms !== null && ms <= H2_BOTH_POOLS_DEAD_LIMIT_MS, `H2POOL caught up ≤ ${H2_BOTH_POOLS_DEAD_LIMIT_MS}ms (Chrome h2 PING bound)`, fmt(ms));
        await settle('H2POOL', page1, page2, S1, tok);
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

        if (!H2) {
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
                    // The agent answers a prompt the server holds — not its optimistic bubble
                    // (B-814: the POST now waits for its outbox row, a few ms).
                    await timeUntilVisible(page, S, prompt, 5_000, Date.now(), { confirmed: true });
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
    // ── B-813: the IndexedDB message cache ("the phone after a restart") ──
    if (want('COLD') || want('TAMPER') || want('QUOTA')) {
        const phoneContext = async () => {
            const ctx = await browser.newContext(ctxOpts);
            await ctx.addInitScript((entries) => {
                if (sessionStorage.getItem('b803-seeded')) return;
                sessionStorage.setItem('b803-seeded', '1');
                for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
            }, storageDump);
            return ctx;
        };
        const cacheStats = (page) => page.evaluate(() => import('/src/sync/cache/syncCache.ts').then(({ syncCache }) => syncCache.stats(), () => null));
        const flushCache = (page) => page.evaluate(() => import('/src/sync/cache/syncCache.ts').then(({ syncCache }) => syncCache.flush(), () => null));
        /**
         * A fresh page opens `sid` through the proxy. A MutationObserver stamps
         * (performance.now(), i.e. ms since navigation start) when the composer
         * appears and when each of `marks` is first in the transcript DOM.
         */
        const coldOpen = async (ctx, sid, marks, { timeoutMs = 30_000 } = {}) => {
            const page = await ctx.newPage();
            page.on('pageerror', (e) => console.log('phone pageerror', e.message));
            if (DEBUG) {
                page.on('requestfailed', (r) => console.log(`    phone request failed ${r.url().replace(PROXY_BASE, '')} ${r.failure()?.errorText}`));
                page.on('console', (m) => { if (m.type() === 'error' || m.text().includes('💬 cache')) console.log(`    phone console ${m.text().slice(0, 300)}`); });
            }
            await page.addInitScript((marks) => {
                const seen = (window.__vhMarks = {});
                const check = () => {
                    const now = Math.round(performance.now());
                    if (seen.composer === undefined && document.querySelector('textarea.ci-textarea')) seen.composer = now;
                    const text = document.querySelector('.cl-inner')?.textContent ?? '';
                    for (const mark of marks) if (seen[mark] === undefined && text.includes(mark)) seen[mark] = now;
                };
                new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
            }, marks);
            await page.goto(`${PROXY_BASE}/session/${sid}`, { waitUntil: 'commit' });
            const t0 = Date.now();
            let result = {};
            while (Date.now() - t0 < timeoutMs) {
                result = await page.evaluate(() => ({ ...window.__vhMarks })).catch(() => ({}));
                if (marks.every((mark) => result[mark] !== undefined)) break;
                await sleep(50);
            }
            if (DEBUG) {
                console.log(`    [coldOpen ${sid.slice(-6)}] ${JSON.stringify(result)} url=${page.url()} body=${JSON.stringify((await page.evaluate(() => document.body?.innerText ?? '').catch((e) => e.message)).slice(0, 200))}`);
                await shot(page, `cold-${Date.now()}`);
            }
            await dismissDialogs(page);
            return { page, marks: result };
        };
        const median = (xs) => { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
        const filler = 'x'.repeat(800); // production ciphertext P50 ≈ 1.1KB (spec B-807 §10)
        const [SC, ST] = await createSessions(page2, ['/tmp/b813-cold', '/tmp/b813-tamper']);
        const coldPrefix = token('cold');
        const coldTexts = Array.from({ length: COLD_RECORDS }, (_, i) => `${coldPrefix}-${i + 1}-${filler}`);
        // Turns of one prompt + nine agent records, so both paths paint the same B-616 window.
        for (let i = 0; i < COLD_RECORDS; i += 10) {
            await userSay(page2, SC, [coldTexts[i]]);
            await agentSay(page2, SC, coldTexts.slice(i + 1, i + 10), 0);
        }
        const lastCold = `${coldPrefix}-${COLD_RECORDS}-`;
        const phone = await phoneContext();
        try {
            if (want('COLD')) {
                step(`COLD ${COLD_RUNS}× cache on / off, ${COLD_RECORDS} records, proxy RTT ${CACHE_RTT_MS}ms`);
                const runs = { on: [], off: [] };
                for (let run = 0; run < COLD_RUNS; run++) {
                    for (const mode of ['on', 'off']) {
                        // Warm (unmeasured): the cache holds the session's run.
                        proxy.rtt(0);
                        const warm = await coldOpen(phone, SC, [lastCold]);
                        await warm.page.evaluate((mode) => { if (mode === 'off') localStorage.setItem('vh.sync.cache', 'off'); else localStorage.removeItem('vh.sync.cache'); }, mode);
                        await sleep(300);
                        await flushCache(warm.page);
                        await warm.page.close();
                        // While no phone page is open, "another device" writes — the cold open must catch it up.
                        const fresh = token(`cold-new-${mode}`);
                        await userSay(page2, SC, [fresh]);
                        proxy.rtt(CACHE_RTT_MS);
                        const { page, marks } = await coldOpen(phone, SC, [lastCold, fresh]);
                        const stats = await cacheStats(page);
                        proxy.rtt(0);
                        const entry = { app: marks.composer ?? null, cached: marks[lastCold] ?? null, caughtUp: marks[fresh] ?? null, hits: stats?.hits ?? null };
                        runs[mode].push(entry);
                        console.log(`    COLD ${mode} #${run + 1}: composer ${entry.app}ms, last record ${entry.cached}ms, new message ${entry.caughtUp}ms (cache hits ${entry.hits})`);
                        await page.evaluate(() => localStorage.removeItem('vh.sync.cache'));
                        await page.close();
                    }
                }
                for (const mode of ['on', 'off']) {
                    measure(`COLD-${mode}-composer`, median(runs[mode].map((r) => r.app)));
                    measure(`COLD-${mode}-last-record`, median(runs[mode].map((r) => r.cached)));
                    measure(`COLD-${mode}-caught-up`, median(runs[mode].map((r) => r.caughtUp)));
                    measure(`COLD-${mode}-record-after-composer`, median(runs[mode].map((r) => (r.cached !== null && r.app !== null ? r.cached - r.app : null))));
                }
                const on = runs.on;
                const hasCache = on.every((r) => r.hits !== null);
                if (!hasCache) {
                    console.log('  - COLD: this build has no message cache (baseline run) — only the numbers above');
                } else {
                    check(on.every((r) => r.hits >= 1), 'COLD every cache-on open was a cache hit', JSON.stringify(on.map((r) => r.hits)));
                    // Informational: the composer's own time varies ±250ms between runs (session list), so this
                    // difference is noisy; spec G4 (≤300ms on a mid-range Android) is a real-device item.
                    const afterComposer = on.map((r) => (r.cached !== null && r.app !== null ? r.cached - r.app : null));
                    console.log(`    COLD cached record after the composer: ${JSON.stringify(afterComposer)} (G4 target ${COLD_RENDER_LIMIT_MS}ms, real device)`);
                    check(on.every((r) => r.caughtUp !== null && r.caughtUp <= 5_000), 'COLD the message written meanwhile is caught up (补齐) ≤ 5s', JSON.stringify(on.map((r) => r.caughtUp)));
                    check(median(on.map((r) => r.cached)) < median(runs.off.map((r) => r.cached)), 'COLD with the cache the transcript is up sooner than without', `${median(on.map((r) => r.cached))}ms vs ${median(runs.off.map((r) => r.cached))}ms`);
                }
                check(runs.off.every((r) => r.caughtUp !== null), 'COLD without the cache every open shows the new message too');
            }

            if (want('TAMPER')) {
                step('TAMPER corrupt one session\'s cached row, then open both from a fresh page');
                const tamperPrefix = token('tamper');
                const tamperTexts = [1, 2, 3].map((i) => `${tamperPrefix}-${i}`);
                await userSay(page2, ST, tamperTexts);
                for (const sid of [SC, ST]) {
                    const warm = await coldOpen(phone, sid, sid === SC ? [lastCold] : tamperTexts);
                    await sleep(300);
                    await flushCache(warm.page);
                    await warm.page.close();
                }
                const victim = await coldOpen(phone, SC, [lastCold]);
                const corrupted = await victim.page.evaluate(async (sid) => {
                    const names = (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith('vh-sync-'));
                    const db = await new Promise((resolve, reject) => { const r = indexedDB.open(names[0]); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
                    const done = await new Promise((resolve) => {
                        const tx = db.transaction('messages', 'readwrite');
                        const store = tx.objectStore('messages');
                        const range = IDBKeyRange.bound([sid, 0], [sid, Infinity]);
                        const req = store.getAll(range);
                        req.onsuccess = () => {
                            const rows = req.result;
                            const row = rows[1];
                            store.put({ ...row, content: { t: 'encrypted', c: 'Z2FyYmFnZQ==' } });
                            tx.oncomplete = () => resolve(rows.length);
                        };
                    });
                    db.close();
                    return done;
                }, ST);
                await victim.page.close();
                check(corrupted === 3, 'TAMPER corrupted one of the 3 cached rows', `${corrupted}`);
                const opened = await coldOpen(phone, ST, tamperTexts);
                const statsAfter = await cacheStats(opened.page);
                const shown = await transcript(opened.page, ST, tamperPrefix);
                check(JSON.stringify(shown) === JSON.stringify(tamperTexts), 'TAMPER the corrupted session shows the server transcript', JSON.stringify(shown));
                check((statsAfter?.drops?.decrypt ?? 0) >= 1 && (statsAfter?.misses ?? 0) >= 0, 'TAMPER its cache was dropped (decrypt), not used', JSON.stringify(statsAfter?.drops));
                await nav(opened.page, SC);
                await waitTranscript(opened.page, SC, coldPrefix, COLD_RECORDS, 15_000);
                const statsOther = await cacheStats(opened.page);
                check((statsOther?.hits ?? 0) >= 1, 'TAMPER the other session still opens from the cache', `hits ${statsOther?.hits}`);
                await opened.page.close();
            }
        } finally {
            proxy.rtt(0);
            await phone.close();
        }

        if (want('QUOTA')) {
            // 1 byte: the database cannot even be created; 60KB: it opens, the newest page (~120KB of ciphertext) does not fit.
            for (const quotaSize of (opt("quota-sizes", "1,60000")).split(",").map(Number)) {
                step(`QUOTA storage quota forced to ${quotaSize} bytes → the network path, twice`);
                const ctx = await phoneContext();
                try {
                    const probePage = await ctx.newPage();
                    const cdp = await ctx.newCDPSession(probePage);
                    await cdp.send('Storage.overrideQuotaForOrigin', { origin: PROXY_BASE, quotaSize });
                    for (const round of [1, 2]) {
                        const t0 = Date.now();
                        const { page, marks } = await coldOpen(ctx, SC, [lastCold]);
                        await sleep(1_000);
                        await flushCache(page);
                        const stats = await cacheStats(page);
                        const shown = await transcript(page, SC, coldPrefix);
                        console.log(`    QUOTA ${quotaSize}B round ${round}: ${shown.length} records, last at ${marks[lastCold] ?? 'never'}ms, cache ${JSON.stringify(stats)}`);
                        check(marks[lastCold] !== undefined && shown.length >= 90 && shown.at(-1)?.startsWith(lastCold),
                            `QUOTA ${quotaSize}B round ${round}: the transcript loads from the network`, `${shown.length} records in ${Date.now() - t0}ms`);
                        check(stats !== null && stats.hits === 0 && (stats.quotaErrors > 0 || stats.state === 'disabled' || stats.readOnly),
                            `QUOTA ${quotaSize}B round ${round}: the cache hit the quota and served nothing`, `state ${stats?.state} readOnly ${stats?.readOnly} quotaErrors ${stats?.quotaErrors} writeErrors ${stats?.writeErrors} ${stats?.disabledReason ?? ''}`);
                        await page.close();
                    }
                    await probePage.close();
                } finally {
                    await ctx.close();
                }
            }
        }
    }

    // ── B-814: the persistent outbox (a fresh browser context, straight to Vite) ──
    if (want('OUTBOX_REFRESH') || want('OUTBOX_STALE') || want('OUTBOX_TABS') || want('OUTBOX_DRAFT')) {
        const ctx = await browser.newContext(ctxOpts);
        await ctx.addInitScript((entries) => {
            if (sessionStorage.getItem('b803-seeded')) return;
            sessionStorage.setItem('b803-seeded', '1');
            for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
        }, storageDump);
        const isPost = (request) => request.method() === 'POST' && /\/v3\/sessions\/[^/]+\/messages$/.test(request.url());
        const localIdsOf = (request) => JSON.parse(request.postData() ?? '{}').messages?.map((m) => m.localId) ?? [];
        /**
         * Every message POST of this page fails on the way (the app keeps
         * retrying it, as on a dead link): `before` = the server never sees it,
         * `after` = the server stores it and only the answer is lost. Aborted,
         * not left hanging: a hanging intercepted request would be let through
         * when the page closes.
         */
        const holdPosts = async (page, mode) => {
            const held = [];
            await page.route('**/v3/sessions/*/messages', async (route) => {
                if (!isPost(route.request())) return route.fallback();
                held.push(localIdsOf(route.request()));
                if (mode === 'after') await route.fetch().catch(() => {});
                await route.abort('connectionreset').catch(() => {});
            });
            return held;
        };
        /** From now on, let this page's message POSTs through and record them. */
        const passPosts = async (page) => {
            await page.unroute('**/v3/sessions/*/messages');
            const seen = [];
            await page.route('**/v3/sessions/*/messages', async (route) => {
                if (isPost(route.request())) seen.push(localIdsOf(route.request()));
                await route.fallback();
            });
            return seen;
        };
        /** Sent from the page's own send path (not the composer, which may queue a second prompt on the server). */
        const sendDirect = (page, sid, text) => page.evaluate(({ sid, text }) => import('/src/sync/sync.ts').then(({ sync }) => sync.sendMessage(sid, text, { source: 'chat' })), { sid, text });
        const outboxRows = (page) => page.evaluate(() => import('/src/sync/cache/syncCache.ts').then(({ outboxStore }) => outboxStore.all()));
        const waitRows = async (page, n, timeoutMs = 5_000) => {
            const t0 = Date.now();
            while (Date.now() - t0 < timeoutMs) { if ((await outboxRows(page)).length >= n) return true; await sleep(50); }
            return false;
        };
        /** What the server holds: every message of `sid`, decrypted by tab2, oldest first. */
        const serverTexts = (sid, prefix) => page2.evaluate(async ({ sid, prefix }) => {
            const { sync } = await import('/src/sync/sync.ts');
            const { apiSocket } = await import('/src/sync/apiSocket.ts');
            const res = await apiSocket.request(`/v3/sessions/${sid}/messages?after_seq=0&limit=500`);
            const { messages } = await res.json();
            const decrypted = await sync.encryption.getSessionEncryption(sid).decryptMessages(messages);
            return decrypted.map((m) => m?.content?.content?.text).filter((t) => typeof t === 'string' && t.startsWith(prefix));
        }, { sid, prefix });
        const waitServer = async (sid, prefix, n, timeoutMs) => {
            const t0 = Date.now();
            while (Date.now() - t0 < timeoutMs) { if ((await serverTexts(sid, prefix)).length >= n) return Date.now() - t0; await sleep(200); }
            return null;
        };
        const openFresh = async (sid) => {
            const page = await ctx.newPage();
            page.on('pageerror', (e) => console.log('outbox pageerror', e.message));
            await openSession(page, BASE, sid);
            return page;
        };
        const [SO, SS, SD] = await createSessions(page2, ['/tmp/b814-refresh', '/tmp/b814-stale', '/tmp/b814-tabs']);
        try {
            if (want('OUTBOX_REFRESH')) {
                for (const mode of ['before', 'after']) {
                    step(`OUTBOX_REFRESH the POST fails (${mode === 'before' ? 'never reached the server' : 'stored, answer lost'}), then the page reloads`);
                    const page = await openFresh(SO);
                    const held = await holdPosts(page, mode);
                    const text = token(`outbox-refresh-${mode}`);
                    await send(page, text);
                    check(await waitRows(page, 1), `OUTBOX_REFRESH ${mode}: the row is in IndexedDB before the page goes away`);
                    const t1 = Date.now();
                    while (held.length === 0 && Date.now() - t1 < 5_000) await sleep(50);
                    check(held.length === 1, `OUTBOX_REFRESH ${mode}: its POST was on the wire`, JSON.stringify(held));
                    const posts = await passPosts(page);
                    const t0 = Date.now();
                    await page.reload();
                    await page.locator('textarea.ci-textarea').waitFor({ timeout: 60_000 });
                    const ms = await timeUntilVisible(page, SO, text, 20_000, t0, { confirmed: true });
                    measure(`OUTBOX_REFRESH-${mode}`, ms);
                    check(ms !== null, `OUTBOX_REFRESH ${mode}: after the reload it is shown confirmed`, fmt(ms));
                    await sleep(1_500);
                    const onServer = await serverTexts(SO, text);
                    check(onServer.length === 1, `OUTBOX_REFRESH ${mode}: on the server exactly once`, JSON.stringify(onServer));
                    check((await transcript(page, SO, text)).length === 1, `OUTBOX_REFRESH ${mode}: one bubble`);
                    // `after`: the latest page already holds it (same localId) — nothing left to send.
                    check(mode === 'before'
                        ? posts.length === 1 && posts[0].length === 1 && posts[0][0] === held[0][0]
                        : posts.length <= 1 && posts.flat().every((id) => id === held[0][0]),
                        `OUTBOX_REFRESH ${mode}: ${mode === 'before' ? 're-sent once, with the same localId' : 'not re-sent under another localId (the stored copy is recognised)'}`, JSON.stringify(posts));
                    check((await outboxRows(page)).length === 0, `OUTBOX_REFRESH ${mode}: the outbox is empty again`);
                    await page.close();
                }
            }

            if (want('OUTBOX_STALE')) {
                step('OUTBOX_STALE unsent messages aged past 10 minutes → 「未发送 · 重发 / 丢弃」 after the reload');
                const page = await openFresh(SS);
                await holdPosts(page, 'before');
                const keep = token('outbox-stale-keep');
                const drop = token('outbox-stale-drop');
                await sendDirect(page, SS, keep);
                await sendDirect(page, SS, drop);
                check(await waitRows(page, 2), 'OUTBOX_STALE both rows are in IndexedDB');
                // Eleven minutes ago, as far as the outbox can tell.
                await page.evaluate(async () => {
                    const { outboxStore } = await import('/src/sync/cache/syncCache.ts');
                    const rows = await outboxStore.all();
                    await outboxStore.put(rows.map((row) => ({ ...row, createdAt: Date.now() - 11 * 60_000 })));
                });
                const posts = await passPosts(page);
                await page.reload();
                await page.locator('textarea.ci-textarea').waitFor({ timeout: 60_000 });
                let stale = null;
                for (let i = 0; i < 100 && stale === null; i++) {
                    const n = await page.locator('[data-send-state="stale"]').count();
                    if (n >= 2) stale = n; else await sleep(100);
                }
                await shot(page, 'outbox-stale');
                check(stale === 2, 'OUTBOX_STALE both show 「未发送」 with 重发 / 丢弃', `${stale}`);
                const labels = await page.locator('[data-send-state="stale"]').first().innerText();
                check(/未发送/.test(labels) && /重发/.test(labels) && /丢弃/.test(labels), 'OUTBOX_STALE the row reads 「未发送 · 重发 · 丢弃」', JSON.stringify(labels));
                await sleep(3_000);
                check(posts.length === 0 && (await serverTexts(SS, 'outbox-stale')).length === 0, 'OUTBOX_STALE nothing is sent on its own', JSON.stringify(posts));
                // 重发 the first, 丢弃 the second (rows are newest last on screen).
                const clickIn = async (text, label) => page.evaluate(({ text, label }) => {
                    for (const status of document.querySelectorAll('[data-send-state="stale"]')) {
                        let node = status;
                        while (node && !(node.textContent ?? '').includes(text)) node = node.parentElement;
                        if (!node) continue;
                        const button = [...status.querySelectorAll('button')].find((b) => b.textContent === label);
                        if (button) { button.click(); return true; }
                    }
                    return false;
                }, { text, label });
                check(await clickIn(keep, '重发'), 'OUTBOX_STALE 重发 clicked');
                const resent = await waitServer(SS, keep, 1, 10_000);
                check(resent !== null, 'OUTBOX_STALE 重发 → on the server', fmt(resent));
                check(await clickIn(drop, '丢弃'), 'OUTBOX_STALE 丢弃 clicked');
                await sleep(2_000);
                check((await serverTexts(SS, keep)).length === 1, 'OUTBOX_STALE the resent one is there exactly once');
                check((await serverTexts(SS, drop)).length === 0, 'OUTBOX_STALE the discarded one never reached the server');
                check((await transcript(page, SS, drop)).length === 0, 'OUTBOX_STALE the discarded one is gone from the transcript');
                check((await outboxRows(page)).length === 0, 'OUTBOX_STALE the outbox is empty again');
                await page.close();
            }

            if (want('OUTBOX_TABS')) {
                step('OUTBOX_TABS two pages; the sender\'s POSTs fail; it closes → the other takes over, exactly once');
                const owner = await openFresh(SD);
                const other = await openFresh(SD);
                const otherPosts = await passPosts(other);
                await holdPosts(owner, 'before');
                const text = token('outbox-tabs');
                await send(owner, text);
                check(await waitRows(owner, 1), 'OUTBOX_TABS the row is in IndexedDB');
                await sleep(3_000);
                check(otherPosts.length === 0, 'OUTBOX_TABS the other page leaves it alone while its tab is open', JSON.stringify(otherPosts));
                await owner.close();
                const ms = await waitServer(SD, text, 1, 40_000);
                measure('OUTBOX_TABS-takeover', ms);
                check(ms !== null, 'OUTBOX_TABS the other page takes it over and sends it (≤ reclaim interval + send)', fmt(ms));
                await sleep(2_000);
                check((await serverTexts(SD, text)).length === 1, 'OUTBOX_TABS on the server exactly once');
                check(otherPosts.flat().length === 1, 'OUTBOX_TABS one POST from the other page', JSON.stringify(otherPosts));
                const shown = await timeUntilVisible(other, SD, text, 5_000, Date.now(), { confirmed: true });
                check(shown !== null && (await transcript(other, SD, text)).length === 1, 'OUTBOX_TABS the other page shows it once');
                check((await outboxRows(other)).length === 0, 'OUTBOX_TABS the outbox is empty again');
                await other.close();
            }

            if (want('OUTBOX_DRAFT')) {
                step('OUTBOX_DRAFT (B-801) a pending session\'s first message, POST failing, page reloaded right after it landed');
                const page = await ctx.newPage();
                page.on('pageerror', (e) => console.log('outbox pageerror', e.message));
                await page.goto(`${BASE}/`);
                await waitConnected(page, 60_000);
                await dismissDialogs(page);
                await holdPosts(page, 'before');
                const text = token('outbox-draft');
                const sid = await page.evaluate(async (text) => {
                    const { apiSocket } = await import('/src/sync/apiSocket.ts');
                    const { sync } = await import('/src/sync/sync.ts');
                    const { storage } = await import('/src/sync/storage.ts');
                    const { encodeBase64 } = await import('/src/encryption/base64.ts');
                    const { pendingSessions } = await import('/src/sync/pendingSessionsRuntime.ts');
                    let created = null;
                    // No daemon here: the spawn RPC creates the session over REST, like a daemon would.
                    apiSocket.machineRPC = async () => {
                        const enc = await sync.encryption.openEncryption(null);
                        const [metadata] = await enc.encrypt([{ path: '/tmp/b814-draft', host: 'e2e', flavor: 'claude' }]);
                        const res = await apiSocket.request('/v1/sessions', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState: null, dataEncryptionKey: null }),
                        });
                        created = (await res.json()).session.id;
                        return { type: 'success', sessionId: created };
                    };
                    const record = pendingSessions.create({ machineId: 'e2e-machine', path: '/tmp/b814-draft', agent: 'claude', permissionMode: 'default', source: 'quick', firstMessage: text });
                    for (let i = 0; i < 300; i++) {
                        const current = pendingSessions.get(record.pendingId);
                        if (current?.state === 'landed' && created && storage.getState().sessionMessages[created]) return created;
                        await new Promise((r) => setTimeout(r, 50));
                    }
                    throw new Error(`pending session did not land: ${JSON.stringify(pendingSessions.get(record.pendingId))}`);
                }, text);
                check(await waitRows(page, 1), 'OUTBOX_DRAFT the first message is in the outbox before its record let go of it');
                await passPosts(page);
                await page.goto(`${BASE}/session/${sid}`);
                await page.locator('textarea.ci-textarea').waitFor({ timeout: 60_000 });
                const ms = await timeUntilVisible(page, sid, text, 20_000, Date.now(), { confirmed: true });
                check(ms !== null, 'OUTBOX_DRAFT after the reload the first message is shown confirmed', fmt(ms));
                await sleep(1_500);
                check((await serverTexts(sid, text)).length === 1, 'OUTBOX_DRAFT on the server exactly once', JSON.stringify(await serverTexts(sid, text)));
                check((await transcript(page, sid, text)).length === 1, 'OUTBOX_DRAFT one bubble');
                await page.close();
            }
        } finally {
            await ctx.close();
        }
    }

    check(tab1PageErrors === 0, 'tab1 raised no page error (e.g. an unhandled 「Superseded by restart」)', `${tab1PageErrors}`);
    check(tab1Reloads === 0 && await page1.evaluate(() => performance.timeOrigin) === timeOrigin, 'tab1 never reloaded the page', `${tab1Reloads} full page load(s)`);
} catch (error) {
    failures += 1;
    console.error(error);
} finally {
    await browser.close().catch(() => {});
    await proxy.close().catch(() => {});
    await h2front?.close().catch(() => {});
    await stopServer();
}
console.log(`MEASURES ${JSON.stringify(Object.fromEntries(measures))}`);
console.log(failures === 0 ? 'sync-resume e2e: all checks passed' : `sync-resume e2e: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
