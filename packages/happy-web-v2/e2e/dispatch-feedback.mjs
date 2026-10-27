#!/usr/bin/env node
/**
 * Dispatch feedback on a big account (Owner 10-27: 「我点了机器人，为啥没派发新的
 * session 呢」→「我看到创建出来了，就是不明显，对话太多了」). End to end in Chromium
 * against a local standalone server, a real paired daemon and Vite dev; not
 * part of CI — run by hand:
 *
 *   DATA_DIR=<tmp> PORT=3381 pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts migrate
 *   DATA_DIR=<tmp> PORT=3381 SIGNUP_MODE=open VH_AGENT_TEAMS_ENABLED=true VH_AUTOMATIONS_ENABLED=true \
 *     pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts serve
 *   VH_SERVER_URL=http://127.0.0.1:3381 pnpm -C packages/happy-web-v2 exec vite --port 8381 --strictPort
 *   pnpm -C packages/happy-cli build
 *   node packages/happy-web-v2/e2e/dispatch-feedback.mjs --app http://127.0.0.1:8381 --server http://127.0.0.1:3381 \
 *     --work <empty tmp dir> [--out <dir>] [--sessions 60] [--devices desktop,phone]
 *
 * The daemon runs with HOME=<work>/home and no Claude/Anthropic credentials in
 * its env: spawned agents start (the session exists) and then fail to reach
 * the API — nothing runs on a real account.
 *
 * Seeds --sessions conversations across 6 folders, scrolls the sidebar away
 * from the top, then per device, for every entry that starts a session
 * without entering it:
 *   TEAM      Teams page 新建任务 → a new member's session (async team spawn)
 *   AUTO      Automation 立即运行 → the run's session (async run)
 *   PENDING   新会话: send the first message, leave before it starts
 *   FAIL      (desktop) 新建任务 into a directory the daemon cannot create → error toast with the reason
 * and asserts: the toast 「已创建 <名字> 的会话 · 打开」 appears, the sidebar shows
 * the new row in view, flashing, with 「新」 (phones: on the list), 打开 opens
 * the session and the 「新」 is gone afterwards; on a phone the toast is clear
 * of the composer and its button is ≥44px. Exit code 1 on any failed check.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const APP = opt('app', 'http://127.0.0.1:8381');
const SERVER = opt('server', 'http://127.0.0.1:3381');
const WORK = opt('work', null);
const OUT = opt('out', null);
const SESSIONS = Number(opt('sessions', '60'));
const DEVICES = opt('devices', 'desktop,phone').split(',');
// --before: a build without the feature (the 改前 shots) — record what each entry shows and carry on.
const BEFORE = args.includes('--before');
if (!WORK) { console.error('--work <empty tmp dir> is required'); process.exit(2); }
mkdirSync(WORK, { recursive: true });
if (OUT) mkdirSync(OUT, { recursive: true });
const CLI = resolve(import.meta.dirname, '../../happy-cli/dist/index.mjs');

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
    return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The daemon must not inherit this session's team scope, tmux, or any Claude / Anthropic credentials.
const HOME = join(WORK, 'home');
mkdirSync(HOME, { recursive: true });
const cliEnv = { ...process.env, HOME, HAPPY_HOME_DIR: join(WORK, 'cli-home'), HAPPY_SERVER_URL: SERVER, HAPPY_WEBAPP_URL: APP, VH_TMUX_SOCKET: join(WORK, 'tmux.sock') };
for (const name of Object.keys(cliEnv)) {
    if (/^(VH_TEAM|HAPPY_MANAGED|HAPPY_SPAWNED_BY|VH_PEER|HAPPY_DAEMON_SUPERVISOR|HAPPY_SESSION_ID|TMUX|CLAUDE|ANTHROPIC)/.test(name) && name !== 'VH_TMUX_SOCKET') delete cliEnv[name];
}

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const DESKTOP = { viewport: { width: 1440, height: 900 } };

const browser = await chromium.launch({ executablePath: findChromium() });
let daemonStarted = false;
const shot = async (page, name) => { if (OUT) await page.screenshot({ path: join(OUT, `${name}.png`) }); };
async function dismissOverlays(page) {
    await page.locator('.wn-card').waitFor({ timeout: 4_000 }).catch(() => {});
    for (const name of ['Got it', 'Not now', '知道了', '暂不', '以后再说']) {
        for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 1_000 }).catch(() => {});
    }
}
async function api(token, path, body) {
    const res = await fetch(`${SERVER}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(data)?.slice(0, 200)}`);
    return data;
}

/** Scroll the sidebar's own list to the end so a row near the top is out of view. */
async function scrollSidebarAway(page) {
    await page.locator('.sb-list').evaluate((el) => { el.scrollTop = el.scrollHeight; });
}
/** The flashing row: in the list's viewport, carrying 「新」. */
async function freshRowState(page, title) {
    return page.evaluate((title) => {
        const list = document.querySelector('.sb-list');
        // title null: the row the reveal picked (flashing, or still marked 「新」)
        const rows = [...document.querySelectorAll('.sb-row')].filter((r) => (title ? r.textContent?.includes(title) : r.classList.contains('sb-row--flash') || !!r.querySelector('.sb-row-new')));
        const row = rows[0];
        if (!list || !row) return { found: false };
        const lr = list.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        return {
            found: true,
            inView: rr.top >= lr.top - 1 && rr.bottom <= lr.bottom + 1 && rr.height > 0,
            flash: row.classList.contains('sb-row--flash'),
            fresh: !!row.querySelector('.sb-row-new'),
            scrollTop: list.scrollTop,
        };
    }, title);
}
async function toastState(page, text, timeout = 120_000) {
    const toast = page.locator('.vh-toast--button', { hasText: text }).last();
    await toast.waitFor({ timeout }).catch(async (e) => {
        console.log('    toasts on screen:', JSON.stringify(await page.locator('.vh-toast').allTextContents()), new URL(page.url()).pathname);
        await shot(page, `fail-waiting-${text.replace(/[^\w-]+/g, '_')}`);
        throw e;
    });
    return toast.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const btn = el.querySelector('.vh-toast-btn')?.getBoundingClientRect();
        const composer = document.querySelector('.ai-composer, .agent-input, [data-composer]')?.getBoundingClientRect() ?? null;
        return { text: el.textContent, top: r.top, bottom: r.bottom, btnH: btn?.height ?? 0, btnW: btn?.width ?? 0, composerTop: composer?.top ?? null, coarse: matchMedia('(pointer: coarse)').matches };
    });
}

