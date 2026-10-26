#!/usr/bin/env node
/**
 * B-836 in-app feedback, end to end in Chromium against a local standalone
 * server and Vite dev (docs/development.md). The script starts the server
 * itself (it has to restart it once, to name the admin it just signed up).
 * Not part of CI — run by hand:
 *
 *   DATA_DIR=<tmp> PORT=3836 pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts migrate
 *   VH_SERVER_URL=http://127.0.0.1:3836 pnpm -C packages/happy-web-v2 exec vite --port 8836 --strictPort
 *   DATA_DIR=<tmp> node packages/happy-web-v2/e2e/feedback.mjs --base http://127.0.0.1:8836 --port 3836 [--out <dir>]
 *
 *   1. entries: /help → 发送反馈, /feedback redirects, the phone's 更多 ▾ lists it
 *   2. form (phone, touch): rating + text + diagnostics shown = sent (route as /session/:id, no session id), toast
 *   3. prompt card (phone): appears once due, one tap submits, details amend the same row
 *   4. cross-device: the user's desktop tab does not ask again (synced shownAt)
 *   5. rate limit: past MAX_FEEDBACK_PER_ACCOUNT_PER_HOUR the form says so
 *   6. admin (desktop): 收到的反馈 lists the rows with the sender's name, mark read
 *   7. 不再提示 holds after a reload
 * Exit code 1 on any failed check.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const BASE = opt('base', 'http://127.0.0.1:8836');
const PORT = opt('port', '3836');
const SERVER = `http://127.0.0.1:${PORT}`;
const OUT = opt('out', null);
const DATA_DIR = process.env.DATA_DIR;
if (!DATA_DIR) throw new Error('DATA_DIR is required (the standalone server data directory)');
if (OUT) mkdirSync(OUT, { recursive: true });
const SERVER_PKG = resolve(dirname(fileURLToPath(import.meta.url)), '../../happy-server');
const PROMPT_WAIT_MS = 45_000; // FEEDBACK_PROMPT_DELAY_MS (20 s) + boot

const DEVICES = {
    desktop: { viewport: { width: 1280, height: 860 } },
    phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
};

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
const shot = async (page, name) => { if (OUT) await page.screenshot({ path: join(OUT, `${name}.png`) }); };

// --- the server, owned by this script (stopped by its own pid only) ----------
let server = null;
async function startServer(extraEnv = {}) {
    // Only what the server needs; the team / Claude env of this shell stays out.
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR, PORT, SIGNUP_MODE: 'open', ...extraEnv };
    // Its own process group: tsx forks the real server, and stopping must take both down.
    server = spawn(join(SERVER_PKG, '../../node_modules/.bin/tsx'), ['--env-file=.env.dev', './sources/standalone.ts', 'serve'], { cwd: SERVER_PKG, env, stdio: ['ignore', 'ignore', 'inherit'], detached: true });
    for (let i = 0; i < 120; i++) {
        try { if ((await fetch(`${SERVER}/health`)).ok) return; } catch { /* booting */ }
        await sleep(500);
    }
    throw new Error('server did not come up');
}
async function stopServer() {
    if (!server) return;
    const proc = server;
    server = null;
    const exited = new Promise((r) => { proc.once('exit', r); setTimeout(r, 10_000); });
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already gone */ }
    await exited;
    // The port must be free before the next start, or its health check would pass on the old server.
    for (let i = 0; i < 40; i++) {
        try { await fetch(`${SERVER}/health`); } catch { return; }
        await sleep(250);
    }
    throw new Error(`port ${PORT} still answers after stopping the server`);
}

const browser = await chromium.launch({ executablePath: findChromium() });

async function newContext(device, credentials = null) {
    const context = await browser.newContext({ ...DEVICES[device], locale: 'zh-CN', serviceWorkers: 'block' });
    await context.addInitScript((creds) => {
        try {
            localStorage.setItem('vh-pwa-install-never-v1', '1');
            // The onboarding cards own the prompt's corner and it waits for them (unit-tested); keep them out of the way.
            localStorage.setItem('vh-notif-optin-dismissed-v1', '1');
            if (creds && !localStorage.getItem('auth_credentials')) localStorage.setItem('auth_credentials', creds);
        } catch { /* ignore */ }
    }, credentials);
    return context;
}

