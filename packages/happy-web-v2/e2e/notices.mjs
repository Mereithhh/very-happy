#!/usr/bin/env node
/**
 * B-982 global notices, end to end in Chromium against a local standalone
 * server (started by this script with VH_INSTANCE_CONFIG_FILE) and Vite dev.
 * Not part of CI — run by hand:
 *
 *   DATA_DIR=<tmp> PORT=3982 pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts migrate
 *   VH_SERVER_URL=http://127.0.0.1:3982 pnpm -C packages/happy-web-v2 exec vite --port 8982 --strictPort
 *   DATA_DIR=<tmp> node packages/happy-web-v2/e2e/notices.mjs --base http://127.0.0.1:8982 --port 3982 [--out <dir>]
 *
 *   1. account B (desktop) sees only the notice for everyone (info card)
 *   2. account A (phone, touch) sees the newer warning addressed to it by username
 *   3. 知道了 on the phone stores the id in synced settings and shows the next notice
 *   4. A's desktop tab does not show the dismissed notice (cross-device)
 *   5. a non-dismissible notice has no 知道了, only a close for this load, and is back after a reload
 * Exit code 1 on any failed check.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const BASE = opt('base', 'http://127.0.0.1:8982');
const PORT = opt('port', '3982');
const SERVER = `http://127.0.0.1:${PORT}`;
const OUT = opt('out', null);
const DATA_DIR = process.env.DATA_DIR;
if (!DATA_DIR) throw new Error('DATA_DIR is required (the standalone server data directory)');
if (OUT) mkdirSync(OUT, { recursive: true });
const SERVER_PKG = resolve(dirname(fileURLToPath(import.meta.url)), '../../happy-server');
const CONFIG_FILE = join(DATA_DIR, 'instance-config.json');

const DEVICES = {
    desktop: { viewport: { width: 1280, height: 860 } },
    phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
};

function findChromium() {
    for (const dir of [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]) {
        if (!existsSync(dir)) continue;
        for (const entry of readdirSync(dir).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
            for (const rel of ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
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

let server = null;
async function startServer() {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR, PORT, SIGNUP_MODE: 'open', VH_INSTANCE_CONFIG_FILE: CONFIG_FILE };
    server = spawn(join(SERVER_PKG, '../../node_modules/.bin/tsx'), ['--env-file=.env.dev', './sources/standalone.ts', 'serve'], { cwd: SERVER_PKG, env, stdio: ['ignore', 'ignore', 'inherit'], detached: true });
    for (let i = 0; i < 120; i++) {
        try { if ((await fetch(`${SERVER}/health`)).ok) return; } catch { /* booting */ }
        await sleep(500);
    }
    throw new Error('server did not come up');
}
function stopServer() {
    if (!server) return;
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
    server = null;
}

const browser = await chromium.launch({ executablePath: findChromium() });

async function newContext(device, credentials = null, colorScheme = 'light') {
    const context = await browser.newContext({ ...DEVICES[device], locale: 'zh-CN', colorScheme, serviceWorkers: 'block' });
    await context.addInitScript((creds) => {
        try {
            localStorage.setItem('vh-pwa-install-never-v1', '1');
            localStorage.setItem('vh-notif-optin-dismissed-v1', '1');
            if (creds && !localStorage.getItem('auth_credentials')) localStorage.setItem('auth_credentials', creds);
        } catch { /* ignore */ }
    }, credentials);
    return context;
}

async function signUp(page, username) {
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
    await page.waitForFunction(() => localStorage.getItem('auth_credentials') !== null, null, { timeout: 30_000, polling: 200 });
    return page.evaluate(() => localStorage.getItem('auth_credentials'));
}

/** Loads the app, clears the release notes and the sign-in methods card — never a notice's own buttons. */
async function boot(page, path = '/') {
    await page.goto(`${BASE}${path}`);
    await page.waitForFunction(() => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().settingsVersion !== null), null, { timeout: 30_000, polling: 300 });
    await page.evaluate(() => import('/src/app/changelogReadStore.ts').then((m) => m.markChangelogReleasesRead(m.currentPendingChangelog().map((r) => r.id))));
    for (let i = 0; i < 8 && (await page.locator('.wn-card').count()) > 0; i++) {
        await page.locator('.wn-card .wn-done').click({ timeout: 1_000 }).catch(() => {});
        await sleep(200);
    }
    await page.locator('.signin-nudge__close').click({ timeout: 3_000 }).catch(() => {});
}
const cardTitle = async (page) => {
    await page.locator('.gn-card').waitFor({ timeout: 20_000 }).catch(() => {});
    return (await page.locator('.gn-card h2').textContent().catch(() => null))?.trim() ?? null;
};
const tap = async (page, locator) => { if ((await page.evaluate(() => matchMedia('(pointer: coarse)').matches))) await locator.tap(); else await locator.click(); };
const dismissed = (page) => page.evaluate(() => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().settings.dismissedNoticeIds));

