#!/usr/bin/env node
/**
 * B-914: the 「发送」 button on a ```draft card, on the BUILT app against a
 * local standalone server (never production) — desktop (light, 中文) and phone
 * (coarse touch, dark, English), plus the anonymous share page. Not part of CI:
 *
 *   pnpm -C packages/happy-web-v2 exec vite build --outDir <tmp>/dist
 *   DATA_DIR=<tmp>/data PORT=39151 pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts migrate
 *   DATA_DIR=<tmp>/data PORT=39151 SIGNUP_MODE=open HAPPY_STATIC_DIR=<tmp>/dist \
 *     pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts serve
 *   VH_SERVER_URL=http://127.0.0.1:39151 pnpm -C packages/happy-web-v2 exec vite --port 39152 --strictPort
 *   node packages/happy-web-v2/e2e/draft-send.mjs --app http://127.0.0.1:39151 --dev http://127.0.0.1:39152 --out <dir>
 *
 * The dev server only seeds the session (its modules can be imported). Checks:
 * the card shows 发送 / Send; a click puts exactly one user message
 * 「发：「<title>」」 (with the edited draft attached when edited) into the
 * conversation, the button turns into 已请求发送 and stays disabled after a
 * reload; the composer's own text is untouched; the share page has no button.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const APP = opt('app', 'http://127.0.0.1:39151');
const DEV = opt('dev', 'http://127.0.0.1:39152');
const OUT = opt('out', null);
if (!OUT) { console.error('--out <dir> is required'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

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

let failures = 0;
const check = (ok, what, detail = '') => { console.log(`  ${ok ? '✓' : '✗'} ${what}${ok || !detail ? '' : ` — ${detail}`}`); if (!ok) failures += 1; };
const prodRequests = [];
const pageErrors = [];
const browser = await chromium.launch({ executablePath: findChromium() });

const PROFILES = {
    desktop: { label: 'desktop light zh', touch: false, options: { viewport: { width: 1280, height: 860 }, locale: 'zh-CN', colorScheme: 'light' },
        send: '发送', requested: '已请求发送', title: 'Reply to Alex', message: '发：「Reply to Alex」' },
    phone: { label: 'phone coarse dark en', touch: true, options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'en-US', colorScheme: 'dark' },
        send: 'Send', requested: 'Send requested', title: 'Release note', message: 'Send it: “Release note”' },
};

async function context(label, options, credentials) {
    const ctx = await browser.newContext({ ...options, serviceWorkers: 'block' });
    await ctx.route(/^https?:\/\/([^/]*\.)?veryhappy\.dev(\/|$)/, (route) => { prodRequests.push(route.request().url()); return route.abort(); });
    await ctx.addInitScript((creds) => {
        try {
            localStorage.setItem('vh-pwa-install-never-v1', '1');
            if (creds) localStorage.setItem('auth_credentials', creds);
        } catch { /* opaque */ }
    }, credentials ?? null);
    ctx.on('page', (page) => page.on('pageerror', (e) => pageErrors.push(`[${label}] ${e.message}`)));
    return ctx;
}

async function dismissOverlays(page) {
    await page.locator('.wn-card').waitFor({ timeout: 4_000 }).catch(() => {});
    for (const name of ['Got it', 'Not now', '知道了', '暂不']) {
        for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 1_000 }).catch(() => {});
    }
}