async function signUp(page, prefix) {
    const username = `${prefix}${randomBytes(3).toString('hex')}`;
    await page.goto(`${BASE}/signup`);
    const toggle = page.locator('.auth-method-toggle');
    await page.locator('input[autocomplete="username"]').or(toggle).first().waitFor({ timeout: 30_000 });
    if (!(await page.locator('input[autocomplete="username"]').isVisible())) await toggle.click();
    await page.locator('input[autocomplete="username"]').fill(username);
    const pw = `pw-${randomBytes(6).toString('hex')}`;
    const pws = page.locator('input[autocomplete="new-password"]');
    await pws.nth(0).fill(pw);
    await pws.nth(1).fill(pw);
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
    await page.waitForFunction(() => localStorage.getItem('auth_credentials') !== null, null, { timeout: 30_000, polling: 200 });
    const credentials = await page.evaluate(() => localStorage.getItem('auth_credentials'));
    const token = JSON.parse(credentials).token;
    const profile = await (await fetch(`${SERVER}/v1/account/profile`, { headers: { Authorization: `Bearer ${token}` } })).json();
    return { username, credentials, token, id: profile.id };
}

async function boot(page, path = '/') {
    await page.goto(`${BASE}${path}`);
    await page.waitForFunction(() => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().settingsVersion !== null), null, { timeout: 30_000, polling: 300 });
    // Release notes would hold the notice turn (and the prompt rule skips while they are unread).
    await page.evaluate(() => import('/src/app/changelogReadStore.ts').then(({ acknowledgeAllChangelog }) => acknowledgeAllChangelog()));
    for (let i = 0; i < 8 && (await page.locator('.wn-card').count()) > 0; i++) {
        await page.locator('.wn-card .wn-done').click({ timeout: 1_000 }).catch(() => {});
        await sleep(200);
    }
    for (const name of ['知道了', '暂不']) {
        for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 1_000 }).catch(() => {});
    }
    // A fresh password account gets the sign-in methods card in the prompt's corner; the prompt waits for it (by design).
    await page.locator('.signin-nudge__close').click({ timeout: 3_000 }).catch(() => {});
}

/** One session, so the phone's root is the session list (with the chip row), not the first-run page. */
async function createSession(page) {
    await page.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 30_000, polling: 300 });
    return page.evaluate(async () => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const { encodeBase64 } = await import('/src/encryption/base64.ts');
        const enc = await sync.encryption.openEncryption(null);
        const [metadata] = await enc.encrypt([{ path: '/tmp/b836-e2e', host: 'e2e', flavor: 'claude' }]);
        const res = await apiSocket.request('/v1/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState: null, dataEncryptionKey: null }),
        });
        return (await res.json()).session.id;
    });
}
const sortedJson = (value) => JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

const settings = (page) => page.evaluate(() => import('/src/sync/storage.ts').then(({ storage }) => {
    const s = storage.getState().settings;
    return { activeDays: s.feedbackActiveDays, lastDay: s.feedbackLastActiveDay, shownAt: s.feedbackPromptShownAt, optOut: s.feedbackPromptOptOut, submittedAt: s.feedbackLastSubmittedAt };
}));
const applySettings = (page, patch) => page.evaluate(async (p) => {
    const { sync } = await import('/src/sync/sync.ts');
    sync.applySettings(p);
    // let the debounced settings write reach the server
    await new Promise((r) => setTimeout(r, 2500));
}, patch);
const tap = async (page, locator) => { if ((await page.evaluate(() => matchMedia('(pointer: coarse)').matches))) await locator.tap(); else await locator.click(); };
const adminList = (token) => fetch(`${SERVER}/v1/feedback/admin?limit=50`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());

