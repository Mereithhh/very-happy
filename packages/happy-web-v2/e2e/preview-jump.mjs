#!/usr/bin/env node
/**
 * B-918 end to end: a preview pushed by session B while you are in session A
 * takes you to B (history push — 「返回」 brings you back to A with its draft,
 * attachment and transcript comment intact). Desktop and phone. Not part of
 * CI — run by hand against the production shape, set up like file-download.mjs:
 *
 *   pnpm -C packages/happy-web-v2 exec vite build && pnpm -C packages/happy-cli build
 *   (standalone server on --app with HAPPY_STATIC_DIR=…/happy-web-v2/dist, Vite dev on --dev; see csp.mjs)
 *   node packages/happy-web-v2/e2e/preview-jump.mjs --app http://127.0.0.1:3918 --dev http://127.0.0.1:8918 \
 *     --work <empty tmp dir> [--out <dir>]
 *
 * The push is real: a session-scoped socket for B emits `file-preview-push`,
 * the server stamps the source and relays it to the web clients. A real daemon
 * serves the file. Checks, per device:
 *  1. in A with a draft + attachment + comment, B pushes → URL is B, the file
 *     is open in B's panel with 「From <B>」;
 *  2. Back → A, draft / attachment / comment all still there;
 *  3. typing in A holds the jump until 2 s after the last key;
 *  4. control: A pushes while in A → no jump, no 「From」 chip;
 *  5. two tabs: only the visible one jumps; the hidden one does not follow later.
 * Exit code 1 on any failed check.
 */
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, devices } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const APP = opt('app', 'http://127.0.0.1:3918');
const DEV = opt('dev', 'http://127.0.0.1:8918');
const WORK = opt('work', null);
const OUT = opt('out', null);
if (!WORK) { console.error('--work <empty tmp dir> is required'); process.exit(2); }
mkdirSync(WORK, { recursive: true });
if (OUT) mkdirSync(OUT, { recursive: true });
const CLI = resolve(import.meta.dirname, '../../happy-cli/dist/index.mjs');
const { io } = createRequire(resolve(import.meta.dirname, '../../happy-cli/package.json'))('socket.io-client');

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

const cliEnv = { ...process.env, HAPPY_HOME_DIR: join(WORK, 'cli-home'), HAPPY_SERVER_URL: APP, HAPPY_WEBAPP_URL: APP };
for (const name of Object.keys(cliEnv)) {
    if (/^(VH_|CLAUDE_CODE_)/.test(name) || ['HAPPY_MANAGED', 'HAPPY_SPAWNED_BY', 'HAPPY_DAEMON_SUPERVISOR', 'HAPPY_SESSION_ID', 'TMUX', 'TMUX_PANE', 'CLAUDE_AGENT_SDK_VERSION', 'HAPPY_MCP_URL'].includes(name)) delete cliEnv[name];
}
cliEnv.VH_TMUX_SOCKET = join(WORK, 'tmux.sock');

const filesDir = join(WORK, 'files');
mkdirSync(filesDir, { recursive: true });
const FILE_B = join(filesDir, 'b-report.md');
const FILE_A = join(filesDir, 'a-notes.md');
const FILE_B2 = join(filesDir, 'b-second.md');
writeFileSync(FILE_B, '# Report from B\n\nPREVIEW_FROM_B — pushed by session B.\n');
writeFileSync(FILE_B2, '# Second from B\n\nSECOND_FROM_B\n');
writeFileSync(FILE_A, '# Notes from A\n\nPREVIEW_FROM_A — pushed by session A itself.\n');
const ATTACH = join(filesDir, 'attach.png');
writeFileSync(ATTACH, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const browser = await chromium.launch({ executablePath: findChromium() });
let daemonStarted = false;
const sockets = [];

/** A session process's control socket: the server stamps `sourceType: 'session'` + its id. */
async function sessionSocket(token, sessionId) {
    const socket = io(APP, { auth: { token, clientType: 'session-scoped', sessionId }, path: '/v1/updates', transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    await new Promise((ok, fail) => { socket.once('connect', ok); socket.once('connect_error', fail); });
    return socket;
}
const push = (socket, path) => socket.emit('file-preview-push', { payload: path, enc: false, mode: 'file' });
const pathOf = (page) => new URL(page.url()).pathname;
async function waitPath(page, want, ms = 8_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pathOf(page) === want) return true; await sleep(100); }
    return pathOf(page) === want;
}

async function dismissOverlays(page) {
    await page.locator('.wn-card').waitFor({ timeout: 4_000 }).catch(() => {});
    for (const name of ['Got it', 'Not now', '知道了', '暂不']) {
        for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 1_000 }).catch(() => {});
    }
}

