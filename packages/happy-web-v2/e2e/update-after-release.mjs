#!/usr/bin/env node
/**
 * B-914: an open, visible tab learns about a new release within 30s of the
 * server behind it changing — production shape: two real `vite build`s served
 * by the standalone server one after the other on the same origin, service
 * worker ON (its precache is what keeps a tab on the old shell). Not part of
 * CI — run by hand:
 *
 *   VH_VERSION=2.0.0-a pnpm -C packages/happy-web-v2 exec vite build --outDir <tmp>/distA
 *   VH_VERSION=2.0.0-b pnpm -C packages/happy-web-v2 exec vite build --outDir <tmp>/distB
 *   node packages/happy-web-v2/e2e/update-after-release.mjs --dist-a <tmp>/distA --dist-b <tmp>/distB \
 *     --data-dir <tmp>/data [--port 39141] [--out <dir>] [--limit-ms 30000] [--hold-ms 20000]
 *
 * Steps: server A (dist A) up → sign up in a visible tab → stop A, start B
 * (dist B) on the same port, as a release does → the tab's socket reconnects
 * → the update prompt must show ≤ limit after B is healthy, with no reload of
 * the page (B-319), and still be there `hold` later (it persists until acted
 * on). Clicking 刷新 must land on B's entry.
 *
 * The standalone server injects serverUrl "same-origin", and every request to
 * *.veryhappy.dev is aborted, so this can never talk to production.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const DIST_A = resolve(opt('dist-a', ''));
const DIST_B = resolve(opt('dist-b', ''));
const DATA_DIR = resolve(opt('data-dir', ''));
const PORT = Number(opt('port', '39141'));
const OUT = resolve(opt('out', join(DATA_DIR, 'out')));
const LIMIT_MS = Number(opt('limit-ms', '30000'));
const HOLD_MS = Number(opt('hold-ms', '20000'));
const DEBUG = args.includes('--debug');
const BASE = `http://127.0.0.1:${PORT}`;
const serverDir = resolve(new URL('.', import.meta.url).pathname, '../../happy-server');

for (const d of [DIST_A, DIST_B]) if (!existsSync(join(d, 'index.html'))) throw new Error(`no build at ${d}`);
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(OUT, { recursive: true });
const entryOf = (dist) => readFileSync(join(dist, 'index.html'), 'utf8').match(/<script[^>]*src="[^"]*\/assets\/(index-[A-Za-z0-9_-]+\.js)"/)[1];
const ENTRY_A = entryOf(DIST_A);
const ENTRY_B = entryOf(DIST_B);
if (ENTRY_A === ENTRY_B) throw new Error('both builds have the same entry — build B with another VH_VERSION');

const started = Date.now();
const step = (name) => console.log(`[+${((Date.now() - started) / 1000).toFixed(1)}s] ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tsx = resolve(serverDir, '../../node_modules/.bin/tsx');
const serverEnv = (dist) => ({
    ...process.env, DATA_DIR, PORT: String(PORT), METRICS_ENABLED: 'false', SIGNUP_MODE: 'open', HAPPY_STATIC_DIR: dist,
});

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

async function waitHealth() {
    for (let i = 0; i < 600; i++) {
        try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* starting */ }
        await sleep(100);
    }
    throw new Error(`server :${PORT} did not come up`);
}
let server = null;
async function startServer(dist) {
    server = spawn(tsx, ['--env-file=.env.dev', './sources/standalone.ts', 'serve'], { cwd: serverDir, env: serverEnv(dist), stdio: DEBUG ? 'inherit' : 'ignore' });
    await waitHealth();
}
async function stopServer() {
    if (!server) return;
    const proc = server;
    server = null;
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    await Promise.race([exited, sleep(8_000)]);
    if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGKILL'); await exited; }
}

const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

