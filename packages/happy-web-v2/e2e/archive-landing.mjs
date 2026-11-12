#!/usr/bin/env node
/**
 * B-933: repeated ⌘W must never archive a session the user has not looked at,
 * and the session the web lands on after an archive is not woken up.
 * Not part of CI — run by hand against an isolated standalone server:
 *
 *   DATA_DIR=<tmp> pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts migrate
 *   VH_SERVER_URL=http://127.0.0.1:<port> pnpm -C packages/happy-web-v2 exec vite --port <vite> --strictPort
 *   node packages/happy-web-v2/e2e/archive-landing.mjs --data-dir <tmp> --port <port> --vite http://127.0.0.1:<vite> [--out <dir>]
 *
 * The script starts the standalone server on --port, signs up a fresh account
 * in the dev page and seeds two sessions in the same place: "chat" (live) and
 * "daily" (hibernated stamp, heartbeat newer than chat's so it is the B-111
 * landing). A machine row is injected into the page store (no daemon here);
 * every machine RPC the page sends is recorded instead, so a wake attempt is
 * visible as `resume-happy-session`.
 *
 * Steps (real keyboard ⌘W, real dialog):
 *   1. on chat, ⌘W → the confirm names chat → confirm → lands on daily
 *   2. daily goes offline (the server's update) → NO resume RPC for 3 s
 *   3. ⌘W < 1 s after landing → no dialog, a toast names daily, still on daily
 *   4. ⌘W again → the confirm names daily → cancel (daily stays)
 *   5. control: open daily yourself (fresh visit) → the B-587 open-wake fires
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const DATA_DIR = opt('data-dir', null);
const PORT = Number(opt('port', '38931'));
const VITE = opt('vite', null);
const OUT = opt('out', null);
if (!DATA_DIR || !VITE) {
    console.error('--data-dir and --vite are required');
    process.exit(2);
}
if (OUT) mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serverDir = resolve(import.meta.dirname, '../../happy-server');

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

const server = spawn(resolve(serverDir, '../../node_modules/.bin/tsx'), ['--env-file=.env.dev', './sources/standalone.ts', 'serve'], {
    cwd: serverDir,
    env: { ...process.env, DATA_DIR, PORT: String(PORT), METRICS_PORT: String(PORT + 6000), SIGNUP_MODE: 'open' },
    stdio: ['ignore', 'ignore', 'inherit'],
});
for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* starting */ }
    if (i > 300) throw new Error('server did not come up');
    await sleep(200);
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const browser = await chromium.launch({ executablePath: findChromium() });
try {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 860 }, locale: 'zh-CN' });
    await ctx.addInitScript(() => {
        localStorage.setItem('vh-pwa-install-never-v1', '1');
    });
    const page = await ctx.newPage();
    const username = `b933${randomBytes(4).toString('hex')}`;
    await page.goto(`${VITE}/signup`);
    const toggle = page.locator('.auth-method-toggle');
    const usernameInput = page.locator('input[autocomplete="username"]');
    await usernameInput.or(toggle).first().waitFor({ timeout: 60_000 });
    if (!(await usernameInput.isVisible())) await usernameInput.waitFor({ timeout: 1_500 }).catch(() => toggle.click());
    await usernameInput.fill(username);
    const pw = `pw-${randomBytes(6).toString('hex')}`;
    await page.locator('input[autocomplete="new-password"]').nth(0).fill(pw);
    await page.locator('input[autocomplete="new-password"]').nth(1).fill(pw);
    await page.locator('form.auth-password-form button[type="submit"]').click();
    await page.waitForFunction(() => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().socketStatus === 'connected'), null, { timeout: 60_000, polling: 300 });
    await page.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 60_000, polling: 300 });

    const ids = await page.evaluate(async () => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const { encodeBase64 } = await import('/src/encryption/base64.ts');
        for (let i = 0; i < 150 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
        const make = async (title, extra) => {
            const enc = await sync.encryption.openEncryption(null);
            const [metadata] = await enc.encrypt([{ path: '/home/e2e/skills', host: 'e2e', machineId: 'm-e2e', flavor: 'claude', summary: { text: title, updatedAt: Date.now() }, ...extra }]);
            const res = await apiSocket.request('/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState: null, dataEncryptionKey: null }) });
            return (await res.json()).session.id;
        };
        const chat = await make('【周会】迁移确认', {});
        const daily = await make('【巡检】每日健康日报', { hibernation: { at: Date.now() - 60_000, seq: 1, idleMs: 3_600_000, v: 1 } });
        await sync.refreshSessions?.();
        return { chat, daily };
    });
    // Both online; daily heartbeats last → the most recent other session (the landing).
    const alive = (sid) => page.evaluate((s) => import('/src/sync/apiSocket.ts').then(({ apiSocket }) => apiSocket.send('session-alive', { sid: s, time: Date.now(), thinking: false })), sid);
    await alive(ids.chat);
    await sleep(300);
    await alive(ids.daily);
    const chatBeat = setInterval(() => { alive(ids.chat).catch(() => {}); }, 4_000);
    // The machine (no daemon here) + an RPC recorder.
    await page.evaluate(async () => {
        const { storage } = await import('/src/sync/storage.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        window.__rpc = [];
        apiSocket.machineRPC = async (machineId, method) => { window.__rpc.push({ machineId, method, at: Date.now() }); throw new Error('e2e: no daemon'); };
        storage.getState().applyMachines([{ id: 'm-e2e', seq: 1, createdAt: Date.now(), updatedAt: Date.now(), active: true, activeAt: Date.now(), metadata: { host: 'e2e', platform: 'linux', happyCliVersion: '0.0.0', homeDir: '/home/e2e', happyHomeDir: '/home/e2e/.happy', happyLibDir: '' }, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 }]);
    });
    await page.waitForFunction((d) => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().sessions[d]?.active === true), ids.daily, { timeout: 15_000 });

    // Navigate inside the app (keeps the patched modules).
    const go = (path) => page.evaluate((p) => { window.history.pushState(null, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
    await go(`/session/${ids.chat}`);
    await page.waitForFunction((c) => location.pathname === `/session/${c}`, ids.chat);
    await sleep(1_500);
    const dialog = page.locator('[role="dialog"], [role="alertdialog"]').last();

    // 1. ⌘W on chat → named confirm → archive → land on daily
    await page.keyboard.press('Meta+w');
    await dialog.waitFor({ timeout: 5_000 });
    const text1 = await dialog.innerText();
    check('confirm names the session being archived', text1.includes('【周会】迁移确认'), JSON.stringify(text1.slice(0, 80)));
    if (OUT) await page.screenshot({ path: join(OUT, '1-confirm-chat.png') });
    await dialog.getByRole('button', { name: /归档|Archive/ }).last().click();
    await page.waitForFunction((d) => location.pathname === `/session/${d}`, ids.daily, { timeout: 5_000 });
    const landedAt = Date.now();
    check('lands on the next session (daily)', true);

    // 3. (first, timing-critical) ⌘W within 1 s of the landing → only a toast
    await page.keyboard.press('Meta+w');
    await sleep(300);
    const dialogUp = await page.locator('[role="dialog"], [role="alertdialog"]').count();
    const toastText = await page.locator('body').innerText();
    check('⌘W < 1 s after landing does not open the archive confirm', dialogUp === 0, `dialogs=${dialogUp}, ${Date.now() - landedAt}ms after landing`);
    check('…and says which session is now open', toastText.includes('已切到「【巡检】每日健康日报」'));
    if (OUT) await page.screenshot({ path: join(OUT, '2-settle-toast.png') });

    // 2. daily goes offline (the server's update) → no wake
    await page.evaluate(async (d) => {
        const { storage } = await import('/src/sync/storage.ts');
        const s = storage.getState().sessions[d];
        storage.getState().applySessions([{ ...s, active: false }]);
    }, ids.daily);
    await sleep(3_000);
    const rpc1 = await page.evaluate(() => window.__rpc);
    check('landing page does not resume the hibernated session', !rpc1.some((r) => r.method === 'resume-happy-session'), JSON.stringify(rpc1.map((r) => r.method)));
    const banner = await page.locator('[data-testid="session-archived-banner"]').innerText().catch(() => '');
    check('the banner offers 「唤醒」 instead', banner.includes('唤醒'), JSON.stringify(banner.slice(0, 60)));
    if (OUT) await page.screenshot({ path: join(OUT, '3-landed-asleep.png') });

    // 4. ⌘W again → the confirm names daily → cancel
    await page.keyboard.press('Meta+w');
    await dialog.waitFor({ timeout: 5_000 });
    const text2 = await dialog.innerText();
    check('second ⌘W asks about the session now on screen', text2.includes('【巡检】每日健康日报'), JSON.stringify(text2.slice(0, 80)));
    if (OUT) await page.screenshot({ path: join(OUT, '4-confirm-daily.png') });
    await page.keyboard.press('Escape');
    await sleep(500);
    const dailyArchived = await page.evaluate((d) => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().sessions[d]?.archivedAt ?? null), ids.daily);
    check('cancel keeps daily', dailyArchived === null);

    // 5. control: a fresh, user-initiated open still wakes it (B-587)
    await go('/');
    await sleep(4_000); // past the landing window
    await go(`/session/${ids.daily}`);
    await sleep(2_000);
    const rpc2 = await page.evaluate(() => window.__rpc);
    check('control: opening it yourself still wakes it', rpc2.some((r) => r.method === 'resume-happy-session'), JSON.stringify(rpc2.map((r) => r.method)));
    clearInterval(chatBeat);
} finally {
    await browser.close();
    server.kill('SIGTERM');
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