try {
    step('sign up');
    const setup = await browser.newContext({ locale: 'en-US' });
    await setup.addInitScript(() => { try { localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch { /* */ } });
    const page0 = await setup.newPage();
    const handle = `pj${randomBytes(3).toString('hex')}`;
    const pw = `pw-${randomBytes(6).toString('hex')}`;
    await page0.goto(`${APP}/signup`);
    const toggle = page0.locator('.auth-method-toggle');
    await page0.locator('input[autocomplete="username"]').or(toggle).first().waitFor({ timeout: 30_000 });
    if (!(await page0.locator('input[autocomplete="username"]').isVisible())) await toggle.click();
    await page0.locator('input[autocomplete="username"]').fill(handle);
    const pws = page0.locator('input[autocomplete="new-password"]');
    await pws.nth(0).fill(pw);
    await pws.nth(1).fill(pw);
    await page0.locator('form.auth-password-form button[type="submit"]').click();
    await page0.locator('.sb .sb-header').waitFor({ timeout: 30_000 });
    const credentials = await page0.evaluate(() => localStorage.getItem('auth_credentials'));
    const token = JSON.parse(credentials).token;

    step('pair and start a real daemon');
    const login = spawn(process.execPath, [CLI, 'auth', 'login'], { env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let loginOut = '';
    login.stdout.on('data', (d) => { loginOut += d; });
    login.stderr.on('data', (d) => { loginOut += d; });
    const connectUrl = await (async () => {
        for (let i = 0; i < 100; i++) {
            const m = /(https?:\/\/\S+\/terminal\/connect#key=\S+)/.exec(loginOut);
            if (m) return m[1];
            await sleep(200);
        }
        throw new Error(`no pairing URL from auth login: ${loginOut.slice(0, 300)}`);
    })();
    await page0.goto(connectUrl);
    await page0.getByRole('button', { name: /approve|connect|批准|连接/i }).first().click();
    check((await new Promise((r) => login.once('exit', r))) === 0, 'CLI paired');
    const daemon = spawnSync(process.execPath, [CLI, 'daemon', 'start'], { env: cliEnv, encoding: 'utf8', timeout: 60_000 });
    daemonStarted = true;
    check(daemon.status === 0, 'daemon started', (daemon.stdout + daemon.stderr).trim().split('\n').slice(-1)[0]);
    let machineId = null;
    for (let i = 0; i < 100 && !machineId; i++) {
        const res = await fetch(`${APP}/v1/machines`, { headers: { Authorization: `Bearer ${token}` } });
        const list = res.ok ? await res.json() : [];
        machineId = (Array.isArray(list) ? list : list.machines ?? []).find((m) => m.active)?.id ?? null;
        if (!machineId) await sleep(300);
    }
    check(!!machineId, 'the machine is online');
    await setup.close();

    step('seed sessions A and B (via Vite dev)');
    const dev = await browser.newContext();
    await dev.addInitScript((creds) => { localStorage.setItem('auth_credentials', creds); }, credentials);
    const devPage = await dev.newPage();
    await devPage.goto(`${DEV}/`);
    await devPage.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 60_000, polling: 300 });
    const [A, B] = await devPage.evaluate(async ({ machineId, filesDir }) => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const { encodeBase64 } = await import('/src/encryption/base64.ts');
        for (let i = 0; i < 150 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
        const ids = [];
        for (const [title, marker] of [['Session A · writing', 'MSG_IN_A'], ['Session B · report', 'MSG_IN_B']]) {
            const dataKey = crypto.getRandomValues(new Uint8Array(32));
            const sealedKey = await sync.encryption.encryptEncryptionKey(dataKey);
            const enc = await sync.encryption.openEncryption(dataKey);
            const [metadata] = await enc.encrypt([{ path: filesDir, host: 'e2e', machineId, flavor: 'claude', summary: { text: title, updatedAt: Date.now() } }]);
            const created = await apiSocket.request('/v1/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState: null, dataEncryptionKey: encodeBase64(sealedKey, 'base64') }),
            });
            const id = (await created.json()).session.id;
            let encryption = null;
            for (let i = 0; i < 100 && !(encryption = sync.encryption.getSessionEncryption(id)); i++) {
                await sync.refreshSessions?.();
                await new Promise((r) => setTimeout(r, 200));
            }
            const record = { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'assistant', model: 'e2e', content: [{ type: 'text', text: `${marker}: this is ${title}.` }] } } } };
            await apiSocket.request(`/v3/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ localId: crypto.randomUUID(), content: await encryption.encryptRawRecord(record) }] }) });
            ids.push(id);
        }
        return ids;
    }, { machineId, filesDir });
    await dev.close();
    check(!!A && !!B, 'sessions seeded', `A=${A} B=${B}`);
    const sockA = await sessionSocket(token, A);
    const sockB = await sessionSocket(token, B);

    const DEVICES = [
        { label: 'desktop', options: { viewport: { width: 1360, height: 860 } } },
        { label: 'phone', options: { ...devices['iPhone 13'] } },
    ];
    for (const device of DEVICES) {
        const L = device.label;
        const shot = (name, page) => (OUT ? page.screenshot({ path: join(OUT, `${L}-${name}.png`) }) : null);
        const context = await browser.newContext({ ...device.options, locale: 'en-US', serviceWorkers: 'block' });
        await context.addInitScript(({ creds, A }) => {
            try {
                localStorage.setItem('auth_credentials', creds);
                localStorage.setItem('vh-pwa-install-never-v1', '1');
                // A transcript comment (B-891) on A, device-local — must survive the trip.
                if (!localStorage.getItem(`mmkv:chat-annotations:s.${A}`)) {
                    const now = Date.now();
                    localStorage.setItem(`mmkv:chat-annotations:s.${A}`, JSON.stringify([{ id: 'c1', seq: 1, quote: 'MSG_IN_A', prefix: '', suffix: '', start: 0, excerpt: 'MSG_IN_A', body: 'COMMENT_ON_A', createdAt: now, updatedAt: now }]));
                }
            } catch { /* */ }
        }, { creds: credentials, A });
        const page = await context.newPage();
        page.on('pageerror', (e) => console.log(`  [${L}] pageerror ${e.message}`));
        const composer = page.locator('textarea.ci-textarea');

        step(`${L}: in A with a draft, an attachment and a comment`);
        await page.goto(`${APP}/session/${A}`);
        await page.getByText('MSG_IN_A').first().waitFor({ timeout: 30_000 });
        await dismissOverlays(page);
        console.log(`  pointer coarse: ${await page.evaluate(() => matchMedia('(pointer: coarse)').matches)}`);
        await composer.fill('DRAFT_IN_A — half written');
        await page.locator('input[type="file"]').first().setInputFiles(ATTACH);
        await page.locator('.ci-attachments img, .ci-attachments [class*="attachment"]').first().waitFor({ timeout: 10_000 }).catch(() => {});
        const attachBefore = await page.locator('.ci-attachments').locator('img, [data-attachment-id], li, .ci-attachment').count();
        check(attachBefore > 0, `${L}: attachment staged in A`, `${attachBefore}`);
        check(await page.locator('.can-tray').count() > 0, `${L}: comment tray shown in A`);
        await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
        await sleep(2_200); // the composer was just typed into
        await shot('1-in-A', page);

        step(`${L}: B pushes a preview`);
        push(sockB, FILE_B);
        check(await waitPath(page, `/session/${B}`), `${L}: jumped to B`, pathOf(page));
        await page.getByText('PREVIEW_FROM_B').first().waitFor({ timeout: 20_000 }).catch(() => {});
        check(await page.getByText('PREVIEW_FROM_B').first().isVisible().catch(() => false), `${L}: B's file is open in B`);
        const chip = page.locator('.fsb-viewer-source');
        check((await chip.first().textContent().catch(() => '')) === 'From Session B · report', `${L}: head shows 「From <B>」`, await chip.first().textContent().catch(() => 'none'));
        await shot('2-jumped-to-B', page);

        step(`${L}: back to A`);
        await page.goBack();
        check(await waitPath(page, `/session/${A}`), `${L}: Back returns to A`, pathOf(page));
        await composer.waitFor({ timeout: 15_000 });
        check(await composer.inputValue() === 'DRAFT_IN_A — half written', `${L}: A's draft kept`, await composer.inputValue());
        const attachAfter = await page.locator('.ci-attachments').locator('img, [data-attachment-id], li, .ci-attachment').count();
        check(attachAfter === attachBefore, `${L}: A's attachment kept`, `${attachAfter}/${attachBefore}`);
        check(await page.locator('.can-tray').count() > 0, `${L}: A's comment kept`);
        await shot('3-back-in-A', page);

        step(`${L}: typing in A holds the jump`);
        await composer.click();
        // type for ~1 s, the push lands mid-typing, keep typing ~3 s more: no jump meanwhile
        let jumpedWhileTyping = false;
        for (let i = 0; i < 4; i++) { await composer.press('x'); await sleep(250); }
        const typedAt = Date.now();
        push(sockB, FILE_B2); // another file: a repeat of the one just shown would be deduped as the same preview
        for (let i = 0; i < 12; i++) { await composer.press('x'); await sleep(250); if (pathOf(page) !== `/session/${A}`) jumpedWhileTyping = true; }
        const stoppedAt = Date.now();
        check(!jumpedWhileTyping, `${L}: no jump while typing`, `${((stoppedAt - typedAt) / 1000).toFixed(1)}s of typing`);
        const jumped = await waitPath(page, `/session/${B}`, 6_000);
        const delay = Date.now() - stoppedAt;
        check(jumped && delay >= 1_500 && delay <= 3_500, `${L}: jumped ~2 s after the last key`, `${(delay / 1000).toFixed(1)}s`);
        await page.goBack();
        await waitPath(page, `/session/${A}`);
        await composer.waitFor({ timeout: 15_000 });
        const kept = await composer.inputValue();
        // the tap may put the caret mid-text: every original char and all 16 typed keys must be there
        check(kept.replace(/x/g, '') === 'DRAFT_IN_A — half written'.replace(/x/g, '') && (kept.match(/x/g) ?? []).length === 16, `${L}: draft (with the typed keys) kept`, kept);
        await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
        await sleep(2_200);

        step(`${L}: control — A pushes while in A`);
        push(sockA, FILE_A);
        await page.getByText('PREVIEW_FROM_A').first().waitFor({ timeout: 20_000 }).catch(() => {});
        await sleep(800);
        check(pathOf(page) === `/session/${A}`, `${L}: no jump for A's own push`, pathOf(page));
        check(await page.getByText('PREVIEW_FROM_A').first().isVisible().catch(() => false), `${L}: A's file opens in A`);
        check(await page.locator('.fsb-viewer-source').count() === 0, `${L}: no 「From」 chip for the own session`);
        await shot('4-control-own-push', page);

        if (L === 'desktop') {
            step(`${L}: two tabs — only the visible one jumps`);
            await page.goto(`${APP}/session/${A}`);
            const hidden = await context.newPage();
            await hidden.goto(`${APP}/session/${A}`);
            await hidden.getByText('MSG_IN_A').first().waitFor({ timeout: 30_000 });
            await hidden.evaluate(() => {
                Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
                document.dispatchEvent(new Event('visibilitychange'));
            });
            await page.getByText('MSG_IN_A').first().waitFor({ timeout: 30_000 });
            await sleep(500);
            push(sockB, FILE_B);
            check(await waitPath(page, `/session/${B}`), `${L}: visible tab jumped`);
            await sleep(1_000);
            check(pathOf(hidden) === `/session/${A}`, `${L}: hidden tab stayed`, pathOf(hidden));
            await hidden.evaluate(() => {
                Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
                document.dispatchEvent(new Event('visibilitychange'));
            });
            await sleep(1_500);
            check(pathOf(hidden) === `/session/${A}`, `${L}: hidden tab does not jump again when shown (sibling took it)`, pathOf(hidden));
            await hidden.close();
        }
        await context.close();
    }
} catch (e) {
    check(false, 'run', String(e?.stack ?? e).split('\n').slice(0, 3).join(' | '));
} finally {
    for (const s of sockets) s.close();
    if (daemonStarted) spawnSync(process.execPath, [CLI, 'daemon', 'stop'], { env: cliEnv, encoding: 'utf8', timeout: 30_000 });
    await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
