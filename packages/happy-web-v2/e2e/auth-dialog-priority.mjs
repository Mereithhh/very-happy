#!/usr/bin/env node
/**
 * B-830: the sign-in-expired dialog (AuthExpiredNotice) outranks every other
 * overlay. Chao FENG 10-26: with unread release notes open, 「登录已失效」 drew
 * on top but could not be clicked — the Radix notes underneath held
 * `body { pointer-events: none }`, the focus trap and aria-hidden, so only the
 * notes' 「下一条」 reacted. End to end in Chromium, desktop and phone
 * (390×844, touch, `pointer: coarse`), against a local standalone server and
 * Vite dev (docs/development.md). Not part of CI — run by hand:
 *
 *   DATA_DIR=<tmp> PORT=3299 pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts migrate
 *   DATA_DIR=<tmp> PORT=3299 SIGNUP_MODE=open pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts serve
 *   VH_SERVER_URL=http://127.0.0.1:3299 pnpm -C packages/happy-web-v2 exec vite --port 8825 --strictPort
 *   node packages/happy-web-v2/e2e/auth-dialog-priority.mjs --base http://127.0.0.1:8825 --server http://127.0.0.1:3299 [--out <dir>] [--only desktop|phone]
 *
 *   N. release notes open (several unread pages), then the token is revoked
 *      with an unsent input → the notes give way, 「放弃并重新登录」 is the
 *      element under the pointer and one click/tap reaches the login page.
 *   M. a 401 the server does not confirm (misfire) is up first, then the
 *      notes are asked to open → they stay away; 「重新加载页面」 takes the
 *      first click.
 *   R. a Radix menu the person opened (not in the overlay queue, holds
 *      `body { pointer-events: none }`) is up when a misfired 401 lands → the
 *      dialog (native top layer) still takes the first click.
 *   A. (B-831) release notes open on a locked page, then a Modal.alert is
 *      raised (FirstMachineWelcome, sync errors…) → the notes step aside, the
 *      alert's button takes the first click / tap, and the notes come back
 *      on the same page, unread.
 *   B. (B-831) a Modal.confirm is up first, then the notes are asked to
 *      open → they wait; the confirm takes the first click, the notes follow.
 *   C. (B-831) release notes open (locked), then the ⌘K palette is opened
 *      (programmatic open on phone) → the notes step aside, the palette's
 *      search field takes typing; closing it brings the notes back unread.
 * Every case also checks the dialog is not aria-hidden, and that focus is not
 * held elsewhere: on desktop Tab reaches the expiry dialog's button (N/M/R);
 * Modal.* takes no focus itself, so A/B check the notes' trap is not holding it.
 * `--cases NMRABC` picks cases (default: all). Exit code 1 on any failed check.
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
const ONLY = opt('only', null);
const CASES = opt('cases', 'NMRABC');
if (OUT) mkdirSync(OUT, { recursive: true });

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

async function waitFor(fn, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try { const v = await fn(); if (v) return v; } catch { /* navigating */ }
        await sleep(200);
    }
    throw new Error(`timeout: ${label}`);
}

const browser = await chromium.launch({ executablePath: findChromium() });

async function newContext(device) {
    const context = await browser.newContext({ ...DEVICES[device], locale: 'zh-CN', serviceWorkers: 'block' });
    // Only the overlays under test: no install / notification invitations.
    await context.addInitScript(() => { try { localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch { /* ignore */ } });
    return context;
}

async function signUp(page) {
    const username = `b830${randomBytes(4).toString('hex')}`;
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
    await page.goto(`${BASE}/`);
    await page.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 30_000, polling: 300 });
}

async function createSession(page) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await page.evaluate(async () => {
                const { sync } = await import('/src/sync/sync.ts');
                const { apiSocket } = await import('/src/sync/apiSocket.ts');
                const { encodeBase64 } = await import('/src/encryption/base64.ts');
                for (let i = 0; i < 100 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
                const enc = await sync.encryption.openEncryption(null);
                const [metadata] = await enc.encrypt([{ path: '/tmp/b830-e2e', host: 'e2e', flavor: 'claude' }]);
                const res = await apiSocket.request('/v1/sessions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState: null, dataEncryptionKey: null }),
                });
                return (await res.json()).session.id;
            });
        } catch (error) {
            if (attempt >= 3) throw error;
            await page.goto(`${BASE}/`);
            await page.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 30_000, polling: 300 });
        }
    }
}

