#!/usr/bin/env node
/**
 * B-857 feedback prompt after the release notes, end to end in Chromium
 * against a local standalone server and Vite dev (docs/development.md).
 * Not part of CI — run by hand:
 *
 *   DATA_DIR=<tmp> PORT=3857 pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts migrate
 *   VH_SERVER_URL=http://127.0.0.1:3857 pnpm -C packages/happy-web-v2 exec vite --port 8857 --strictPort
 *   DATA_DIR=<tmp> node packages/happy-web-v2/e2e/feedback-after-notes.mjs --base http://127.0.0.1:8857 --port 3857 [--out <dir>]
 *
 * For each of phone zh-CN, phone en-US and desktop zh-CN, on a fresh account:
 *   1. two active days are enough: yesterday counted once, today makes 2 → the card asks (no unread notes)
 *   2. unread notes: they open first and the card waits behind them (still absent long after the 20 s delay)
 *   3. the notes closed: no card 15 s later, the card ~20 s after the close
 * And once, on desktop zh-CN (B-857b):
 *   4. the notes closed on the last page (Esc, still unread) and reopened 5 s later from the sidebar
 *      stay in front past the first close's 20 s; the card comes ~20 s after the second close
 *   5. the Esc that closes ⌘K over the card closes only the palette; the card stays
 * Exit code 1 on any failed check.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const BASE = opt('base', 'http://127.0.0.1:8857');
const PORT = opt('port', '3857');
const SERVER = `http://127.0.0.1:${PORT}`;
const OUT = opt('out', null);
const DATA_DIR = process.env.DATA_DIR;
if (!DATA_DIR) throw new Error('DATA_DIR is required (the standalone server data directory)');
if (OUT) mkdirSync(OUT, { recursive: true });
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_PKG = resolve(HERE, '../../happy-server');
const PROMPT_WAIT_MS = 45_000; // FEEDBACK_PROMPT_DELAY_MS (20 s) + boot
// Mark all but the newest two releases seen, so this load has notes to show.
const RELEASE_IDS = [...readFileSync(resolve(HERE, '../src/app/changelogRelease.ts'), 'utf8').matchAll(/^ {4}id: '([^']+)'/gm)].map((m) => m[1]);
const SEEN_BEFORE_NEWEST_TWO = RELEASE_IDS[2];

const DEVICES = {
    desktop: { viewport: { width: 1280, height: 860 } },
    phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
};
const RUNS = [
    { device: 'phone', locale: 'zh-CN' },
    { device: 'phone', locale: 'en-US' },
    { device: 'desktop', locale: 'zh-CN' },
];

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

let server = null;
async function startServer() {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR, PORT, SIGNUP_MODE: 'open' };
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
}

const browser = await chromium.launch({ executablePath: findChromium() });

async function newContext(run, seen) {
    const context = await browser.newContext({ ...DEVICES[run.device], locale: run.locale, serviceWorkers: 'block' });
    await context.addInitScript((seenId) => {
        try {
            localStorage.setItem('vh-pwa-install-never-v1', '1');
            localStorage.setItem('vh-notif-optin-dismissed-v1', '1');
            // Per load: `seenId` decides whether this load has release notes to show.
            if (sessionStorage.getItem('e2e-seen-applied') !== location.href) {
                sessionStorage.setItem('e2e-seen-applied', location.href);
                if (seenId) { localStorage.setItem('vh.changelog.seen', seenId); localStorage.removeItem('vh.changelog.read'); }
            }
        } catch { /* ignore */ }
    }, seen);
    return context;
}

async function signUp(page) {
    const username = `fb857${randomBytes(3).toString('hex')}`;
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
    return username;
}