try {
    console.log('signup + seed (isolated server)');
    const seedCtx = await context('seed', PROFILES.desktop.options, null);
    const page = await seedCtx.newPage();
    await page.goto(`${APP}/signup`);
    const toggle = page.locator('.auth-method-toggle');
    await page.locator('input[autocomplete="username"]').or(toggle).first().waitFor({ timeout: 30_000 });
    if (!(await page.locator('input[autocomplete="username"]').isVisible())) await toggle.click();
    await page.locator('input[autocomplete="username"]').fill(`b914${randomBytes(3).toString('hex')}`);
    const pw = `pw-${randomBytes(6).toString('hex')}`;
    const pws = page.locator('input[autocomplete="new-password"]');
    await pws.nth(0).fill(pw);
    await pws.nth(1).fill(pw);
    await page.locator('form.auth-password-form button[type="submit"]').click();
    await page.locator('.sb .sb-header').waitFor({ timeout: 30_000 });
    const credentials = await page.evaluate(() => localStorage.getItem('auth_credentials'));
    await seedCtx.close();

    const dev = await context('dev', {}, credentials);
    const devPage = await dev.newPage();
    await devPage.goto(`${DEV}/`);
    await devPage.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 60_000, polling: 300 });
    const seed = async (draftTitle, body) => devPage.evaluate(async ({ draftTitle, body }) => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const { encodeBase64 } = await import('/src/encryption/base64.ts');
        for (let i = 0; i < 150 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
        const dataKey = crypto.getRandomValues(new Uint8Array(32));
        const sealedKey = await sync.encryption.encryptEncryptionKey(dataKey);
        const enc = await sync.encryption.openEncryption(dataKey);
        const [metadata] = await enc.encrypt([{ path: '/tmp/b914', host: 'e2e', machineId: 'b914-none', flavor: 'claude' }]);
        const created = await apiSocket.request('/v1/sessions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState: null, dataEncryptionKey: encodeBase64(sealedKey, 'base64') }),
        });
        const sessionId = (await created.json()).session.id;
        let encryption = null;
        for (let i = 0; i < 100 && !(encryption = sync.encryption.getSessionEncryption(sessionId)); i++) {
            await sync.refreshSessions?.();
            await new Promise((r) => setTimeout(r, 200));
        }
        const text = `B914_MESSAGE here is the draft:\n\n\`\`\`draft ${draftTitle}\n${body}\n\`\`\`\n\nReply 发 when it looks right.`;
        const record = { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'assistant', model: 'e2e', content: [{ type: 'text', text }] } } } };
        const content = await encryption.encryptRawRecord(record);
        const posted = await apiSocket.request(`/v3/sessions/${sessionId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ localId: crypto.randomUUID(), content }] }) });
        const link = await apiSocket.request(`/v1/sessions/${sessionId}/share-links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'live', expiresInDays: 7 }) });
        const linkBody = link.ok ? await link.json() : null;
        return { sessionId, posted: posted.status, link: link.status, linkId: linkBody?.link?.id, secret: linkBody?.secret };
    }, { draftTitle, body });
    const seeded = {
        desktop: await seed(PROFILES.desktop.title, 'Hi Alex,\n\nThe rollout finished at 10:40. Nothing for you to do.\n\nThanks'),
        phone: await seed(PROFILES.phone.title, 'Faster update notice and a Send button on drafts.'),
    };
    /** user-role texts of a session, decrypted (via the dev page's own sync) */
    const userTexts = (sessionId) => devPage.evaluate(async (sessionId) => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const encryption = sync.encryption.getSessionEncryption(sessionId);
        const res = await apiSocket.request(`/v3/sessions/${sessionId}/messages?limit=50`);
        const body = await res.json();
        const out = [];
        for (const m of body.messages ?? []) {
            const rec = await encryption.decryptRaw(m.content.c).catch(() => null);
            if (rec?.role === 'user') out.push(typeof rec.content?.text === 'string' ? rec.content.text : JSON.stringify(rec.content));
        }
        return out;
    }, sessionId);
    check(Object.values(seeded).every((s) => s.posted === 200 && s.link === 200), 'seeded two sessions with a draft + share links');

    for (const [key, profile] of Object.entries(PROFILES)) {
        const s = seeded[key];
        console.log(`\n== ${profile.label}`);
        const app = await context(key, profile.options, credentials);
        const p = await app.newPage();
        await p.goto(`${APP}/session/${s.sessionId}`);
        await p.getByText('B914_MESSAGE').first().waitFor({ timeout: 30_000 });
        await dismissOverlays(p);
        const coarse = await p.evaluate(() => matchMedia('(pointer: coarse)').matches);
        check(coarse === profile.touch, `pointer: coarse = ${coarse}`);
        const button = p.locator('.dft .dft-send');
        await button.waitFor({ timeout: 10_000 });
        check((await button.textContent())?.trim() === profile.send, `card shows 「${profile.send}」`);
        const composer = p.locator('.ci-textarea');
        await composer.fill('still typing this');
        if (key === 'phone') {
            // Edited draft: the edit rides along in <edited_drafts>.
            await p.locator('.dft-text').fill('Faster update notice and a Send button on drafts. (edited)');
        }
        await button.scrollIntoViewIfNeeded();
        await p.screenshot({ path: join(OUT, `draft-send-${key}-before.png`) });
        if (profile.touch) await button.tap(); else await button.click();
        await p.locator('.dft-send[data-send-state="requested"]').waitFor({ timeout: 10_000 });
        check((await button.textContent())?.trim() === profile.requested, `after the click: 「${profile.requested}」`);
        check(await button.isDisabled(), 'button disabled after the click');
        check(await composer.inputValue() === 'still typing this', 'composer text untouched');
        await p.waitForTimeout(1_500);
        await p.screenshot({ path: join(OUT, `draft-send-${key}-after.png`) });
        // No agent runs here, so the message is either sent (server) or waits in
        // the composer's queue dock for the session to come up — both are the
        // same path a typed reply takes.
        const delivered = async () => {
            const server = (await userTexts(s.sessionId)).filter((t) => t.includes(profile.message));
            const dock = await p.locator('.ci-queue-item').filter({ hasText: profile.message }).count();
            return { server, dock };
        };
        const first = await delivered();
        check(first.server.length + first.dock === 1, `exactly one user message 「${profile.message}」 (server ${first.server.length}, queued ${first.dock})`);
        if (key === 'phone' && first.server.length) check(first.server[0].includes('<edited_drafts') && first.server[0].includes('(edited)'), 'the edited version rides along in <edited_drafts>', first.server[0].slice(0, 300));
        await button.click({ force: true }).catch(() => {});
        await p.waitForTimeout(800);
        const again = await delivered();
        check(again.server.length + again.dock === 1, 'a second click sends nothing');
        await p.reload();
        await p.getByText('B914_MESSAGE').first().waitFor({ timeout: 30_000 });
        await p.locator('.dft .dft-send').waitFor({ timeout: 10_000 });
        check(await p.locator('.dft-send[data-send-state="requested"]').count() === 1, 'still 「已请求发送」 after a reload');
        await app.close();

        const anon = await context(`${key}-share`, profile.options, null);
        const sp = await anon.newPage();
        await sp.goto(`${APP}/s/${s.linkId}#${s.secret}`);
        await sp.getByText('B914_MESSAGE').first().waitFor({ timeout: 30_000 });
        await sp.waitForTimeout(1_000);
        check(await sp.locator('.dft-send').count() === 0, 'share page (read-only): no Send button');
        await sp.screenshot({ path: join(OUT, `draft-send-${key}-share.png`) });
        await anon.close();
    }
    await dev.close();

    console.log('\n== totals');
    check(pageErrors.length === 0, 'pageerror 0', pageErrors.slice(0, 5).join(' | '));
    check(prodRequests.length === 0, 'no request reached *.veryhappy.dev', prodRequests.slice(0, 3).join(' '));
} catch (error) {
    console.log('  ✗ aborted:', error instanceof Error ? error.stack : error);
    failures += 1;
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
