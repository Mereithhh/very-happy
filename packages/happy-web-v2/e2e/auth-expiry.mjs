#!/usr/bin/env node
/**
 * B-825: a confirmed auth failure signs the browser out locally — account key
 * (`auth_credentials`) and every `vh-sync-*` cache gone, back to the login
 * page — after the user has seen any unsent inputs; transient failures change
 * nothing. End to end in Chromium against a local standalone server and Vite
 * dev (docs/development.md). Not part of CI — run by hand:
 *
 *   DATA_DIR=<tmp> PORT=3299 pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts migrate
 *   DATA_DIR=<tmp> PORT=3299 SIGNUP_MODE=open pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts serve
 *   VH_SERVER_URL=http://127.0.0.1:3299 pnpm -C packages/happy-web-v2 exec vite --port 8825 --strictPort
 *   node packages/happy-web-v2/e2e/auth-expiry.mjs --base http://127.0.0.1:8825 --server http://127.0.0.1:3299 [--out <dir>]
 *
 *   A. unsent input + token revoked on the server → the dialog lists the input
 *      (copyable), nothing is wiped until the user confirms; then key + caches
 *      are gone and the login page shows.
 *   B. nothing unsent + token revoked → signed out at once, key + caches gone.
 *   C. 503 / 5xx / network errors on every API call → no dialog, nothing wiped,
 *      the app works again once the server answers.
 *   D. another tab signs out → this tab drops its account too.
 *   E. the socket handshake rejects the token (REST unreachable) → latch on
 *      the socket path → confirmed by /v1/account/profile → wiped.
 *   C2/C3 (B-824 §6.2 confirmation): a 401 the server does not stand by
 *      (token still valid) wipes nothing; with the confirmation unanswered the
 *      page waits and asks again when back online.
 * Exit code 1 on any failed check.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const BASE = opt('base', 'http://127.0.0.1:8825');
const SERVER = opt('server', 'http://127.0.0.1:3299');
const OUT = opt('out', null);
if (OUT) mkdirSync(OUT, { recursive: true });

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

const browser = await chromium.launch({ executablePath: findChromium() });

async function newContext() {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    await context.addInitScript(() => { try { localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch { /* ignore */ } });
    return context;
}

async function signUp(page) {
    const username = `b825${randomBytes(4).toString('hex')}`;
    await page.goto(`${BASE}/signup`);
    const toggle = page.locator('.auth-method-toggle');
    await page.locator('input[autocomplete="username"]').or(toggle).first().waitFor({ timeout: 30_000 });
    if (!(await page.locator('input[autocomplete="username"]').isVisible())) await toggle.click();
    await page.locator('input[autocomplete="username"]').fill(username);
    const pw = `pw-${randomBytes(6).toString('hex')}`;
    const pws = page.locator('input[autocomplete="new-password"]');
    await pws.nth(0).fill(pw);
    await pws.nth(1).fill(pw);
    // Several sign-ups a minute from one IP hit the auth rate limit ("…N 秒后再试"): wait it out.
    for (let attempt = 0; attempt < 4; attempt++) {
        await page.locator('form.auth-password-form button[type="submit"]').click();
        const outcome = await Promise.race([
            page.waitForFunction(() => localStorage.getItem('auth_credentials') !== null, null, { timeout: 30_000, polling: 200 }).then(() => 'ok'),
            page.waitForFunction(() => /(\d+)\s*(秒后再试|s\b|seconds)/.test(document.querySelector('form.auth-password-form')?.textContent ?? ''), null, { timeout: 30_000, polling: 200 }).then(() => 'limited'),
        ]).catch(() => 'timeout');
        if (outcome !== 'limited') break;
        const seconds = Number(/(\d+)\s*(秒后再试|s\b|seconds)/.exec(await page.locator('form.auth-password-form').textContent())?.[1] ?? 15);
        await sleep((seconds + 1) * 1_000);
    }
    // Signed up once the credentials are stored; then load a fresh document so the
    // page's module instances (Vite dev) are the ones the app initialised.
    await page.waitForFunction(() => localStorage.getItem('auth_credentials') !== null, null, { timeout: 30_000, polling: 200 }).catch(async (error) => {
        throw new Error(`signup did not store credentials (${page.url()}): ${(await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(String)).replace(/\n/g, ' | ')} — ${error.message.split('\n')[0]}`);
    });
    await page.goto(`${BASE}/`);
    await page.waitForFunction(() => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().socketStatus === 'connected'), null, { timeout: 30_000, polling: 300 });
    await page.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 30_000, polling: 300 });
}

