#!/usr/bin/env node
/**
 * B-842 — every unread release note has a way in (Owner 10-28: 「我刷新页面也没有收到
 * 通知啊」). Production-shaped: a `vite build` served by the standalone server
 * (HAPPY_STATIC_DIR), headless Chromium; not part of CI — run by hand:
 *
 *   VH_VERSION=<sha> pnpm -C packages/happy-web-v2 exec vite build --outDir <tmp>/web
 *   DATA_DIR=<tmp>/data PORT=48822 pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts migrate
 *   DATA_DIR=<tmp>/data PORT=48822 SIGNUP_MODE=open HAPPY_STATIC_DIR=<tmp>/web \
 *     pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts serve
 *   node packages/happy-web-v2/e2e/changelog-entry.mjs --app http://127.0.0.1:48822 [--out <dir>] [--before]
 *
 * Each case starts a fresh context whose receipt (`vh.changelog.seen`) is the
 * release just below the head, so exactly the newest (minor) release is
 * unread — the Owner's state on 10-28. Per device (desktop, phone):
 *   ORDINARY  `/` reload, hands off → the pager opens by itself (B-315).
 *   PANEL     reload with `?panel=files` (a session page with its aside open: UI
 *             state, not an action) → the pager opens by itself, like ORDINARY.
 *   QUERY     reload with an action param (`?vh_presence=1`: a push tap) → B-697 deep
 *             link, no pager; a toast 「1 new release note · View」 and the quiet
 *             sidebar entry 「Release notes」 both open it.
 *   INPUT     reload and type at once (trusted keydowns until the deferred notice
 *             mounted, B-823) → no pager; same toast + entry.
 * `--before` (a build without B-842): records what each case shows instead of
 * asserting the way in — the repro of 「看不到」. Exit code 1 on a failed check.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const APP = opt('app', 'http://127.0.0.1:48822');
const OUT = opt('out', null);
const BEFORE = args.includes('--before');
const DEVICES = opt('devices', 'desktop,phone').split(',');
if (OUT) mkdirSync(OUT, { recursive: true });

// Newest release (minor) and the one below it: the receipt leaves only the head unread.
const HEAD_TITLE = 'CLI 0.2.187: teams and long sessions cost much less';
const BELOW_HEAD = '2026-10-27-dispatch-feedback';

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

const PROFILES = {
    desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

let failures = 0;
const check = (ok, label, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
};

const browser = await chromium.launch({ executablePath: findChromium() });
try {
    console.log(`▶ sign up on ${APP}`);
    const setup = await browser.newContext({ ...PROFILES.desktop, locale: 'en-US', serviceWorkers: 'block' });
    await setup.addInitScript(() => { try { localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch { /* ignore */ } });
    const page = await setup.newPage();
    await page.goto(`${APP}/signup`);
    const toggle = page.locator('.auth-method-toggle');
    await page.locator('input[autocomplete="username"]').or(toggle).first().waitFor({ timeout: 60_000 });
    if (!(await page.locator('input[autocomplete="username"]').isVisible())) await toggle.click();
    const pw = `pw-${randomBytes(6).toString('hex')}`;
    await page.locator('input[autocomplete="username"]').fill(`notes${randomBytes(3).toString('hex')}`);
    await page.locator('input[autocomplete="new-password"]').nth(0).fill(pw);
    await page.locator('input[autocomplete="new-password"]').nth(1).fill(pw);
    await page.locator('form.auth-password-form button[type="submit"]').click();
    await page.locator('.sb .sb-header').waitFor({ timeout: 60_000 });
    const credentials = await page.evaluate(() => localStorage.getItem('auth_credentials'));
    // A machine on the account: without one the phone root is the first-run screen, not the list.
    const token = JSON.parse(credentials).token;
    const res = await fetch(`${APP}/v1/machines`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), metadata: 'e2e' }) });
    if (!res.ok) throw new Error(`machine: ${res.status} ${await res.text()}`);
    // …and a session, or the phone root is the workspace guide.
    const ses = await fetch(`${APP}/v1/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tag: randomUUID(), metadata: 'e2e' }) });
    if (!ses.ok) throw new Error(`session: ${ses.status} ${await ses.text()}`);
    const sessionId = (await ses.json()).session.id;
    await setup.close();

    for (const device of DEVICES) {
        for (const theme of ['light', 'dark']) {
            // Themes only change the shots; run the checks once per device (light), shoot both.
            const checks = theme === 'light';
            for (const kase of ['ordinary', 'panel', 'query', 'input']) {
                if (!checks && (kase === 'ordinary' || kase === 'panel')) continue;
                console.log(`▶ ${device} · ${theme} · ${kase}${BEFORE ? ' (before)' : ''}`);
                const ctx = await browser.newContext({ ...PROFILES[device], locale: 'en-US', colorScheme: theme, serviceWorkers: 'block' });
                await ctx.addInitScript(([creds, seen]) => {
                    try {
                        if (sessionStorage.getItem('ce-seeded')) return;
                        sessionStorage.setItem('ce-seeded', '1');
                        localStorage.setItem('auth_credentials', creds);
                        localStorage.setItem('vh-pwa-install-never-v1', '1');
                        localStorage.setItem('vh-notif-optin-dismissed-v1', '1'); // its card sits over the phone list's foot
                        localStorage.setItem('vh.changelog.seen', seen);
                        localStorage.removeItem('vh.changelog.read');
                    } catch { /* ignore */ }
                }, [credentials, BELOW_HEAD]);
                const p = await ctx.newPage();
                const url = kase === 'query' ? `${APP}/?vh_presence=1` : kase === 'panel' ? `${APP}/session/${sessionId}?panel=files` : `${APP}/`;
                await p.goto(url);
                if (kase === 'input') {
                    // Trusted keydowns from the first paint until well after the deferred notice could mount.
                    const until = Date.now() + 4_000;
                    while (Date.now() < until) { await p.keyboard.press('Shift').catch(() => {}); await p.waitForTimeout(40); }
                }
                await p.locator('.app-shell').first().waitFor({ timeout: 60_000 });
                const card = p.locator('.wn-card');
                const toast = p.locator('.vh-toast', { hasText: /release note/i });
                const entry = p.locator('.vh-major-entry');
                await card.or(toast).first().waitFor({ timeout: 8_000 }).catch(() => {});
                await p.waitForTimeout(500);
                const cardShown = await card.isVisible();
                const toastShown = await toast.isVisible();
                const entryShown = await entry.isVisible();
                const entryKind = entryShown ? await entry.getAttribute('data-kind') : null;
                if (OUT) await p.screenshot({ path: join(OUT, `${BEFORE ? 'before' : 'after'}-${device}-${theme}-${kase}.png`) });
                console.log(`    seen: pager=${cardShown} toast=${toastShown} entry=${entryShown}${entryKind ? `(${entryKind})` : ''}`);
                if (checks && (kase === 'ordinary' || (kase === 'panel' && !BEFORE))) {
                    check(cardShown, `${kase}: reload opens the pager`);
                    check(!toastShown, `${kase}: no hint toast`);
                } else if (checks && !BEFORE) {
                    check(!cardShown, `${kase}: the pager stays closed (B-697 / B-823)`);
                    check(toastShown, `${kase}: a hint toast for this visit`);
                    check(entryShown && entryKind === 'minor', `${kase}: the quiet 「Release notes」 sidebar entry`, `kind=${entryKind}`);
                    if (toastShown) {
                        const box = await toast.boundingBox();
                        const vw = PROFILES[device].viewport.width;
                        check(!!box && box.x >= 0 && box.x + box.width <= vw, `${kase}: toast inside the viewport`, JSON.stringify(box));
                    }
                    // Open it: QUERY through the toast, INPUT through the sidebar entry.
                    if (kase === 'query' && toastShown) await toast.getByRole('button', { name: 'View' }).click();
                    else if (entryShown) await entry.click();
                    await card.waitFor({ timeout: 5_000 }).catch(() => {});
                    check(await card.isVisible() && (await card.textContent()).includes(HEAD_TITLE), `${kase}: opened the newest note`);
                    if (OUT && theme === 'light') await p.screenshot({ path: join(OUT, `after-${device}-${kase}-opened.png`) });
                    await p.getByRole('button', { name: 'Got it', exact: true }).click().catch(() => {});
                    await p.waitForTimeout(300);
                    check(!(await entry.isVisible()), `${kase}: entry gone once read`);
                }
                await ctx.close();
            }
        }
    }
} finally {
    await browser.close();
}
console.log(failures ? `✗ ${failures} check(s) failed` : '✓ all checks passed');
process.exit(failures ? 1 : 0);