try {
    step('sign up (desktop context)');
    const setup = await browser.newContext({ ...DESKTOP, locale: 'en-US' });
    await setup.addInitScript(() => { try { localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch { /* ignore */ } });
    const page = await setup.newPage();
    const handle = `dispatch${randomBytes(3).toString('hex')}`;
    const pw = `pw-${randomBytes(6).toString('hex')}`;
    const toggle = page.locator('.auth-method-toggle');
    // Vite dev's first cold load can stall on a dependency re-optimisation: load again once.
    for (let attempt = 0; attempt < 3; attempt++) {
        await page.goto(`${APP}/signup`);
        await page.locator('input[autocomplete="username"]').or(toggle).first().waitFor({ timeout: 60_000 }).catch(() => {});
        if (!(await page.locator('input[autocomplete="username"]').isVisible()) && await toggle.isVisible()) await toggle.click();
        if (await page.locator('input[autocomplete="username"]').isVisible()) break;
    }
    await page.locator('input[autocomplete="username"]').fill(handle);
    const pws = page.locator('input[autocomplete="new-password"]');
    await pws.nth(0).fill(pw);
    await pws.nth(1).fill(pw);
    await page.locator('form.auth-password-form button[type="submit"]').click();
    await page.locator('.sb .sb-header').waitFor({ timeout: 60_000 });
    await dismissOverlays(page);
    const credentials = await page.evaluate(() => localStorage.getItem('auth_credentials'));
    const token = JSON.parse(credentials).token;

    step('pair the daemon and start it (HOME without credentials)');
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
    await page.goto(connectUrl);
    await page.getByRole('button', { name: /approve|connect|批准|连接/i }).first().click();
    check(await new Promise((r) => login.once('exit', r)) === 0, 'CLI paired');
    const daemon = spawnSync(process.execPath, [CLI, 'daemon', 'start'], { env: cliEnv, encoding: 'utf8', timeout: 60_000 });
    daemonStarted = true;
    check(daemon.status === 0, 'daemon started', (daemon.stdout + daemon.stderr).trim().split('\n').slice(-1)[0]);
    let machineId = null;
    for (let i = 0; i < 100 && !machineId; i++) {
        const list = await api(token, '/v1/machines').catch(() => []);
        machineId = (Array.isArray(list) ? list : list.machines ?? []).find((m) => m.active)?.id ?? null;
        if (!machineId) await sleep(300);
    }
    check(!!machineId, 'machine online');

    step(`seed ${SESSIONS} conversations across 6 folders`);
    const repo = join(WORK, 'repo');
    for (let i = 0; i < 6; i++) mkdirSync(join(repo, `svc-${i}`), { recursive: true });
    await page.goto(`${APP}/`);
    await page.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 60_000, polling: 300 });
    const seeded = await page.evaluate(async ({ machineId, repo, n }) => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const { encodeBase64 } = await import('/src/encryption/base64.ts');
        for (let i = 0; i < 300 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
        let ok = 0;
        for (let i = 0; i < n; i++) {
            const dataKey = crypto.getRandomValues(new Uint8Array(32));
            const sealedKey = await sync.encryption.encryptEncryptionKey(dataKey);
            const enc = await sync.encryption.openEncryption(dataKey);
            const [metadata] = await enc.encrypt([{ path: `${repo}/svc-${i % 6}`, host: 'e2e', machineId, flavor: 'claude', summary: { text: `Seeded task ${i + 1}`, updatedAt: Date.now() } }]);
            const res = await apiSocket.request('/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState: null, dataEncryptionKey: encodeBase64(sealedKey, 'base64') }) });
            if (res.ok) ok++;
        }
        await sync.refreshSessions?.();
        return ok;
    }, { machineId, repo, n: SESSIONS });
    check(seeded === SESSIONS, `${SESSIONS} conversations seeded`, String(seeded));
    await setup.close();

    const { team } = await api(token, '/v1/teams', { name: 'E2E team', machineId, requestId: randomUUID() });
    // One automation per device: a second 立即运行 while the first run holds its slot is skipped (concurrency 'skip').
    const automations = {};
    for (const device of DEVICES) automations[device] = (await api(token, '/v1/automations', { name: `nightly-digest-${device}`, machineId, trigger: { kind: 'manual' }, action: { kind: 'spawn', agent: 'claude', directory: join(repo, 'svc-1'), prompt: 'Summarize the day' } })).automation;
    check(!!team?.id && DEVICES.every((d) => automations[d]?.id), 'team and automations created');

    for (const device of DEVICES) {
        const phone = device === 'phone';
        step(`── ${device}`);
        const ctx = await browser.newContext({ ...(phone ? PHONE : DESKTOP), locale: 'zh-CN' });
        await ctx.addInitScript((creds) => { try { if (!sessionStorage.getItem('df-seeded')) { sessionStorage.setItem('df-seeded', '1'); localStorage.setItem('auth_credentials', creds); localStorage.setItem('vh-pwa-install-never-v1', '1'); } } catch { /* ignore */ } }, credentials);
        const p = await ctx.newPage();
        p.on('pageerror', (e) => console.log(`  [${device}] pageerror ${e.message}`));
        await p.goto(`${APP}/`);
        await p.locator('.sb .sb-header').waitFor({ timeout: 60_000 });
        await dismissOverlays(p);
        await p.locator('.sb-row').nth(Math.min(30, SESSIONS - 1)).waitFor({ timeout: 60_000 });
        check((await p.locator('.sb-row').count()) >= 30, `${device}: big sidebar (≥30 rows)`, String(await p.locator('.sb-row').count()));

        /** After a dispatch: toast, sidebar row (phones: back on the list), 打开, 「新」 gone. */
        async function verify(label, name, rowTitle) {
            if (BEFORE) {
                const seen = await toastState(p, `已创建 ${name} 的会话`, 25_000).then(() => true, () => false);
                check(seen, `${device} ${label}: toast (before: none expected)`);
                await shot(p, `${device}-${label}-toast`);
                if (phone) { for (let i = 0; i < 3 && !(await p.locator('.sb-list').isVisible()); i++) { await p.goBack(); await sleep(400); } }
                await sleep(1500);
                await shot(p, `${device}-${label}-sidebar`);
                return null;
            }
            const ts = await toastState(p, `已创建 ${name} 的会话`);
            check(ts.text?.includes('打开'), `${device} ${label}: toast 「${ts.text}」`);
            await shot(p, `${device}-${label}-toast`);
            if (phone) {
                check(ts.btnH >= 44 && ts.btnW >= 44 && ts.coarse, `${device} ${label}: 打开 button ≥44px (coarse)`, `${Math.round(ts.btnW)}×${Math.round(ts.btnH)}`);
                check(ts.composerTop === null || ts.bottom <= ts.composerTop, `${device} ${label}: toast clear of the composer`, `toast bottom ${Math.round(ts.bottom)} composer top ${ts.composerTop}`);
                for (let i = 0; i < 3 && !(await p.locator('.sb-list').isVisible()); i++) { await p.goBack(); await sleep(400); }
                await p.locator('.sb-list').waitFor({ timeout: 10_000 });
            }
            let row = { found: false };
            for (let i = 0; i < 60 && !(row.found && row.inView && row.fresh && row.flash); i++) { await sleep(250); row = await freshRowState(p, rowTitle); }
            check(row.found && row.inView, `${device} ${label}: new row scrolled into the sidebar's view`, JSON.stringify(row));
            if (!row.found) console.log('    diag', JSON.stringify(await p.evaluate(() => import('/src/sync/dispatchFeedback.ts').then((m) => { const st = m.getDispatchFeedbackState(); return { reveal: st.reveal, highlight: st.highlight, fresh: Object.keys(st.fresh), path: location.pathname, teamRows: [...document.querySelectorAll('.sb-team-row')].map((r) => r.outerHTML.slice(0, 160)) }; }))));
            check(row.fresh, `${device} ${label}: row carries 「新」`);
            check(row.flash, `${device} ${label}: row highlighted`);
            await shot(p, `${device}-${label}-sidebar`);
            const toast = p.locator('.vh-toast--button', { hasText: `已创建 ${name} 的会话` }).last();
            if (await toast.count()) {
                await toast.locator('.vh-toast-btn').click();
                await p.waitForURL(/\/session\/[^/]+$/, { timeout: 10_000 });
                check(true, `${device} ${label}: 打开 → ${new URL(p.url()).pathname}`);
                await shot(p, `${device}-${label}-opened`);
            } else {
                check(false, `${device} ${label}: toast still there to press 打开`);
                await p.locator('.sb-row', { hasText: rowTitle }).first().locator('.sb-row-main').click();
            }
            const opened = new URL(p.url()).pathname;
            await sleep(600);
            if (phone) { await p.goBack(); await p.locator('.sb-list').waitFor({ timeout: 10_000 }); }
            const openedId = decodeURIComponent(opened.split('/').pop() ?? '');
            // The row may be folded away again (a member under its team): then no hint may remain either.
            const after = await p.evaluate(async (id) => {
                const { getDispatchFeedbackState } = await import('/src/sync/dispatchFeedback.ts');
                const el = document.querySelector(`[data-dragkey="${CSS.escape(id)}"] .sb-row`);
                return { marked: id in getDispatchFeedbackState().fresh, rowNew: !!el?.querySelector('.sb-row-new'), hints: document.querySelectorAll('.sb-row-new, .sb-group-new').length };
            }, openedId);
            check(!after.marked && !after.rowNew && after.hints === 0, `${device} ${label}: 「新」 gone after opening once`, JSON.stringify(after));
            return opened;
        }

        step(`${device}: TEAM 新建任务`);
        const bot = `Dev-${device}`;
        // Phones move in-app (list → team page) so 返回 lands on the same page load, as a user's would.
        if (phone) { await p.locator(`.sb-team-row[data-team-id="${team.id}"] button:not(.sb-tree-chevron)`).first().click(); await p.waitForURL(/\/teams\//); }
        else await p.goto(`${APP}/teams/${team.id}`);
        await p.getByRole('button', { name: '新建任务' }).click();
        await p.locator('textarea[name="goal"]').fill(`E2E ${device} task`);
        await p.locator('textarea[name="acceptance"]').fill('done');
        await p.locator('input[name="directory"]').fill(join(repo, 'svc-2'));
        await p.locator('input[name="botName"]').fill(bot);
        if (!phone) await scrollSidebarAway(p);
        await p.locator('form button.teams-primary').click();
        await verify('team', bot, bot);

        step(`${device}: AUTO 立即运行`);
        if (phone) {
            await p.locator('.sb').getByRole('button', { name: /^更多/ }).first().click();
            await p.getByRole('menuitem', { name: '自动化' }).click();
            await p.waitForURL(/\/automations/);
        } else {
            await p.goto(`${APP}/automations/${automations[device].id}`);
            await p.locator('.sb-list').waitFor(); await scrollSidebarAway(p);
        }
        await dismissOverlays(p);
        if (phone) { await p.getByText(`nightly-digest-${device}`, { exact: true }).first().click(); await p.waitForURL(new RegExp(automations[device].id)); }
        await p.locator('.au-btn--primary[aria-label="立即运行"]').click();
        const autoPath = await verify('automation', `nightly-digest-${device}`, null).catch(async (e) => {
            console.log('    runs:', JSON.stringify((await api(token, `/v1/automations/runs?automationId=${automations[device].id}`)).runs.map((r) => ({ status: r.status, sessionId: r.sessionId, error: r.error, summary: r.summary }))));
            throw e;
        });
        // Free the machine's automation slot for the next device (the spawned agent never finishes: no credentials).
        for (const run of (await api(token, `/v1/automations/runs?automationId=${automations[device].id}`)).runs) {
            if (!['done', 'failed', 'skipped', 'expired', 'cancelled'].includes(run.status)) await api(token, `/v1/automations/runs/${run.id}/cancel`, {}).catch(() => {});
        }

        step(`${device}: PENDING 新会话 started, user leaves before it lands`);
        // The store call NewSessionModal / the project composer make (create + go to the pending page),
        // then the user moves on at once; the session lands while they are elsewhere.
        await p.goto(`${APP}/`);
        await p.locator('.sb .sb-header').waitFor();
        if (!phone) await scrollSidebarAway(p);
        await p.locator('#vh-splash').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});
        await dismissOverlays(p);
        // A spawn lands in ~1 s: open the starting row and leave it from inside the page, without round trips.
        const left = await p.evaluate(async ({ machineId, path, phone }) => {
            const { pendingSessions } = await import('/src/sync/pendingSessionsRuntime.ts');
            const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
            const id = pendingSessions.create({ machineId, path, agent: 'claude', permissionMode: 'default', source: 'dialog', firstMessage: 'E2E pending — leave before it starts' }).pendingId;
            for (let i = 0; i < 30 && !document.querySelector('[data-pending-rows] .sb-row-main'); i++) await frame();
            document.querySelector('[data-pending-rows] .sb-row-main')?.click();
            for (let i = 0; i < 30 && !location.pathname.includes(id); i++) await frame();
            const opened = location.pathname;
            if (phone) history.back();
            else [...document.querySelectorAll('.sb button, .sb a')].find((el) => el.textContent?.trim() === '自动化')?.click();
            for (let i = 0; i < 30 && location.pathname === opened; i++) await frame();
            return { id, opened, now: location.pathname };
        }, { machineId, path: join(repo, 'svc-3'), phone });
        check(left.opened.includes(left.id) && !left.now.includes(left.id), `${device} pending: opened ${left.opened}, left for ${left.now} before it started`);
        await verify('pending', 'svc-3', null);

        if (phone && !BEFORE) {
            step(`${device}: toast over a conversation — clear of the composer`);
            await p.goto(`${APP}${autoPath}`);
            const box = p.locator('textarea').last();
            await box.waitFor({ timeout: 20_000 });
            await p.evaluate(() => import('/src/sync/dispatchFeedback.ts').then((m) => m.announceDispatched({ sessionId: 'layout-probe', name: 'Layout probe' })));
            const ts = await toastState(p, 'Layout probe');
            const input = await box.evaluate((el) => (el.closest('form, [class*="composer"], [class*="agent-input"]') ?? el).getBoundingClientRect().top);
            check(ts.bottom <= input, `${device}: toast (bottom ${Math.round(ts.bottom)}) clear of the composer (top ${Math.round(input)})`);
            check(ts.btnH >= 44 && ts.coarse, `${device}: 打开 ≥44px on touch`, `${Math.round(ts.btnW)}×${Math.round(ts.btnH)}`);
            await shot(p, `${device}-toast-over-composer`);
        }

        if (!phone) {
            step(`${device}: FAIL 新建任务 into a directory the daemon cannot create`);
            await p.goto(`${APP}/teams/${team.id}`);
            await p.getByRole('button', { name: '新建任务' }).click();
            await p.locator('textarea[name="goal"]').fill('E2E failing task');
            await p.locator('textarea[name="acceptance"]').fill('done');
            await p.locator('input[name="directory"]').fill('/proc/vh-e2e-nope/sub');
            await p.locator('input[name="botName"]').fill('Dev-fail');
            await p.locator('form button.teams-primary').click();
            const err = p.locator('.vh-toast--error', { hasText: 'Dev-fail' }).last();
            const shown = await err.waitFor({ timeout: BEFORE ? 30_000 : 120_000 }).then(() => true, () => false);
            check(shown, `${device} fail: error toast with the reason`, shown ? await err.textContent() : 'none');
            await shot(p, `${device}-fail-toast`);
        }
        await ctx.close();
    }
} catch (e) {
    check(false, 'run', e?.stack ?? String(e));
} finally {
    if (daemonStarted) spawnSync(process.execPath, [CLI, 'daemon', 'stop'], { env: cliEnv, encoding: 'utf8', timeout: 30_000 });
    await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