try {
    step('server (no admin yet) + sign up user and admin');
    await startServer();
    const userCtx = await newContext('phone');
    const userPage = await userCtx.newPage();
    const user = await signUp(userPage, 'fbuser');
    const adminCtx = await newContext('desktop');
    const adminPage = await adminCtx.newPage();
    const admin = await signUp(adminPage, 'fbadmin');
    check(!!user.id && !!admin.id, 'both accounts exist', `${user.username} / ${admin.username}`);

    step('restart with VH_FEEDBACK_ADMIN_ACCOUNT_IDS=<admin> and a 3/hour limit');
    await stopServer();
    await startServer({ VH_FEEDBACK_ADMIN_ACCOUNT_IDS: admin.id, MAX_FEEDBACK_PER_ACCOUNT_PER_HOUR: '3' });

    step('1. entries (phone)');
    await boot(userPage, '/');
    await createSession(userPage);
    await boot(userPage, '/help');
    await tap(userPage, userPage.locator('[data-action="feedback"]'));
    await userPage.waitForURL(/\/settings\/feedback$/, { timeout: 10_000 });
    check(true, '/help → 发送反馈 opens /settings/feedback');
    await userPage.goto(`${BASE}/feedback`);
    await userPage.waitForURL(/\/settings\/feedback$/, { timeout: 10_000 }).then(() => check(true, '/feedback redirects'), () => check(false, '/feedback redirects', userPage.url()));
    await boot(userPage, '/');
    const more = userPage.locator('.sb-chip-more');
    if (await more.count()) {
        await tap(userPage, more);
        const item = userPage.getByRole('menuitem', { name: '发送反馈' });
        check(await item.isVisible().catch(() => false), 'phone 更多 ▾ lists 发送反馈');
        await shot(userPage, '1-phone-more-menu');
        await userPage.keyboard.press('Escape');
    } else {
        await shot(userPage, '1-phone-no-more-chip');
        check(false, 'phone 更多 ▾ chip present');
    }

    step('2. form (phone) — diagnostics shown = sent');
    // Leave from a session-shaped route so the recorded page has an id in it.
    await userPage.goto(`${BASE}/session/cmvph7gqg03ifrz2uk2cweyto`);
    await sleep(1500);
    await userPage.evaluate(() => { history.pushState(null, '', '/settings/feedback'); dispatchEvent(new PopStateEvent('popstate')); });
    await userPage.locator('.fb-form').waitFor({ timeout: 15_000 });
    await tap(userPage, userPage.locator('.fb-form .fb-rating-btn[data-rating="bad"]'));
    await userPage.locator('.fb-form textarea').fill('E2E: 手机上切回会话时最新消息要等几秒');
    await tap(userPage, userPage.locator('.fb-form .fb-diag-toggle'));
    const shown = JSON.parse(await userPage.locator('.fb-form .fb-diag-json').textContent());
    check(shown.route === '/session/:id', 'diagnostics route is a pattern', shown.route);
    check(!JSON.stringify(shown).includes('cmvph7gqg03ifrz2uk2cweyto'), 'no session id in the payload');
    await shot(userPage, '2-phone-form');
    await tap(userPage, userPage.locator('.fb-form button[type="submit"]'));
    await userPage.getByText('已发送，谢谢反馈').waitFor({ timeout: 10_000 }).then(() => check(true, 'sent toast'), () => check(false, 'sent toast'));
    let rows = (await adminList(admin.token)).items;
    check(rows[0]?.text === 'E2E: 手机上切回会话时最新消息要等几秒' && rows[0]?.rating === 'bad', 'server stored the form row');
    check(sortedJson(rows[0]?.diagnostics) === sortedJson(shown), 'stored diagnostics equal what the form showed');

    step('3. prompt card (phone): due → one tap → details');
    await applySettings(userPage, { feedbackActiveDays: 5, feedbackPromptShownAt: null, feedbackLastSubmittedAt: null, feedbackPromptOptOut: false });
    await boot(userPage, '/');
    const card = userPage.locator('.fb-prompt');
    await card.waitFor({ timeout: PROMPT_WAIT_MS }).then(() => check(true, 'prompt card appears once due'), async () => {
        const why = await userPage.evaluate(async () => ({
            corner: [...document.querySelectorAll('.pwa-install, .notif-optin, .signin-nudge, .cli-update, .mrb')].map((e) => e.className),
            pending: (await import('/src/app/changelogReadStore.ts')).changelogReadState(),
            deepLink: (await import('/src/app/entryKind.ts')).enteredByDeepLink(),
            holder: (await import('/src/app/overlayQueue.ts')).currentOverlay(),
            path: location.pathname,
        }));
        console.log('  prompt debug:', JSON.stringify(why), JSON.stringify(await settings(userPage)));
        await shot(userPage, '3-phone-no-prompt');
        check(false, 'prompt card appears once due');
    });
    await shot(userPage, '3-phone-prompt');
    check(typeof (await settings(userPage)).shownAt === 'number', 'showing recorded in synced settings');
    await tap(userPage, card.locator('.fb-rating-btn[data-rating="good"]'));
    await card.locator('textarea').waitFor({ timeout: 10_000 });
    rows = (await adminList(admin.token)).items;
    check(rows[0]?.source === 'prompt' && rows[0]?.rating === 'good' && rows[0]?.diagnostics === null, 'one tap stored a prompt row without diagnostics');
    await card.locator('textarea').fill('E2E: 补充一句');
    await shot(userPage, '3-phone-prompt-details');
    await tap(userPage, card.getByRole('button', { name: '补充发送' }));
    await card.waitFor({ state: 'detached', timeout: 10_000 }).then(() => check(true, 'card closes after 补充发送'), () => check(false, 'card closes after 补充发送'));
    rows = (await adminList(admin.token)).items;
    check(rows[0]?.text === 'E2E: 补充一句' && rows[0]?.diagnostics?.route === '/', 'details amended the same row', JSON.stringify(rows[0]?.diagnostics?.route));
    check(rows.length === 2, 'amend did not create a row', String(rows.length));

    step('4. cross-device: the desktop tab does not ask again');
    const userDesk = await newContext('desktop', user.credentials);
    const deskPage = await userDesk.newPage();
    await boot(deskPage, '/');
    await sleep(PROMPT_WAIT_MS);
    check((await deskPage.locator('.fb-prompt').count()) === 0, 'no prompt on the other device (synced shownAt / submittedAt)');

    step('5. rate limit (3/hour)');
    await deskPage.goto(`${BASE}/settings/feedback`);
    await deskPage.locator('.fb-form').waitFor({ timeout: 15_000 });
    const sendForm = async (text) => {
        await deskPage.locator('.fb-form .fb-rating-btn[data-rating="ok"]').click();
        await deskPage.locator('.fb-form textarea').fill(text);
        await deskPage.locator('.fb-form button[type="submit"]').click();
    };
    await sendForm('E2E: third');
    await deskPage.getByText('已发送，谢谢反馈').waitFor({ timeout: 10_000 });
    await sendForm('E2E: fourth');
    await deskPage.getByText('提交太频繁了，请稍后再试').waitFor({ timeout: 10_000 }).then(() => check(true, '429 shows 提交太频繁'), () => check(false, '429 shows 提交太频繁'));
    check(await deskPage.locator('.fb-form textarea').inputValue() === 'E2E: fourth', 'text kept after 429');
    await shot(deskPage, '5-desktop-rate-limited');

    step('6. admin inbox (desktop)');
    await boot(adminPage, '/settings/feedback');
    const entry = adminPage.getByText(/收到的反馈 · 3 条未读/);
    await entry.waitFor({ timeout: 15_000 }).then(() => check(true, 'admin sees 收到的反馈 · 3 条未读'), () => check(false, 'admin sees 收到的反馈 · 3 条未读'));
    await entry.click();
    await adminPage.locator('.fb-inbox-row').first().waitFor({ timeout: 15_000 });
    const who = await adminPage.locator('.fb-inbox-row .fb-inbox-who').first().textContent();
    check(who.includes(user.username) && !who.includes('@'), 'rows name the sender, not a bare id', who);
    await shot(adminPage, '6-desktop-inbox');
    await adminPage.locator('.fb-inbox-row').first().getByRole('button', { name: '标为已读' }).click();
    await adminPage.getByText(/收到的反馈 · 2 条未读/).first().waitFor({ timeout: 10_000 }).then(() => check(true, 'mark read lowers the count'), () => check(false, 'mark read lowers the count'));
    await userPage.goto(`${BASE}/settings/feedback/inbox`);
    await sleep(2500);
    check((await userPage.locator('.fb-inbox-row').count()) === 0, 'a non-admin sees no rows at /settings/feedback/inbox');

    step('7. 不再提示 holds');
    await applySettings(userPage, { feedbackPromptShownAt: null, feedbackLastSubmittedAt: null });
    await boot(userPage, '/');
    await card.waitFor({ timeout: PROMPT_WAIT_MS });
    await tap(userPage, card.getByRole('button', { name: '不再提示' }));
    await sleep(2500);
    check((await settings(userPage)).optOut === true, 'opt-out written to synced settings');
    await applySettings(userPage, { feedbackPromptShownAt: null });
    await boot(userPage, '/');
    await sleep(PROMPT_WAIT_MS);
    check((await userPage.locator('.fb-prompt').count()) === 0, 'no prompt after 不再提示');
} catch (error) {
    console.error(error);
    failures += 1;
} finally {
    await browser.close();
    await stopServer();
}
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