/** Whatever overlays the boot raised on their own: finish them so the composer is free. */
async function clearBootOverlays(page) {
    await page.locator('.wn-card').waitFor({ timeout: 4_000 }).catch(() => {});
    await page.evaluate(() => import('/src/app/changelogReadStore.ts').then(({ acknowledgeAllChangelog }) => acknowledgeAllChangelog()));
    for (let i = 0; i < 8 && (await page.locator('.wn-card').count()) > 0; i++) {
        const done = page.locator('.wn-card .wn-done');
        await done.click({ timeout: 1_000 }).catch(() => {});
        await sleep(200);
    }
    for (const name of ['知道了', '暂不', 'Got it', 'Not now']) {
        for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 1_000 }).catch(() => {});
    }
}

/** Several unread releases (a multi-page, locked pager like the report's 5/6), then ask the notes to open. */
const openReleaseNotes = (page) => page.evaluate(async () => {
    const { CHANGELOG_RELEASES } = await import('/src/app/changelogRelease.ts');
    const store = await import('/src/app/changelogReadStore.ts');
    // Rewind to just before the second-newest major release: two major pages + the minor page.
    const majors = CHANGELOG_RELEASES.flatMap((release, i) => (release.major ? [i] : []));
    const seen = CHANGELOG_RELEASES[majors[1] + 1].id;
    // The read state is cached per tab; rewind this tab's copy and storage.
    Object.assign(store.changelogReadState(), { seen, read: [] });
    localStorage.setItem('vh.changelog.seen', seen);
    localStorage.removeItem('vh.changelog.read');
    store.requestChangelogOpen();
});

async function revokeOnServer(page) {
    const token = await page.evaluate(() => JSON.parse(localStorage.getItem('auth_credentials')).token);
    const res = await fetch(`${SERVER}/v1/account/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
    return res.status;
}

const touchServer = (page) => page.evaluate(() => import('/src/sync/apiSocket.ts')
    .then(({ apiSocket }) => apiSocket.request('/v1/sessions').then((r) => r.status, (e) => `error:${e?.message ?? e}`)));

/** What a person pointing at the button's centre would actually hit, and why. */
const hitTest = (page, selector) => page.evaluate((sel) => {
    const target = document.querySelector(sel);
    if (!target) return { found: false };
    const r = target.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
        found: true,
        hitsTarget: !!hit && target.contains(hit),
        hit: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className).split(' ').filter(Boolean).slice(0, 2).join('.')}` : null,
        bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
        targetPointerEvents: getComputedStyle(target).pointerEvents,
        notesVisible: !!document.querySelector('.wn-card'),
        ariaHiddenAncestor: !!target.closest('[aria-hidden="true"]'),
    };
}, selector);

/** Tab (up to 8 presses) until the button has focus: keyboard users must reach it, not a focus trap underneath. */
async function tabReaches(page, selector) {
    for (let i = 0; i < 8; i++) {
        if (await page.evaluate((sel) => document.activeElement === document.querySelector(sel), selector)) return 'focused';
        await page.keyboard.press('Tab');
    }
    return page.evaluate(() => { const a = document.activeElement; return `focus stuck on ${a?.tagName.toLowerCase()}.${String(a?.className ?? '').split(' ')[0]}`; });
}

/**
 * Modal.* does not take focus (Esc / Enter are handled at window level), so
 * the B-831 cases check that the notes' focus trap is not holding it instead.
 */
const focusTrappedInNotes = (page) => page.evaluate(() => !!document.activeElement?.closest('.wn-card'));

const shot = async (page, name) => { if (OUT) await page.screenshot({ path: join(OUT, `${name}.png`) }); };
const press = (page, device, selector) => (device === 'phone' ? page.locator(selector).tap({ timeout: 3_000 }) : page.locator(selector).click({ timeout: 3_000 }));

