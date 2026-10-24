#!/usr/bin/env node
/**
 * B-799: offline bar + offline send queue, end to end in Chromium against a
 * local standalone server (docs/development.md). Not part of CI — run by hand.
 * The script starts (and, for B / C2, stops and restarts) the server itself:
 *
 *   DATA_DIR=<tmp> PORT=3199 pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts migrate
 *   VH_SERVER_URL=http://127.0.0.1:3199 pnpm -C packages/happy-web-v2 exec vite --port 8799 --strictPort
 *   node packages/happy-web-v2/e2e/offline.mjs --base http://127.0.0.1:8799 --data-dir <tmp> [--port 3199] [--out <dir>]
 *
 * Why stop the server instead of blocking routes: Playwright's routeWebSocket and CDP
 * Network.setBlockedURLs did not stop the socket.io WebSocket here, and a real outage
 * with `navigator.onLine === true` is exactly this shape (captive Wi-Fi, dead uplink,
 * server restart): connection refused, the socket retries, HTTP sends fail.
 *
 * Signs up a throwaway account, creates a session in-page (no daemon needed:
 * a message to an offline session is stored by the server), then:
 *   A. context.setOffline + socket closed → bar 「已离线，正在重连…」 within ~2s, the send
 *      button is 「离线排队」, a message sent offline still waits after the 15s send
 *      deadline, comes back → 「已恢复」 → bar gone, and the message is on the server.
 *   B. navigator.onLine stays true but the server is unreachable (dead uplink):
 *      no bar for a short outage (<8s), bar after it; a queued message survives > 15s
 *      and is delivered when the server is back.
 *   C. no false alarm: a socket blip that reconnects at once, and a background tab whose
 *      server was gone for 20s coming back (server up again), never show the bar.
 * Exit code 1 on any failed check.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
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
await startServer();

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
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', deviceScaleFactor: 2 });
await context.addInitScript(() => { try { localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch { /* ignore */ } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));

const phase = () => page.evaluate(() => document.querySelector('.net-bar')?.getAttribute('data-net-phase') ?? null);
async function waitPhase(want, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if ((await phase()) === want) return Date.now() - t0;
        await sleep(100);
    }
    return null;
}
/** Sample the bar for `ms`; returns every phase seen. */
async function watchPhases(ms) {
    const seen = new Set();
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        seen.add(await phase());
        if (process.env.VH_E2E_DEBUG) console.log('    socket', await socketStatus(), await page.evaluate(() => import('/src/sync/networkStatus.ts').then(({ networkStore }) => networkStore.getState().phase)));
        await sleep(200);
    }
    return seen;
}
const shot = async (name) => { if (OUT) await page.screenshot({ path: join(OUT, `${name}.png`) }); };
const closeSocket = () => page.evaluate(() => import('/src/sync/apiSocket.ts').then(({ apiSocket }) => apiSocket['socket']?.io?.engine?.close()));
const socketStatus = () => page.evaluate(() => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().socketStatus));
async function serverMessages(sessionId) {
    return page.evaluate(async (id) => {
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const res = await apiSocket.request(`/v3/sessions/${id}/messages?after_seq=0&limit=100`);
        return res.ok ? (await res.json()).messages.length : -1;
    }, sessionId);
}
async function sendText(text) {
    await page.locator('textarea.ci-textarea').fill(text);
    await page.locator('.ci-send').click();
}
const sendState = (text) => page.evaluate((needle) => {
    const rows = [...document.querySelectorAll('[data-send-state]')];
    const near = rows.filter((el) => el.closest('[data-message-id], .msg, .msg-row, li, article')?.textContent?.includes(needle));
    return (near.length ? near : rows).map((el) => el.getAttribute('data-send-state'));
}, text);

