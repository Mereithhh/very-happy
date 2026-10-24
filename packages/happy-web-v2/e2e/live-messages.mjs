#!/usr/bin/env node
/**
 * B-805: live messages cost no history GET, end to end in Chromium against a
 * local standalone server (docs/development.md). Not part of CI — run by hand:
 *
 *   DATA_DIR=<tmp> PORT=3199 pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts migrate
 *   VH_SERVER_URL=http://127.0.0.1:3199 pnpm -C packages/happy-web-v2 exec vite --port 8799 --strictPort
 *   node packages/happy-web-v2/e2e/live-messages.mjs --base http://127.0.0.1:8799 --data-dir <tmp> [--port 3199] [--json <file>]
 *
 * Signs up a throwaway account and creates sessions in-page (no daemon: the
 * "agent" is a third tab that POSTs encrypted agent records the way the CLI
 * stores them; the server fans them out as `new-message` updates). Tabs A and
 * B view the session, tab C sits on the home screen and never opens it.
 *   T. one turn: A sends a prompt, the agent streams TURN records → every tab
 *      shows them and the after_seq GET count per tab is reported
 *      (before B-805: about one per record per tab; after: 0).
 *   D. A and B alternate BURST sends as fast as the composer takes them →
 *      both tabs show all of them, in the same order as the server's seq.
 *   S. records arrive for a session no tab has opened → each tab loads its
 *      latest page ONCE (board previews / subagent counts read it) and does
 *      0 after_seq; opening it in A shows every record.
 * `--report-only` prints the numbers without failing on the GET budget (used
 * to measure the pre-B-805 build). Exit code 1 on any failed check.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const BASE = opt('base', 'http://127.0.0.1:8799');
const DATA_DIR = opt('data-dir', null);
const PORT = opt('port', '3199');
const JSON_OUT = opt('json', null);
const TURN = Number(opt('turn', '30'));
const BURST = Number(opt('burst', '50'));
const REPORT_ONLY = args.includes('--report-only');
if (!DATA_DIR) {
    console.error('--data-dir <migrated standalone data dir> is required');
    process.exit(2);
}
const serverDir = resolve(import.meta.dirname, '../../happy-server');
const server = spawn(resolve(serverDir, '../../node_modules/.bin/tsx'), ['--env-file=.env.dev', './sources/standalone.ts', 'serve'], {
    cwd: serverDir,
    env: { ...process.env, DATA_DIR, PORT, METRICS_PORT: String(Number(PORT) + 6000), SIGNUP_MODE: 'open' },
    stdio: 'ignore',
});
for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* starting */ }
    if (i > 150) throw new Error('server did not come up');
    await new Promise((r) => setTimeout(r, 200));
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
/** A GET budget check; with --report-only it only reports. */
const budget = (ok, what, detail) => (REPORT_ONLY ? console.log(`  · ${what} — ${detail}`) : check(ok, what, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};

const browser = await chromium.launch({ executablePath: findChromium() });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
await context.addInitScript(() => { try { localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch { /* ignore */ } });

/** History GETs per tab and session: `${sid}:after` / `${sid}:before`. */
function countGets(page) {
    const counts = new Map();
    page.on('request', (request) => {
        if (request.method() !== 'GET') return;
        const match = /\/v3\/sessions\/([^/]+)\/messages\?(after_seq|before_seq)=/.exec(request.url());
        if (!match) return;
        const key = `${match[1]}:${match[2] === 'after_seq' ? 'after' : 'before'}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return {
        get: (sid, kind) => counts.get(`${sid}:${kind}`) ?? 0,
        reset: () => counts.clear(),
    };
}

const waitConnected = (page) => page.waitForFunction(() => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().socketStatus === 'connected'), null, { timeout: 30_000, polling: 300 });
async function dismissPrompts(page) {
    for (const name of ['知道了', '暂不', 'Got it', 'Not now']) {
        for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 1_000 }).catch(() => {});
    }
}
async function openSession(page, sid) {
    await page.goto(`${BASE}/session/${sid}`);
    await page.locator('textarea.ci-textarea').waitFor({ timeout: 30_000 });
    await waitConnected(page);
    await dismissPrompts(page);
}
async function createSession(page, tag) {
    return page.evaluate(async (path) => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const { encodeBase64 } = await import('/src/encryption/base64.ts');
        for (let i = 0; i < 100 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
        const enc = await sync.encryption.openEncryption(null);
        const [metadata] = await enc.encrypt([{ path, host: 'e2e', flavor: 'claude' }]);
        const res = await apiSocket.request('/v1/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState: null, dataEncryptionKey: null }),
        });
        return (await res.json()).session.id;
    }, `/tmp/b805-${tag}`);
}
/** The "CLI": store agent text records one by one, `gapMs` apart. */
async function agentSay(page, sid, texts, gapMs) {
    await page.evaluate(async ({ sid, texts, gapMs }) => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        await sync.refreshSessions?.();
        let encryption = null;
        for (let i = 0; i < 100 && !(encryption = sync.encryption.getSessionEncryption(sid)); i++) await new Promise((r) => setTimeout(r, 100));
        for (const text of texts) {
            const record = {
                role: 'agent',
                content: { type: 'output', data: { type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'assistant', model: 'e2e', content: [{ type: 'text', text }] } } },
            };
            const content = await encryption.encryptRawRecord(record);
            const res = await apiSocket.request(`/v3/sessions/${sid}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: [{ localId: crypto.randomUUID(), content }] }),
            });
            if (!res.ok) throw new Error(`agent POST ${res.status}`);
            await new Promise((r) => setTimeout(r, gapMs));
        }
    }, { sid, texts, gapMs });
}
/** Texts in the tab's reduced transcript (oldest first) that start with `prefix`. */
const transcript = (page, sid, prefix) => page.evaluate(async ({ sid, prefix }) => {
    const { storage } = await import('/src/sync/storage.ts');
    const messages = storage.getState().sessionMessages[sid]?.messages ?? [];
    const out = [];
    for (const m of [...messages].reverse()) {
        const text = m.kind === 'user-text' ? m.text : m.kind === 'agent-text' ? m.text : null;
        if (typeof text === 'string' && text.startsWith(prefix)) out.push(text);
    }
    return out;
}, { sid, prefix });
async function waitTranscript(page, sid, prefix, n, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if ((await transcript(page, sid, prefix)).length >= n) return Date.now() - t0;
        await sleep(100);
    }
    return null;
}