/** The post-signup navigation can leave the first evaluate on a module instance that never gets the engine: retry from a settled page. */
async function createSession(page) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await createSessionOnce(page);
        } catch (error) {
            if (process.env.VH_E2E_DEBUG) console.log('    createSession retry', attempt, page.url(), await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/sync/sync.ts') || n.includes('AuthContext'))).catch(String));
            if (attempt >= 3) throw error;
            await page.goto(`${BASE}/`);
            await page.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 30_000, polling: 300 });
        }
    }
}

async function createSessionOnce(page) {
    return page.evaluate(async () => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const { encodeBase64 } = await import('/src/encryption/base64.ts');
        // the post-signup navigation may still be initialising the engine
        for (let i = 0; i < 100 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
        const enc = await sync.encryption.openEncryption(null);
        const [metadata] = await enc.encrypt([{ path: '/tmp/b825-e2e', host: 'e2e', flavor: 'claude' }]);
        const res = await apiSocket.request('/v1/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState: null, dataEncryptionKey: null }),
        });
        return (await res.json()).session.id;
    });
}

async function dismissOverlays(page) {
    for (const name of ['知道了', '暂不', 'Got it', 'Not now']) {
        for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 1_000 }).catch(() => {});
    }
}

/** Revoke this page's token on the server (what "sign out this device" elsewhere does). */
async function revokeOnServer(page) {
    const token = await page.evaluate(() => JSON.parse(localStorage.getItem('auth_credentials')).token);
    const res = await fetch(`${SERVER}/v1/account/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
    return res.status;
}

/** An authenticated request the app itself would make. */
const touchServer = (page) => page.evaluate(() => import('/src/sync/apiSocket.ts')
    .then(({ apiSocket }) => apiSocket.request('/v1/sessions').then((r) => r.status, (e) => `error:${e?.message ?? e}`)));

const localState = (page) => page.evaluate(async () => ({
    credentials: localStorage.getItem('auth_credentials') !== null,
    caches: (await indexedDB.databases()).map((db) => db.name).filter((name) => name?.startsWith('vh-sync-')),
    dialog: !!document.querySelector('.vh-auth-expired'),
    login: !!document.querySelector('input[autocomplete="username"], .auth-method-toggle'),
    /** An anonymous page (landing / login) offers a way to sign in. */
    anonymous: !!document.querySelector('a[href$="/login"], a[href$="/signup"], input[autocomplete="username"], .auth-method-toggle'),
}));

async function waitFor(fn, timeoutMs, label, describe = null) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeoutMs) {
        try { last = await fn(); if (last) return last; } catch { /* navigating */ }
        await sleep(200);
    }
    throw new Error(`timeout: ${label}${describe ? ` — ${JSON.stringify(await describe().catch((e) => String(e)))}` : ''}`);
}

const shot = async (page, name) => { if (OUT) await page.screenshot({ path: join(OUT, `${name}.png`) }); };

try {
    // ── A ────────────────────────────────────────────────────────────
    step('A. unsent input, then the token is revoked');
    {
        const context = await newContext();
        const page = await context.newPage();
        page.on('pageerror', (e) => console.log('pageerror', e.message));
        await signUp(page);
        const sessionId = await createSession(page);
        await page.goto(`${BASE}/session/${sessionId}`);
        await page.locator('textarea.ci-textarea').waitFor({ timeout: 30_000 });
        await dismissOverlays(page);
        // The send never reaches the server.
        await page.route('**/v3/sessions/*/messages', (route) => (route.request().method() === 'POST' ? route.abort('connectionrefused') : route.continue()));
        const text = `unsent-${randomBytes(3).toString('hex')} 第二行`;
        await page.locator('textarea.ci-textarea').fill(text);
        await page.locator('.ci-send').click();
        await sleep(1_500);
        check((await localState(page)).caches.length === 1, 'the account has its message cache');
        check((await revokeOnServer(page)) === 200, 'token revoked on the server');
        const status = await touchServer(page);
        check(status === 401, 'the next request is a 401', String(status));
        await waitFor(async () => (await localState(page)).dialog, 10_000, 'expired dialog');
        await shot(page, 'A-unsent-dialog');
        const listed = await page.locator('[data-testid="auth-expired-unsent"] li').allTextContents();
        check(listed.some((t) => t.includes(text.split(' ')[0])), 'the dialog lists the unsent input', JSON.stringify(listed));
        let state = await localState(page);
        check(state.credentials && state.caches.length === 1, 'nothing is wiped before the user confirms', JSON.stringify(state));
        await sleep(3_000);
        state = await localState(page);
        check(state.credentials && state.dialog, 'still waiting for the user 3s later');
        await page.locator('.vh-auth-expired-copy button').click();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        check(copied.includes(text), 'copy puts the unsent text on the clipboard', JSON.stringify(copied));
        await page.locator('.vh-auth-expired-actions button').click();
        state = await waitFor(async () => { const s = await localState(page); return s.login ? s : null; }, 20_000, 'login page');
        await shot(page, 'A-login');
        check(!state.credentials, 'account key removed');
        check(state.caches.length === 0, 'every vh-sync-* cache deleted', JSON.stringify(state.caches));
        await context.close();
    }

    // ── B ────────────────────────────────────────────────────────────
    step('B. nothing unsent, then the token is revoked');
    {
        const context = await newContext();
        const page = await context.newPage();
        await signUp(page);
        const sessionId = await createSession(page);
        await page.goto(`${BASE}/session/${sessionId}`);
        await page.locator('textarea.ci-textarea').waitFor({ timeout: 30_000 });
        await waitFor(async () => (await localState(page)).caches.length === 1, 10_000, 'cache opened');
        check((await revokeOnServer(page)) === 200, 'token revoked on the server');
        await touchServer(page);
        const state = await waitFor(async () => { const s = await localState(page); return s.login ? s : null; }, 20_000, 'login page');
        await shot(page, 'B-login');
        check(!state.credentials, 'signed out at once: account key removed');
        check(state.caches.length === 0, 'every vh-sync-* cache deleted', JSON.stringify(state.caches));
        await context.close();
    }

    // ── C ────────────────────────────────────────────────────────────
    step('C. 503 / 500 / network errors never sign out');
    {
        const context = await newContext();
        const page = await context.newPage();
        await signUp(page);
        const sessionId = await createSession(page);
        await page.goto(`${BASE}/session/${sessionId}`);
        await page.locator('textarea.ci-textarea').waitFor({ timeout: 30_000 });
        await waitFor(async () => (await localState(page)).caches.length === 1, 15_000, 'cache opened');
        for (const [label, handler] of [
            ['503 auth_unavailable', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"auth_unavailable"}', headers: { 'retry-after': '5' } })],
            ['500', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })],
            ['network error', (route) => route.abort('connectionreset')],
        ]) {
            await page.route(/\/v[123]\//, handler);
            const statuses = [];
            for (let i = 0; i < 3; i++) statuses.push(await touchServer(page));
            await sleep(2_000);
            const state = await localState(page);
            check(!state.dialog && state.credentials && state.caches.length === 1, `${label}: no dialog, key and cache kept`, `${statuses.join(',')} ${JSON.stringify(state)}`);
            await page.unroute(/\/v[123]\//, handler);
        }
        check((await touchServer(page)) === 200, 'the server answers again: the same token works');

        step('C2. a 401 the server does not confirm (token still valid) is a misfire');
        await page.route('**/v1/sessions', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Invalid token"}' }));
        check((await touchServer(page)) === 401, 'a forged 401 trips the latch');
        await waitFor(async () => (await page.locator('.vh-auth-expired[data-phase="valid"]').count()) > 0, 10_000, 'misfire dialog');
        let state = await localState(page);
        check(state.credentials && state.caches.length === 1, 'confirmed valid: key and cache kept', JSON.stringify(state));
        await shot(page, 'C2-misfire');
        await context.close();
    }

    step('C3. the confirmation gets no answer: wait, ask again when back online');
    {
        const context = await newContext();
        const page = await context.newPage();
        await signUp(page);
        const sessionId = await createSession(page);
        await page.goto(`${BASE}/session/${sessionId}`);
        await page.locator('textarea.ci-textarea').waitFor({ timeout: 30_000 });
        await waitFor(async () => (await localState(page)).caches.length === 1, 15_000, 'cache opened');
        check((await revokeOnServer(page)) === 200, 'token revoked on the server');
        const profileDown = (route) => route.abort('internetdisconnected');
        await page.route('**/v1/account/profile', profileDown);
        await touchServer(page);
        await waitFor(async () => (await page.locator('.vh-auth-expired[data-phase="unknown"]').count()) > 0, 15_000, 'unconfirmed dialog');
        let state = await localState(page);
        check(state.credentials && state.caches.length === 1, 'unconfirmed: nothing wiped yet', JSON.stringify(state));
        await shot(page, 'C3-unconfirmed');
        await page.unroute('**/v1/account/profile', profileDown);
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        state = await waitFor(async () => { const s = await localState(page); return !s.credentials && s.anonymous ? s : null; }, 20_000, 'signed out after the online edge');
        check(state.caches.length === 0, 'back online: confirmed 401 → key and caches gone', JSON.stringify(state));
        await context.close();
    }

    // ── D ────────────────────────────────────────────────────────────
    step('D. another tab signs out');
    {
        const context = await newContext();
        const first = await context.newPage();
        await signUp(first);
        const second = await context.newPage();
        await second.goto(`${BASE}/`);
        await second.waitForFunction(() => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().socketStatus === 'connected'), null, { timeout: 30_000, polling: 300 });
        await first.evaluate(() => import('/src/auth/AuthContext.tsx').then(({ getCurrentAuth }) => getCurrentAuth().logout()));
        const state = await waitFor(async () => { const s = await localState(second); return !s.credentials && s.anonymous ? s : null; }, 20_000, 'other tab signed out',
            async () => ({ url: second.url(), ...(await localState(second)), text: await second.evaluate(() => document.body.innerText.slice(0, 160)) }));
        check(state.caches.length === 0, 'the other tab dropped the account too (anonymous page, no cache)', JSON.stringify(state));
        await context.close();
    }
    // ── E ────────────────────────────────────────────────────────────
    step('E. the socket handshake rejects the token');
    {
        const context = await newContext();
        const page = await context.newPage();
        const logs = [];
        page.on('console', (m) => logs.push(m.text()));
        await signUp(page);
        const sessionId = await createSession(page);
        await page.goto(`${BASE}/session/${sessionId}`);
        await page.locator('textarea.ci-textarea').waitFor({ timeout: 30_000 });
        await waitFor(async () => (await localState(page)).caches.length === 1, 15_000, 'cache opened');
        check((await revokeOnServer(page)) === 200, 'token revoked on the server');
        // REST unreachable (no 401 from there) — only the socket can tell.
        await page.route(/\/v[123]\/(?!account\/profile)/, (route) => (route.request().resourceType() === 'websocket' ? route.continue() : route.abort('connectionreset')));
        await page.evaluate(() => import('/src/sync/apiSocket.ts').then(({ apiSocket }) => apiSocket['socket']?.io?.engine?.close()));
        const state = await waitFor(async () => { const s = await localState(page); return !s.credentials && s.anonymous ? s : null; }, 30_000, 'signed out via the socket',
            async () => ({ ...(await localState(page)), logs: logs.filter((l) => l.includes('[auth]')) }));
        check(logs.some((l) => l.includes('401 on socket')), 'the latch tripped on the socket handshake', logs.filter((l) => l.includes('[auth]')).join(' | '));
        check(state.caches.length === 0, 'key and caches gone', JSON.stringify(state));
        await context.close();
    }
} catch (error) {
    console.log('  ✗ aborted:', error instanceof Error ? error.message : error);
    failures += 1;
} finally {
    await browser.close();
}
console.log(failures === 0 ? 'auth-expiry e2e: all checks passed' : `auth-expiry e2e: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