const suffix = randomBytes(3).toString('hex');
const userA = `ntca${suffix}`;
writeFileSync(CONFIG_FILE, JSON.stringify({
    notices: [
        { id: 'welcome', title: '欢迎使用', body: '新功能说明见 https://docs.example.com/notices 。有问题在设置里发送反馈。', startsAt: '2026-11-01T00:00:00Z' },
        { id: `maint-${suffix}`, title: '今晚 23:00 维护', body: '服务器会重启约 5 分钟，正在运行的会话会自动重连。\n状态页：https://status.example.com', level: 'warning', audience: { accounts: [userA] }, startsAt: '2026-11-20T00:00:00Z' },
        { id: 'broken', title: 'x', level: 'loud' },
    ],
}));

try {
    step('server with an instance config file + two accounts');
    await startServer();
    const phoneCtx = await newContext('phone');
    const phone = await phoneCtx.newPage();
    const credsA = await signUp(phone, userA);
    const bCtx = await newContext('desktop');
    const bPage = await bCtx.newPage();
    await signUp(bPage, `ntcb${suffix}`);

    step('1. desktop, account B: only the notice for everyone');
    await boot(bPage);
    check((await cardTitle(bPage)) === '欢迎使用', 'B sees the info notice');
    check((await bPage.locator('.gn-card').getAttribute('data-level')) === 'info', 'info level');
    check((await bPage.locator('.gn-card a').getAttribute('href')) === 'https://docs.example.com/notices', 'URL in the body is a link (trailing punctuation stays text)');
    await shot(bPage, 'desktop-info-light');

    step('2. phone, account A: the newer warning addressed by username');
    await boot(phone);
    check((await cardTitle(phone)) === '今晚 23:00 维护', 'A sees the targeted warning first');
    check((await phone.locator('.gn-card').getAttribute('data-level')) === 'warning', 'warning level');
    check(await phone.evaluate(() => matchMedia('(pointer: coarse)').matches), 'phone context is coarse');
    const box = await phone.locator('.gn-dismiss').boundingBox();
    check(!!box && box.height >= 44, '知道了 is a 44px target on the phone', box ? `${Math.round(box.width)}×${Math.round(box.height)}` : 'missing');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, 'no horizontal overflow at 390px', String(overflow));
    await shot(phone, 'phone-warning-light');

    step('3. 知道了 dismisses and shows the next one');
    await tap(phone, phone.locator('.gn-dismiss'));
    await phone.waitForFunction(() => document.querySelector('.gn-card h2')?.textContent === '欢迎使用', null, { timeout: 10_000 }).catch(() => {});
    check((await cardTitle(phone)) === '欢迎使用', 'next notice shows after dismissing');
    check(JSON.stringify(await dismissed(phone)) === JSON.stringify([`maint-${suffix}`]), 'dismissed id in synced settings', JSON.stringify(await dismissed(phone)));
    await sleep(2500); // debounced settings write

    step('4. A on desktop: the dismissed notice stays gone');
    const aDesk = await (await newContext('desktop', credsA, 'dark')).newPage();
    await boot(aDesk);
    check((await cardTitle(aDesk)) === '欢迎使用', 'A desktop skips the dismissed warning');
    await shot(aDesk, 'desktop-info-dark');

    step('5. a notice that cannot be dismissed (hot-reloaded config)');
    writeFileSync(CONFIG_FILE, JSON.stringify({
        notices: [{ id: 'sticky', title: '服务迁移中', body: '部分会话列表可能延迟几分钟。', level: 'warning', dismissible: false }],
    }));
    await sleep(11_000); // the server re-checks the file at most every 10 s
    const darkPhone = await (await newContext('phone', credsA, 'dark')).newPage();
    await boot(darkPhone);
    check((await cardTitle(darkPhone)) === '服务迁移中', 'sticky notice shows');
    check((await darkPhone.locator('.gn-dismiss').count()) === 0, 'no 知道了 on a non-dismissible notice');
    await shot(darkPhone, 'phone-sticky-dark');
    await tap(darkPhone, darkPhone.locator('.gn-close'));
    await sleep(300);
    check((await darkPhone.locator('.gn-card').count()) === 0, 'close hides it for this load');
    await boot(darkPhone);
    check((await cardTitle(darkPhone)) === '服务迁移中', 'back after a reload');
} catch (error) {
    console.error(error);
    failures += 1;
} finally {
    await browser.close();
    stopServer();
}
console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