try {
    step('sign up');
    const username = `b799${randomBytes(4).toString('hex')}`;
    await page.goto(`${BASE}/signup`);
    const toggle = page.locator('.auth-method-toggle');
    await page.locator('input[autocomplete="username"]').or(toggle).first().waitFor({ timeout: 30_000 });
    if (!(await page.locator('input[autocomplete="username"]').isVisible())) await toggle.click();
    await page.locator('input[autocomplete="username"]').fill(username);
    const pw = `pw-${randomBytes(6).toString('hex')}`;
    const pws = page.locator('input[autocomplete="new-password"]');
    await pws.nth(0).fill(pw);
    await pws.nth(1).fill(pw);
    await page.locator('form.auth-password-form button[type="submit"]').click();
    await page.waitForFunction(() => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().socketStatus === 'connected'), null, { timeout: 30_000, polling: 300 });

    step('create a session in-page');
    await page.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 30_000, polling: 300 });
    const sessionId = await page.evaluate(async () => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const { encodeBase64 } = await import('/src/encryption/base64.ts');
        // the post-signup navigation may still be initialising the engine
        for (let i = 0; i < 100 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
        const enc = await sync.encryption.openEncryption(null);
        const [metadata] = await enc.encrypt([{ path: '/tmp/b799-e2e', host: 'e2e', flavor: 'claude' }]);
        const res = await apiSocket.request('/v1/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState: null, dataEncryptionKey: null }),
        });
        return (await res.json()).session.id;
    });
    await page.goto(`${BASE}/session/${sessionId}`);
    await page.locator('textarea.ci-textarea').waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().socketStatus === 'connected'), null, { timeout: 30_000, polling: 300 });
    for (const name of ['知道了', '暂不', 'Got it', 'Not now']) {
        for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 1_000 }).catch(() => {});
    }
    await shot('0-online');
    check((await phase()) === null, 'online: no bar');

    // ── C. no false alarms ───────────────────────────────────────────
    step('C1 socket blip that reconnects at once');
    await closeSocket();
    const blip = await watchPhases(6_000);
    check(!blip.has('offline'), 'a socket blip never shows the bar', [...blip].join(','));
    check((await socketStatus()) === 'connected', 'socket reconnected after the blip');

    step('C2 background tab with a dead socket for 20s comes back');
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await stopServer();
    await sleep(20_000);
    const hiddenPhase = await phase();
    const hiddenSocket = await socketStatus();
    check(hiddenSocket !== 'connected', 'the socket really was down while hidden', hiddenSocket);
    await startServer();
    await page.evaluate(() => {
        delete document.visibilityState;
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
    });
    const back = await watchPhases(7_000);
    check(hiddenPhase === null && !back.has('offline'), 'returning from the background is not offline', `hidden=${hiddenPhase} after=${[...back].join(',')}`);
    check((await socketStatus()) === 'connected', 'socket reconnected after the resume');

    // ── A. browser offline ───────────────────────────────────────────
    step('A browser offline (context.setOffline) + socket closed');
    await context.setOffline(true);
    await closeSocket();
    const tOffline = await waitPhase('offline', 5_000);
    check(tOffline !== null && tOffline < 3_000, 'bar 「已离线」 within ~2s of going offline', `${tOffline}ms`);
    const barText = await page.locator('.net-bar').textContent();
    check(barText?.includes('已离线，正在重连'), 'bar text', barText ?? '');
    const geometry = await page.evaluate(() => {
        const bar = document.querySelector('.net-bar').getBoundingClientRect();
        const header = [...document.querySelectorAll('header button, .sd-head button, [class*="header"] button')]
            .map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
        const top = Math.min(...header.map((r) => r.top));
        return { barBottom: bar.bottom, firstHeaderButtonTop: top, count: header.length };
    });
    check(geometry.count > 0 && geometry.firstHeaderButtonTop >= geometry.barBottom - 0.5, 'bar does not cover header buttons', JSON.stringify(geometry));
    const button = await page.locator('.ci-send').evaluate((b) => ({ state: b.dataset.offlineSend ?? null, label: b.getAttribute('aria-label'), disabled: b.disabled }));
    await page.locator('textarea.ci-textarea').fill('x');
    const buttonWithText = await page.locator('.ci-send').evaluate((b) => ({ state: b.dataset.offlineSend ?? null, label: b.getAttribute('aria-label'), disabled: b.disabled }));
    check(button.state === 'queue' && buttonWithText.state === 'queue' && !buttonWithText.disabled, 'send button is 「离线排队」 and usable', JSON.stringify(buttonWithText));
    check(buttonWithText.label === '离线排队 · 联网后自动发送', 'button label', buttonWithText.label ?? '');
    await shot('1-offline');
    const before = 0;
    await sendText('hello from offline A');
    await sleep(500);
    const waitingA = await sendState('hello from offline A');
    check(waitingA.includes('waiting'), 'the bubble says 「连接恢复后发送」', waitingA.join(','));
    await shot('2-offline-queued');
    step('A wait past the 15s send deadline');
    await sleep(18_000);
    const afterDeadline = await sendState('hello from offline A');
    check(!afterDeadline.includes('failed') && afterDeadline.includes('waiting'), 'still waiting after 18s offline (not 「发送失败」)', afterDeadline.join(','));
    step('A back online');
    await context.setOffline(false);
    const tRecovered = await waitPhase('recovered', 15_000);
    check(tRecovered !== null, '「已恢复」 shows once the socket is back', `${tRecovered}ms`);
    await shot('3-recovered');
    const recoveredText = await page.locator('.net-bar').textContent().catch(() => null);
    check(recoveredText?.includes('已恢复') ?? false, 'recovered text', recoveredText ?? '');
    const tGone = await waitPhase(null, 5_000);
    check(tGone !== null, 'the bar fades out', `${tGone}ms`);
    await page.waitForFunction((needle) => ![...document.querySelectorAll('[data-send-state="waiting"],[data-send-state="sending"]')].length, 'x', { timeout: 15_000, polling: 300 }).catch(() => {});
    const countA = await serverMessages(sessionId);
    check(countA >= before + 1, 'the queued message reached the server by itself', `server messages=${countA}`);
    const stateA = await sendState('hello from offline A');
    check(!stateA.includes('failed') && !stateA.includes('waiting'), 'the bubble is no longer pending', stateA.join(',') || '(none)');
    await shot('4-delivered');

    // ── B. dead uplink, navigator.onLine stays true ─────────────────
    step('B server unreachable while navigator.onLine is true');
    await stopServer();
    const early = await watchPhases(5_000);
    const deadSocket = await socketStatus();
    check(deadSocket !== 'connected', 'the socket really is down', deadSocket);
    check(!early.has('offline'), 'no bar during the first 5s (short reconnects are not offline)', [...early].join(','));
    const tB = await waitPhase('offline', 8_000);
    check(tB !== null, 'bar after ~8s without a socket', `${tB === null ? 'never' : `${5 + tB / 1000}s`}`);
    await sendText('hello from offline B');
    await sleep(18_000);
    const stateB = await sendState('hello from offline B');
    check(!stateB.includes('failed'), 'queued message not failed after 18s (deadline paused)', stateB.join(','));
    await shot('5-dead-uplink');
    await startServer();
    const tRecB = await waitPhase('recovered', 20_000);
    check(tRecB !== null, '「已恢复」 after the uplink is back', `${tRecB}ms`);
    await page.waitForFunction(() => ![...document.querySelectorAll('[data-send-state="waiting"],[data-send-state="sending"]')].length, null, { timeout: 15_000, polling: 300 }).catch(() => {});
    const countB = await serverMessages(sessionId);
    check(countB >= countA + 1, 'message B reached the server by itself', `server messages=${countB}`);
} catch (error) {
    failures += 1;
    console.error(error);
    await shot('error').catch(() => {});
} finally {
    await browser.close();
    await stopServer();
}
console.log(failures === 0 ? 'offline e2e: all checks passed' : `offline e2e: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