let browser;
try {
    step('migrate');
    const migrated = spawnSync(tsx, ['--env-file=.env.dev', './sources/standalone.ts', 'migrate'], { cwd: serverDir, env: serverEnv(DIST_A), stdio: DEBUG ? 'inherit' : 'ignore' });
    if (migrated.status !== 0) throw new Error('migrate failed');
    step(`server A up (${ENTRY_A})`);
    await startServer(DIST_A);

    browser = await chromium.launch({ executablePath: findChromium() });
    // Service workers ON: the production shell is served from the SW precache.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' });
    await ctx.route(/^https?:\/\/([^/]*\.)?veryhappy\.dev\//, (route) => route.abort());
    await ctx.addInitScript(() => { try { localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch { /* ignore */ } });
    const page = await ctx.newPage();
    let navigations = 0;
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations++; });

    step('sign up');
    await page.goto(`${BASE}/signup`);
    const toggle = page.locator('.auth-method-toggle');
    const usernameInput = page.locator('input[autocomplete="username"]');
    await usernameInput.or(toggle).first().waitFor({ timeout: 60_000 });
    if (!(await usernameInput.isVisible())) await usernameInput.waitFor({ timeout: 1_500 }).catch(() => toggle.click());
    await usernameInput.fill(`b914${randomBytes(4).toString('hex')}`);
    const pw = `pw-${randomBytes(6).toString('hex')}`;
    const pws = page.locator('input[autocomplete="new-password"]');
    await pws.nth(0).fill(pw);
    await pws.nth(1).fill(pw);
    await page.locator('form.auth-password-form button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.startsWith('/signup'), { timeout: 60_000 });
    // Let the SW take control and the boot-time check (3s) run against A.
    await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, { timeout: 30_000 });
    await sleep(6_000);
    const ownA = await page.evaluate(() => document.querySelector('script[src*="/assets/index-"]')?.src.match(/index-[A-Za-z0-9_-]+\.js/)?.[0]);
    check(ownA === ENTRY_A, `tab runs A's shell (${ownA})`);
    check(await page.locator('.vh-update-prompt').count() === 0, 'no update prompt while A is current');
    const navBefore = navigations;

    step('release: stop A, start B on the same origin');
    await stopServer();
    await startServer(DIST_B);
    const bReadyAt = Date.now();
    step(`server B up (${ENTRY_B}); waiting for the prompt (limit ${LIMIT_MS}ms)`);
    let shownAfter = null;
    try {
        await page.locator('.vh-update-prompt').waitFor({ state: 'visible', timeout: LIMIT_MS });
        shownAfter = Date.now() - bReadyAt;
    } catch { /* not within the limit */ }
    check(shownAfter !== null, `update prompt visible ≤ ${LIMIT_MS}ms after B is up (took ${shownAfter ?? '>' + LIMIT_MS}ms)`);
    if (shownAfter !== null) {
        const text = await page.locator('.vh-update-prompt-text').textContent();
        check(text === '有新版本，刷新后查看更新说明', `prompt text: ${text}`);
        await page.screenshot({ path: join(OUT, 'update-prompt-desktop.png') });
        check(navigations === navBefore, 'the visible tab was not reloaded under the user (B-319)');
        await sleep(HOLD_MS);
        check(await page.locator('.vh-update-prompt').isVisible(), `prompt still shown ${HOLD_MS}ms later (persists until acted on)`);
        step('click 刷新');
        await Promise.all([
            page.waitForEvent('framenavigated', { timeout: 30_000 }),
            page.locator('.vh-update-prompt-btn').click(),
        ]);
        await page.waitForLoadState('load');
        await sleep(2_000);
        const ownB = await page.evaluate(() => document.querySelector('script[src*="/assets/index-"]')?.src.match(/index-[A-Za-z0-9_-]+\.js/)?.[0]);
        check(ownB === ENTRY_B, `after 刷新 the tab runs B's shell (${ownB})`);
    }
} finally {
    await browser?.close().catch(() => {});
    await stopServer();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall passed');
process.exit(failures.length ? 1 : 0);