try {
    step('sign up');
    const a = await context.newPage();
    a.on('pageerror', (e) => console.log('pageerror A', e.message));
    const username = `b805${randomBytes(4).toString('hex')}`;
    await a.goto(`${BASE}/signup`);
    const toggle = a.locator('.auth-method-toggle');
    await a.locator('input[autocomplete="username"]').or(toggle).first().waitFor({ timeout: 30_000 });
    if (!(await a.locator('input[autocomplete="username"]').isVisible())) await toggle.click();
    await a.locator('input[autocomplete="username"]').fill(username);
    const pw = `pw-${randomBytes(6).toString('hex')}`;
    const pws = a.locator('input[autocomplete="new-password"]');
    await pws.nth(0).fill(pw);
    await pws.nth(1).fill(pw);
    await a.locator('form.auth-password-form button[type="submit"]').click();
    await waitConnected(a);
    await a.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 30_000, polling: 300 });

    step('create session; tabs A + B view it, C stays on home');
    const sid = await createSession(a, 'main');
    await openSession(a, sid);
    const b = await context.newPage();
    b.on('pageerror', (e) => console.log('pageerror B', e.message));
    await openSession(b, sid);
    const c = await context.newPage();
    c.on('pageerror', (e) => console.log('pageerror C', e.message));
    await c.goto(`${BASE}/`);
    await waitConnected(c);
    const getsA = countGets(a);
    const getsB = countGets(b);
    const getsC = countGets(c);
    await sleep(1_000);

    // ── T. one turn ──────────────────────────────────────────────────
    step(`T one turn: a prompt + ${TURN} agent records 150ms apart`);
    for (const g of [getsA, getsB, getsC]) g.reset();
    await a.locator('textarea.ci-textarea').fill('turn prompt');
    await a.locator('.ci-send').click();
    const turnTexts = Array.from({ length: TURN }, (_, i) => `turn-${String(i + 1).padStart(3, '0')}`);
    await agentSay(c, sid, turnTexts, 150);
    const tA = await waitTranscript(a, sid, 'turn-', TURN, 15_000);
    const tB = await waitTranscript(b, sid, 'turn-', TURN, 15_000);
    await sleep(1_500);
    const turnA = await transcript(a, sid, 'turn-');
    const turnB = await transcript(b, sid, 'turn-');
    check(tA !== null && tB !== null, `both tabs show all ${TURN} records`, `A=${turnA.length} B=${turnB.length}`);
    check(JSON.stringify(turnA) === JSON.stringify(turnTexts) && JSON.stringify(turnB) === JSON.stringify(turnTexts), 'in stored order in both tabs');
    // The board's previews / subagent counts read what the tab holds: the home tab must have them all too.
    const turnC = await transcript(c, sid, 'turn-');
    check(JSON.stringify(turnC) === JSON.stringify(turnTexts), 'home tab holds every record of the never-opened session', `C=${turnC.length}`);
    results.turn = { records: TURN, afterSeqGets: { A: getsA.get(sid, 'after'), B: getsB.get(sid, 'after'), C: getsC.get(sid, 'after') }, beforeSeqGets: { C: getsC.get(sid, 'before') } };
    console.log(`  turn after_seq GETs: A=${results.turn.afterSeqGets.A} B=${results.turn.afterSeqGets.B} C(home)=${results.turn.afterSeqGets.C}; C before_seq=${results.turn.beforeSeqGets.C}`);
    budget(results.turn.afterSeqGets.A === 0 && results.turn.afterSeqGets.B === 0, 'viewing tabs: 0 after_seq GETs in the turn', JSON.stringify(results.turn.afterSeqGets));
    budget(getsC.get(sid, 'after') === 0 && getsC.get(sid, 'before') <= 1, 'home tab: at most one page load, 0 after_seq for a session it never opened', `after=${getsC.get(sid, 'after')} before=${getsC.get(sid, 'before')}`);

    // ── D. dual-tab burst ────────────────────────────────────────────
    step(`D A and B alternate ${BURST} sends`);
    for (const g of [getsA, getsB, getsC]) g.reset();
    const sent = { A: [], B: [] };
    for (let i = 1; i <= BURST; i++) {
        const tab = i % 2 ? a : b;
        const text = `burst-${String(i).padStart(3, '0')}`;
        (i % 2 ? sent.A : sent.B).push(text);
        await tab.locator('textarea.ci-textarea').fill(text);
        await tab.locator('.ci-send').click();
    }
    const dA = await waitTranscript(a, sid, 'burst-', BURST, 30_000);
    const dB = await waitTranscript(b, sid, 'burst-', BURST, 30_000);
    await sleep(2_000);
    const burstA = await transcript(a, sid, 'burst-');
    const burstB = await transcript(b, sid, 'burst-');
    check(dA !== null && dB !== null && burstA.length === BURST && burstB.length === BURST, `both tabs show exactly ${BURST}`, `A=${burstA.length} B=${burstB.length}`);
    check(new Set(burstA).size === BURST && new Set(burstB).size === BURST, 'no duplicates');
    check(JSON.stringify(burstA) === JSON.stringify(burstB), 'same order in both tabs');
    const keepsSendOrder = (list, own) => JSON.stringify(list.filter((t) => own.includes(t))) === JSON.stringify(own);
    check(keepsSendOrder(burstA, sent.A) && keepsSendOrder(burstA, sent.B), 'each tab\'s sends keep their send order');
    // A fresh fetch from the server (seq order) must match what the tabs reduced.
    const d = await context.newPage();
    await openSession(d, sid);
    await waitTranscript(d, sid, 'burst-', BURST, 15_000);
    const burstServer = await transcript(d, sid, 'burst-');
    await d.close();
    check(JSON.stringify(burstServer) === JSON.stringify(burstA), 'tabs match a fresh load (server seq order)');
    results.burst = { sends: BURST, afterSeqGets: { A: getsA.get(sid, 'after'), B: getsB.get(sid, 'after') } };
    console.log(`  burst after_seq GETs: A=${results.burst.afterSeqGets.A} B=${results.burst.afterSeqGets.B}`);

    // ── S. never-opened session ─────────────────────────────────────
    step('S records for a session no tab has opened');
    const other = await createSession(a, 'other');
    for (const g of [getsA, getsB, getsC]) g.reset();
    const staleTexts = Array.from({ length: 5 }, (_, i) => `stale-${i + 1}`);
    await agentSay(c, other, staleTexts, 150);
    await sleep(2_000);
    const pages = [getsA, getsB, getsC].map((g) => g.get(other, 'before'));
    const forwards = [getsA, getsB, getsC].map((g) => g.get(other, 'after'));
    budget(pages.every((n) => n <= 1) && forwards.every((n) => n === 0), 'each tab: one page load at most, 0 after_seq', `before=${pages} after=${forwards}`);
    results.unopened = { records: 5, pageGets: { A: pages[0], B: pages[1], C: pages[2] }, afterSeqGets: { A: forwards[0], B: forwards[1], C: forwards[2] } };
    await openSession(a, other);
    const sOpen = await waitTranscript(a, other, 'stale-', 5, 10_000);
    check(sOpen !== null, 'opening it shows every record', `${sOpen}ms`);
    check(JSON.stringify(await transcript(a, other, 'stale-')) === JSON.stringify(staleTexts), 'in order');
} catch (error) {
    console.error(error);
    failures += 1;
} finally {
    await browser.close();
    server.kill('SIGTERM');
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
console.log(failures ? `FAILED: ${failures}` : 'OK');
process.exit(failures ? 1 : 0);