const settingsLoaded = (page) => page.waitForFunction(() => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().settingsVersion !== null), null, { timeout: 30_000, polling: 300 });
const settings = (page) => page.evaluate(() => import('/src/sync/storage.ts').then(({ storage }) => {
    const s = storage.getState().settings;
    return { activeDays: s.feedbackActiveDays, lastDay: s.feedbackLastActiveDay, shownAt: s.feedbackPromptShownAt };
}));
const applySettings = (page, patch) => page.evaluate(async (p) => {
    const { sync } = await import('/src/sync/sync.ts');
    sync.applySettings(p);
    await new Promise((r) => setTimeout(r, 2500));
}, patch);
const clearCorner = async (page) => {
    // A fresh password account gets the sign-in methods card in the prompt's corner; the prompt waits for it (by design).
    await page.locator('.signin-nudge__close').click({ timeout: 3_000 }).catch(() => {});
};
const tap = async (page, locator) => { if ((await page.evaluate(() => matchMedia('(pointer: coarse)').matches))) await locator.tap(); else await locator.click(); };
const why = (page) => page.evaluate(async () => ({
    corner: [...document.querySelectorAll('.pwa-install, .notif-optin, .signin-nudge, .cli-update, .mrb')].map((e) => e.className),
    active: document.activeElement ? `${document.activeElement.tagName}.${document.activeElement.className}` : null,
    notes: (await import('/src/app/changelogReadStore.ts')).changelogVisit?.() ?? (await import('/src/app/changelogReadStore.ts')).changelogClosedAt(),
    holder: (await import('/src/app/overlayQueue.ts')).currentOverlay(),
    path: location.pathname,
}));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// B-857b: the app counts today itself once settings load. Seed only after that write landed, or the
// two writes race (the app's would land on top of the seed and the day count would be off by one).
const appCountedToday = (page) => page.waitForFunction((day) => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().settings.feedbackLastActiveDay === day), today(), { timeout: 15_000, polling: 300 });
const daysAre = (page, n) => page.waitForFunction((want) => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().settings.feedbackActiveDays === want), n, { timeout: 15_000, polling: 300 });
const yesterday = () => { const d = new Date(Date.now() - 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function readyAccount(run, seen) {
    const ctx = await newContext(run, seen);
    const page = await ctx.newPage();
    await signUp(page);
    await settingsLoaded(page);
    await appCountedToday(page);
    await applySettings(page, { feedbackActiveDays: 2, feedbackPromptShownAt: null, feedbackLastSubmittedAt: null, feedbackPromptOptOut: false });
    await daysAre(page, 2).catch(() => check(false, 'seeded 2 active days'));
    await page.goto(`${BASE}/`);
    await settingsLoaded(page);
    return { ctx, page };
}

async function reopenAndPalette(run, tag) {
    step(`${tag} 4. notes reopened inside the 20 s stay in front; the card ~20 s after the second close`);
    const { ctx, page } = await readyAccount(run, SEEN_BEFORE_NEWEST_TWO);
    const notes = page.locator('.wn-card');
    const card = page.locator('.fb-prompt');
    await notes.waitFor({ timeout: 30_000 });
    // page to the last one without the receipt, then Esc: closed, still unread
    for (let i = 0; i < 8 && (await notes.getAttribute('data-locked')) !== null; i++) { await notes.locator('.wn-done').click().catch(() => {}); await sleep(400); }
    await page.keyboard.press('Escape');
    await sleep(300);
    const firstClose = Date.now();
    check((await notes.count()) === 0, 'notes closed with Esc on the last page');
    await clearCorner(page);
    await sleep(5_000 - (Date.now() - firstClose));
    await page.evaluate(async () => (await import('/src/app/changelogReadStore.ts')).requestChangelogOpen());
    await notes.waitFor({ timeout: 5_000 }).then(() => check(true, 'notes reopened from the sidebar entry'), () => check(false, 'notes reopened from the sidebar entry'));
    await sleep(firstClose + 26_000 - Date.now());
    const front = (await notes.count()) > 0 && (await card.count()) === 0;
    await shot(page, `${tag}-4-reopened-at-26s`);
    check(front, 'reopened notes still in front 26 s after the first close, no card', JSON.stringify(await why(page)));
    for (let i = 0; i < 8 && (await notes.count()) > 0; i++) { await notes.locator('.wn-done').click().catch(() => {}); await sleep(400); }
    const secondClose = Date.now();
    check((await notes.count()) === 0, 'notes closed again (read to the end)');
    await sleep(15_000 - (Date.now() - secondClose));
    check((await card.count()) === 0, 'no card 15 s after the second close');
    await card.waitFor({ timeout: 15_000 }).then(() => {
        const after = (Date.now() - secondClose) / 1000;
        check(after >= 19.5 && after < 26, 'card asks ~20 s after the second close', `${after.toFixed(1)} s`);
    }, async () => { console.log('  debug:', JSON.stringify(await why(page))); check(false, 'card asks after the second close'); });

    step(`${tag} 5. the Esc that closes ⌘K over the card leaves the card`);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Control+k');
    await sleep(1_000);
    check((await card.count()) === 0, '⌘K open → the card stands aside');
    await page.keyboard.press('Escape');
    await sleep(1_500);
    const shownAt = (await settings(page)).shownAt;
    check((await card.count()) === 1, '⌘K closed with Esc → the card is back', JSON.stringify(await why(page)));
    await shot(page, `${tag}-5-card-after-palette-esc`);
    await page.keyboard.press('Escape');
    await sleep(500);
    check((await card.count()) === 0, 'a second Esc, the card on top, closes the card', `shownAt=${shownAt}`);
    await ctx.close();
}

try {
    step(`server; releases seen up to ${SEEN_BEFORE_NEWEST_TWO} for the notes runs`);
    await startServer();
    for (const run of RUNS.filter((r) => !opt('only', null) || `${r.device}-${r.locale}` === opt('only', null))) {
        const tag = `${run.device}-${run.locale}`;
        // --- 1. two active days, no notes ---------------------------------------------
        step(`${tag} 1. active days 1 (yesterday) → today makes 2 → the card asks`);
        const ctx = await newContext(run, RELEASE_IDS[0]);
        const page = await ctx.newPage();
        const user = await signUp(page);
        await settingsLoaded(page);
        await appCountedToday(page);
        await applySettings(page, { feedbackActiveDays: 1, feedbackLastActiveDay: yesterday(), feedbackPromptShownAt: null, feedbackLastSubmittedAt: null, feedbackPromptOptOut: false });
        // The live app counts today on top of yesterday: day 2. Let that write land before the reload.
        await daysAre(page, 2).then(() => check(true, 'today counted as active day 2'), () => check(false, 'today counted as active day 2'));
        await sleep(3_000);
        await page.goto(`${BASE}/`);
        await settingsLoaded(page);
        await clearCorner(page);
        const card = page.locator('.fb-prompt');
        await card.waitFor({ timeout: PROMPT_WAIT_MS }).then(() => check(true, 'card asks on the 2nd active day', user), async () => { console.log('  debug:', JSON.stringify(await why(page))); check(false, 'card asks on the 2nd active day'); });
        const s = await settings(page);
        check(s.activeDays === 2 && typeof s.shownAt === 'number', 'counted 2 days and recorded the showing', JSON.stringify(s));
        if (run.device === 'phone') check(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'phone is pointer: coarse');
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
        await shot(page, `${tag}-1-card-2-days`);
        await tap(page, card.locator('.fb-prompt-later').first());
        await ctx.close();

        // --- 2/3. unread notes first, then the card -----------------------------------
        step(`${tag} 2. unread release notes open first; the card waits behind them`);
        const ctx2 = await newContext(run, SEEN_BEFORE_NEWEST_TWO);
        const p2 = await ctx2.newPage();
        await signUp(p2);
        await settingsLoaded(p2);
        await appCountedToday(p2);
        await applySettings(p2, { feedbackActiveDays: 2, feedbackPromptShownAt: null, feedbackLastSubmittedAt: null, feedbackPromptOptOut: false });
        await daysAre(p2, 2).catch(() => check(false, 'seeded 2 active days'));
        await p2.goto(`${BASE}/`);
        await settingsLoaded(p2);
        const notes = p2.locator('.wn-card');
        await notes.waitFor({ timeout: 30_000 }).then(() => check(true, 'release notes open on their own'), () => check(false, 'release notes open on their own'));
        await sleep(PROMPT_WAIT_MS - 10_000);
        check((await p2.locator('.fb-prompt').count()) === 0, 'no card while the notes are up (past the 20 s delay)');
        await shot(p2, `${tag}-2-notes-first`);
        for (let i = 0; i < 8 && (await notes.count()) > 0; i++) {
            await tap(p2, notes.locator('.wn-done')).catch(() => {});
            await sleep(400);
        }
        const closedAt = Date.now();
        check((await notes.count()) === 0, 'notes closed (read to the end)');
        await clearCorner(p2);
        await sleep(15_000 - (Date.now() - closedAt));
        check((await p2.locator('.fb-prompt').count()) === 0, 'no card 15 s after the notes closed');
        step(`${tag} 3. the card ~20 s after the notes closed`);
        await p2.locator('.fb-prompt').waitFor({ timeout: 15_000 }).then(() => {
            const after = (Date.now() - closedAt) / 1000;
            check(after >= 19.5 && after < 26, 'card asks ~20 s after the close', `${after.toFixed(1)} s`);
        }, async () => { console.log('  debug:', JSON.stringify(await why(p2))); check(false, 'card asks after the notes closed'); });
        check(await p2.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
        await shot(p2, `${tag}-3-card-after-notes`);
        await ctx2.close();
        if (tag === 'desktop-zh-CN') await reopenAndPalette(run, tag);
    }
} catch (error) {
    console.error(error);
    failures += 1;
} finally {
    await browser.close();
    await stopServer();
}
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