try {
    for (const device of Object.keys(DEVICES).filter((d) => !ONLY || d === ONLY)) {
        if (CASES.includes('N')) {
        step(`N/${device}. release notes open, then the token is revoked (unsent input waiting)`);
            const context = await newContext(device);
            const page = await context.newPage();
            await signUp(page);
            const sessionId = await createSession(page);
            await page.goto(`${BASE}/session/${sessionId}`);
            await page.locator('textarea.ci-textarea').waitFor({ timeout: 30_000 });
            await clearBootOverlays(page);
            await page.route('**/v3/sessions/*/messages', (route) => (route.request().method() === 'POST' ? route.abort('connectionrefused') : route.continue()));
            await page.locator('textarea.ci-textarea').fill(`unsent-${randomBytes(3).toString('hex')}`);
            await press(page, device, '.ci-send');
            await sleep(1_500);
            await openReleaseNotes(page);
            await page.locator('.wn-card[data-locked]').waitFor({ timeout: 10_000 });
            check(true, 'the release notes are open on a locked page', await page.locator('.wn-progress').textContent().catch(() => ''));
            await shot(page, `N-${device}-notes`);
            check((await revokeOnServer(page)) === 200, 'token revoked on the server');
            check((await touchServer(page)) === 401, 'the next request is a 401');
            await waitFor(() => page.locator('.vh-auth-expired[data-phase="expired"] [data-testid="auth-expired-unsent"]').count(), 15_000, 'expired dialog with the unsent list');
            await sleep(500);
            await shot(page, `N-${device}-expired`);
            const button = '.vh-auth-expired[data-phase="expired"] .vh-auth-expired-actions button';
            const hit = await hitTest(page, button);
            check(!hit.notesVisible, 'the release notes gave way (not rendered)', JSON.stringify(hit));
            check(hit.hitsTarget, '「放弃并重新登录」 is what the pointer hits', JSON.stringify(hit));
            check(!hit.ariaHiddenAncestor, 'the dialog is not aria-hidden');
            if (device === 'desktop') { const f = await tabReaches(page, button); check(f === 'focused', 'Tab reaches 「放弃并重新登录」', f); }
            const pressed = await press(page, device, button).then(() => 'ok', (e) => e.message.split('\n')[0]);
            check(pressed === 'ok', `one ${device === 'phone' ? 'tap' : 'click'} on 「放弃并重新登录」`, pressed);
            const login = await waitFor(() => page.evaluate(() => (!localStorage.getItem('auth_credentials') && !!document.querySelector('input[autocomplete="username"], .auth-method-toggle')) || null), 15_000, 'login page').catch((e) => e.message);
            check(login === true, 'the login page shows', String(login));
            check((await page.locator('.wn-card').count()) === 0, 'no release notes on the login page');
            await shot(page, `N-${device}-login`);
            await context.close();
        }

        if (CASES.includes('M')) {
        step(`M/${device}. a misfired 401 first, then the notes are asked to open`);
            const context = await newContext(device);
            const page = await context.newPage();
            await signUp(page);
            await page.goto(`${BASE}/`);
            await page.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 30_000, polling: 300 });
            await clearBootOverlays(page);
            await page.route('**/v1/sessions', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Invalid token"}' }));
            check((await touchServer(page)) === 401, 'a forged 401 trips the latch');
            await waitFor(() => page.locator('.vh-auth-expired[data-phase="valid"]').count(), 10_000, 'misfire dialog');
            await openReleaseNotes(page);
            await sleep(1_500);
            await shot(page, `M-${device}-misfire`);
            const button = '.vh-auth-expired[data-phase="valid"] .vh-auth-expired-actions button';
            const hit = await hitTest(page, button);
            check(!hit.notesVisible, 'the release notes stay away while the dialog is up', JSON.stringify(hit));
            check(hit.hitsTarget, '「重新加载页面」 is what the pointer hits', JSON.stringify(hit));
            check(!hit.ariaHiddenAncestor, 'the dialog is not aria-hidden');
            if (device === 'desktop') { const f = await tabReaches(page, button); check(f === 'focused', 'Tab reaches 「重新加载页面」', f); }
            const reloaded = page.waitForEvent('load', { timeout: 10_000 }).then(() => true, () => false);
            const pressed = await press(page, device, button).then(() => 'ok', (e) => e.message.split('\n')[0]);
            check(pressed === 'ok' && (await reloaded), `one ${device === 'phone' ? 'tap' : 'click'} reloads the page`, pressed);
            await context.close();
        }

        if (CASES.includes('R')) {
        step(`R/${device}. a menu the person opened (Radix, outside the queue) is up when the 401 lands`);
            const context = await newContext(device);
            const page = await context.newPage();
            await signUp(page);
            const sessionId = await createSession(page);
            await page.goto(`${BASE}/session/${sessionId}`);
            await page.locator('textarea.ci-textarea').waitFor({ timeout: 30_000 });
            await clearBootOverlays(page);
            const trigger = page.locator('[aria-haspopup="menu"]:visible').first();
            await press(page, device, '[aria-haspopup="menu"]:visible >> nth=0').catch(() => trigger.click());
            await page.locator('[role="menu"]').first().waitFor({ timeout: 5_000 });
            const locked = await page.evaluate(() => getComputedStyle(document.body).pointerEvents);
            check(locked === 'none', 'the open menu holds body pointer events', locked);
            await page.route('**/v1/sessions', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Invalid token"}' }));
            check((await touchServer(page)) === 401, 'a forged 401 trips the latch');
            await waitFor(() => page.locator('.vh-auth-expired[data-phase="valid"]').count(), 10_000, 'misfire dialog');
            await sleep(500);
            await shot(page, `R-${device}-menu`);
            const button = '.vh-auth-expired[data-phase="valid"] .vh-auth-expired-actions button';
            const hit = await hitTest(page, button);
            check(hit.hitsTarget, '「重新加载页面」 is what the pointer hits over the open menu', JSON.stringify(hit));
            check(!hit.ariaHiddenAncestor, 'the dialog is not aria-hidden by the menu');
            if (device === 'desktop') { const f = await tabReaches(page, button); check(f === 'focused', 'Tab reaches 「重新加载页面」 past the menu', f); }
            const reloaded = page.waitForEvent('load', { timeout: 10_000 }).then(() => true, () => false);
            const pressed = await press(page, device, button).then(() => 'ok', (e) => e.message.split('\n')[0]);
            check(pressed === 'ok' && (await reloaded), `one ${device === 'phone' ? 'tap' : 'click'} reloads the page`, pressed);
            await context.close();
        }

        if (CASES.includes('A') || CASES.includes('B') || CASES.includes('C')) {
            const context = await newContext(device);
            const page = await context.newPage();
            await signUp(page);
            await page.goto(`${BASE}/`);
            await page.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 30_000, polling: 300 });
            await clearBootOverlays(page);
            const tapOrClick = device === 'phone' ? 'tap' : 'click';
            const unread = () => page.evaluate(() => [localStorage.getItem('vh.changelog.seen'), localStorage.getItem('vh.changelog.read')]);

            if (CASES.includes('A')) {
                step(`A/${device}. release notes open (locked), then a Modal.alert is raised`);
                await openReleaseNotes(page);
                await page.locator('.wn-card[data-locked]').waitFor({ timeout: 10_000 });
                const progress = await page.locator('.wn-progress').textContent().catch(() => '');
                check(true, 'the release notes are open on a locked page', progress);
                const before = await unread();
                await page.evaluate(() => import('/src/modal/ModalManager.ts').then(({ Modal }) => {
                    window.__b831Pressed = 0;
                    Modal.alert('B-831 alert', 'raised while the release notes are open', [{ text: 'B831-OK', onPress: () => { window.__b831Pressed += 1; } }]);
                }));
                await page.locator('.vh-modal-card').waitFor({ timeout: 5_000 });
                await sleep(500);
                await shot(page, `A-${device}-alert`);
                const button = '.vh-modal-card .vh-modal-btn';
                const hit = await hitTest(page, button);
                check(!hit.notesVisible, 'the release notes gave way (not rendered)', JSON.stringify(hit));
                check(hit.hitsTarget, 'the alert button is what the pointer hits', JSON.stringify(hit));
                check(!hit.ariaHiddenAncestor, 'the alert is not aria-hidden', JSON.stringify(hit));
                check(!(await focusTrappedInNotes(page)), 'focus is not locked inside the release notes');
                const pressed = await press(page, device, button).then(() => 'ok', (e) => e.message.split('\n')[0]);
                const count = await page.evaluate(() => window.__b831Pressed);
                check(pressed === 'ok' && count === 1, `one ${tapOrClick} answers the alert`, `${pressed}, onPress×${count}`);
                const back = await page.locator('.wn-card[data-locked]').waitFor({ timeout: 5_000 }).then(() => true, () => false);
                check(back, 'the release notes come back afterwards');
                const progressAfter = await page.locator('.wn-progress').textContent().catch(() => '');
                check(progressAfter === progress, 'on the same page', `${progress} → ${progressAfter}`);
                const after = await unread();
                check(JSON.stringify(after) === JSON.stringify(before), 'nothing was marked read while they stood aside', `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
                await shot(page, `A-${device}-notes-back`);
                // Whatever is left (an unanswered alert on a failing build) must not leak into B.
                await page.evaluate(() => import('/src/modal/ModalManager.ts').then(({ Modal }) => Modal.hideAll()));
                await clearBootOverlays(page);
            }

            if (CASES.includes('B')) {
                step(`B/${device}. a Modal.confirm is up, then the notes are asked to open`);
                await page.evaluate(() => import('/src/modal/ModalManager.ts').then(({ Modal }) => {
                    window.__b831Answer = 'pending';
                    void Modal.confirm('B-831 confirm', 'raised before the release notes', { confirmText: 'B831-YES' }).then((v) => { window.__b831Answer = v; });
                }));
                await page.locator('.vh-modal-card').waitFor({ timeout: 5_000 });
                await openReleaseNotes(page);
                await sleep(1_500);
                await shot(page, `B-${device}-confirm`);
                const button = '.vh-modal-card .vh-modal-btn.is-primary';
                const hit = await hitTest(page, button);
                check(!hit.notesVisible, 'the release notes wait while the confirm is up', JSON.stringify(hit));
                check(hit.hitsTarget, 'the confirm button is what the pointer hits', JSON.stringify(hit));
                check(!hit.ariaHiddenAncestor, 'the confirm is not aria-hidden', JSON.stringify(hit));
                check(!(await focusTrappedInNotes(page)), 'focus is not locked inside the release notes');
                const pressed = await press(page, device, button).then(() => 'ok', (e) => e.message.split('\n')[0]);
                const answer = await page.evaluate(() => window.__b831Answer);
                check(pressed === 'ok' && answer === true, `one ${tapOrClick} confirms`, `${pressed}, answer=${answer}`);
                const notes = await page.locator('.wn-card').waitFor({ timeout: 5_000 }).then(() => true, () => false);
                check(notes, 'the release notes follow once the confirm is answered');
                await clearBootOverlays(page);
            }

            if (CASES.includes('C')) {
                step(`C/${device}. release notes open (locked), then the command palette is opened`);
                await openReleaseNotes(page);
                await page.locator('.wn-card[data-locked]').waitFor({ timeout: 10_000 });
                const before = await unread();
                if (device === 'desktop') await page.keyboard.press('ControlOrMeta+k');
                else await page.evaluate(() => window.dispatchEvent(new Event('vh:command-palette-open')));
                await page.locator('.cp-search-input').waitFor({ timeout: 5_000 }).catch(() => {});
                await sleep(500);
                await shot(page, `C-${device}-palette`);
                const hit = await hitTest(page, '.cp-search-input');
                check(hit.found && !hit.notesVisible, 'the release notes gave way to the palette', JSON.stringify(hit));
                check(hit.hitsTarget, 'the palette search field is what the pointer hits', JSON.stringify(hit));
                const pressed = await press(page, device, '.cp-search-input').then(() => 'ok', (e) => e.message.split('\n')[0]);
                if (pressed === 'ok') await page.keyboard.type('b831');
                const typed = await page.locator('.cp-search-input').inputValue({ timeout: 1_000 }).catch(() => '');
                check(pressed === 'ok' && typed === 'b831', 'it takes typing', `${pressed}, value=${JSON.stringify(typed)}`);
                await page.keyboard.press('Escape');
                const back = await page.locator('.wn-card[data-locked]').waitFor({ timeout: 5_000 }).then(() => true, () => false);
                check(back, 'closing the palette brings the release notes back');
                const after = await unread();
                check(JSON.stringify(after) === JSON.stringify(before), 'still unread', `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
            }
            await context.close();
        }
    }
} catch (error) {
    console.log('  ✗ aborted:', error instanceof Error ? error.message : error);
    failures += 1;
} finally {
    await browser.close();
}
console.log(failures === 0 ? 'auth-dialog-priority e2e: all checks passed' : `auth-dialog-priority e2e: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
