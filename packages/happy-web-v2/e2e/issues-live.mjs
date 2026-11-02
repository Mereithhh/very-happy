#!/usr/bin/env node
/**
 * B-873 × B-872: Issues end to end on the REAL server — a standalone server
 * (S line, `VH_ISSUES_ENABLED=true`) serving the BUILT web app, a real paired
 * daemon (machine row, online state), Chromium driving the real UI. The daemon
 * side of Issues (C line: dispatch worker, MCP tools) is not merged yet, so
 * this script plays the issue worker and the agent over the account-authenticated
 * routes (`/v1/issues/dispatch*`, `/runs/:id/session-event`, `/agent/*`).
 * Not part of CI; set up like `terminal-projects.mjs`:
 *
 *   pnpm -C packages/happy-web-v2 exec vite build && pnpm -C packages/happy-cli build
 *   DATA_DIR=<tmp> PORT=3873 tsx --env-file=.env.dev ./sources/standalone.ts migrate   (packages/happy-server)
 *   DATA_DIR=<tmp> PORT=3873 SIGNUP_MODE=open VH_ISSUES_ENABLED=true HAPPY_STATIC_DIR=$PWD/packages/happy-web-v2/dist tsx --env-file=.env.dev ./sources/standalone.ts serve
 *   node packages/happy-web-v2/e2e/issues-live.mjs --app http://127.0.0.1:3873 --work <empty tmp dir> [--out <dir>]
 *   # switch off: restart serve without VH_ISSUES_ENABLED, then add --off
 *
 * On (per device × language): 新建 issue → 指派 agent (+ folder) → run queued →
 * worker claims, session starts → running + in_progress → comment previewed
 * and delivered into the live run → agent in_review with a summary → /board
 * 需要我决策 → 完成 → issue done; a second issue → 退回 with a note → todo +
 * my note on the timeline, routed to the run; ⌘K finds the issue; /todos →
 * /issues?assignee=none.
 * Off (`--off`): /v1/issues 404 issues_disabled, /todos is the old page, no
 * Issues / 运行中 entries, no ⌘K issue rows.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const APP = opt('app', 'http://127.0.0.1:3873');
const WORK = opt('work', null);
const OUT = opt('out', null);
const OFF = args.includes('--off');
const DEVICES = { desktop: { width: 1280, height: 860, dpr: 1, coarse: false }, phone: { width: 390, height: 844, dpr: 3, coarse: true } };
const LANGS = opt('langs', 'zh-CN,en-US').split(',');
const ONLY_DEVICES = opt('devices', 'desktop,phone').split(',');
if (!WORK) { console.error('--work <empty tmp dir> is required'); process.exit(2); }
mkdirSync(WORK, { recursive: true });
if (OUT) mkdirSync(OUT, { recursive: true });
const CLI = resolve(import.meta.dirname, '../../happy-cli/dist/index.mjs');
const COPY = {
    'zh-CN': { agent: 'Agent', waiting: '等待', inProgress: '进行中', queuedPreview: '排队送进', delivered: '已送达', review: '待验收', todos: '待办', reject: '退回', newIssue: '新建 issue' },
    'en-US': { agent: 'Agent', waiting: 'Waiting for', inProgress: 'In progress', queuedPreview: 'Queued into', delivered: 'Delivered', review: 'in review', todos: 'Todos', reject: 'Return', newIssue: 'New issue' },
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
    return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeoutMs = 15_000, every = 250) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const v = await fn();
        if (v || Date.now() > end) return v;
        await sleep(every);
    }
}
const cliEnv = { ...process.env, HAPPY_HOME_DIR: join(WORK, 'cli-home'), HAPPY_SERVER_URL: APP, HAPPY_WEBAPP_URL: APP, VH_TMUX_SOCKET: join(WORK, 'tmux.sock') };
for (const name of Object.keys(cliEnv)) {
    if (/^(CLAUDE_CODE_)/.test(name) || (/^VH_/.test(name) && name !== 'VH_TMUX_SOCKET') || ['HAPPY_MANAGED', 'HAPPY_SPAWNED_BY', 'HAPPY_DAEMON_SUPERVISOR', 'HAPPY_SESSION_ID', 'HAPPY_MCP_URL', 'TMUX', 'TMUX_PANE', 'CLAUDE_AGENT_SDK_VERSION'].includes(name)) delete cliEnv[name];
}

/** The release-notes card opens on a fresh account; it is not what is under test. */
async function dismissNotices(page) {
    const card = page.locator('.wn-card');
    if (await card.waitFor({ timeout: 4_000 }).then(() => true, () => false)) {
        await page.keyboard.press('Escape');
        await card.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
    }
}

/**
 * Capability entries in order: the rows shown, then whatever B-713 folded into
 * 「更多能力」 / the phone's 「更多」 (a fresh account with a project hint folds
 * them all on desktop). Menu items are matched by their label.
 */
const ENTRY_LABELS = { issues: ['Issues'], board: ['运行中', 'Running'], projects: ['项目', 'Projects'], teams: ['团队', 'Teams'], automations: ['自动化', 'Automations'], todos: ['待办', 'Todos'], people: ['联系人', 'People', 'Contacts'], feedback: ['反馈', '发送反馈', 'Feedback', 'Send feedback'] };
async function sidebarEntries(page) {
    const shown = await page.evaluate(() => [...document.querySelectorAll('[data-cap]')].map((e) => e.getAttribute('data-cap')));
    const more = page.locator('.sb-caps-more, .sb-chip-more').first();
    if (!(await more.count())) return shown;
    await more.click();
    const items = await page.locator('[role="menuitem"]').allInnerTexts();
    await page.keyboard.press('Escape');
    const keyOf = (text) => Object.entries(ENTRY_LABELS).find(([, names]) => names.some((n) => text.trim().split(' · ')[0] === n))?.[0] ?? `?${text.trim()}`;
    return [...shown, ...items.map(keyOf)];
}

const browser = await chromium.launch({ executablePath: findChromium() });
let daemonStarted = false;
let workerTimer = null;
try {
    step('sign up');
    const setup = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
    await setup.addInitScript(() => { try { localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch { /* */ } });
    const page0 = await setup.newPage();
    const handle = `is${randomBytes(3).toString('hex')}`;
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
    const api = async (path, init = {}) => {
        const res = await fetch(`${APP}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

    if (OFF) {
        const probe = await api('/v1/issues?limit=1');
        check(probe.status === 404 && probe.body?.error === 'issues_disabled', 'switch off: /v1/issues → 404 issues_disabled', `${probe.status} ${JSON.stringify(probe.body)}`);
        await setup.close();
        for (const [deviceName, d] of Object.entries(DEVICES).filter(([n]) => ONLY_DEVICES.includes(n))) {
            for (const lang of LANGS) {
                const tag = `off-${deviceName}-${lang}`;
                const context = await browser.newContext({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.dpr, hasTouch: d.coarse, isMobile: d.coarse, locale: lang, serviceWorkers: 'block' });
                await context.addInitScript((creds) => { try { localStorage.setItem('auth_credentials', creds); localStorage.setItem('vh-pwa-install-never-v1', '1'); localStorage.setItem('vh-notif-optin-dismissed-v1', '1'); } catch { /* */ } }, credentials);
                const page = await context.newPage();
                await page.goto(`${APP}/todos`);
                await page.waitForSelector('.td-title', { timeout: 30_000 });
                await dismissNotices(page);
                check((await page.locator('.td-title').innerText()).trim() === COPY[lang].todos && new URL(page.url()).pathname === '/todos', `${tag}: /todos is the old Todos page`);
                if (OUT) await page.screenshot({ path: join(OUT, `${tag}-todos.png`) });
                await page.goto(`${APP}/`);
                // A fresh account's phone home is the first-run page (sidebar mounted, hidden): read the DOM, open no menu.
                await page.locator('.sb .sb-header').waitFor({ state: 'attached', timeout: 30_000 });
                await dismissNotices(page);
                await sleep(1500);
                const caps = d.coarse ? await page.evaluate(() => [...document.querySelectorAll('[data-cap]')].map((e) => e.getAttribute('data-cap'))) : await sidebarEntries(page);
                check(!caps.includes('issues') && !caps.includes('board') && (d.coarse || caps.includes('todos')), `${tag}: no Issues / 运行中 entries${d.coarse ? '' : ', 待办 still there'}`, caps.join(','));
                await page.keyboard.press('Control+k');
                await page.locator('.cp-search-input').fill('VH-1');
                await sleep(400);
                check((await page.locator('.cp-group--issues').count()) === 0, `${tag}: ⌘K has no issue rows`);
                if (OUT) await page.screenshot({ path: join(OUT, `${tag}-sidebar.png`) });
                await context.close();
            }
        }
    } else {
        step('pair the CLI and start a real daemon');
        const login = spawn(process.execPath, [CLI, 'auth', 'login'], { env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        let loginOut = '';
        login.stdout.on('data', (b) => { loginOut += b; });
        login.stderr.on('data', (b) => { loginOut += b; });
        const connectUrl = await until(() => /(https?:\/\/\S+\/terminal\/connect#key=\S+)/.exec(loginOut)?.[1], 20_000, 200);
        if (!connectUrl) throw new Error(`no pairing URL: ${loginOut.slice(0, 300)}`);
        await page0.goto(connectUrl);
        await page0.getByRole('button', { name: /approve|connect|批准|连接/i }).first().click();
        check((await new Promise((r) => login.once('exit', r))) === 0, 'CLI paired');
        const daemon = spawnSync(process.execPath, [CLI, 'daemon', 'start'], { env: cliEnv, encoding: 'utf8', timeout: 60_000 });
        daemonStarted = true;
        check(daemon.status === 0, 'daemon started');
        const machineId = await until(async () => {
            const { body } = await api('/v1/machines');
            return (Array.isArray(body) ? body : body?.machines ?? []).find((m) => m.active)?.id ?? null;
        }, 30_000, 300);
        check(!!machineId, 'machine online');
        await setup.close();

        // The issue worker (C line stand-in): poll, claim, start a session for spawns, deliver messages.
        const sessions = new Map(); // runId → sessionId
        const workerLog = [];
        const tick = async () => {
            const { body } = await api(`/v1/issues/dispatch?machineId=${machineId}&workerVersion=1`);
            for (const d of body?.dispatches ?? []) {
                const claim = await post(`/v1/issues/dispatch/${d.id}/claim`, { machineId });
                const claimId = claim.body?.dispatch?.claimId;
                if (!claimId) continue;
                let sessionId = sessions.get(d.runId);
                if (d.kind === 'spawn') {
                    const s = await post('/v1/sessions', { tag: `issue-${d.runId}`, metadata: Buffer.from(JSON.stringify({ path: WORK })).toString('base64') });
                    sessionId = s.body?.session?.id;
                    sessions.set(d.runId, sessionId);
                    workerLog.push({ kind: 'spawn', runId: d.runId, prompt: d.spawn?.prompt?.slice(0, 80) });
                } else workerLog.push({ kind: 'message', runId: d.runId, text: d.message?.text?.slice(0, 80) });
                const done = await post(`/v1/issues/dispatch/${d.id}/complete`, { machineId, claimId, sessionId: sessionId ?? d.message?.sessionId });
                if (done.status !== 200) workerLog.push({ kind: 'complete-failed', status: done.status, body: done.body });
                if (d.kind === 'spawn') await post(`/v1/issues/runs/${d.runId}/session-event`, { machineId, sessionId, event: 'running' });
            }
        };
        await tick();
        workerTimer = setInterval(() => { void tick().catch(() => {}); }, 1500);

        for (const [deviceName, d] of Object.entries(DEVICES).filter(([n]) => ONLY_DEVICES.includes(n))) {
            for (const lang of LANGS) {
                const c = COPY[lang];
                const tag = `${deviceName}-${lang}`;
                step(`flow ${tag}`);
                const context = await browser.newContext({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.dpr, hasTouch: d.coarse, isMobile: d.coarse, locale: lang, serviceWorkers: 'block' });
                await context.addInitScript((creds) => { try { localStorage.setItem('auth_credentials', creds); localStorage.setItem('vh-pwa-install-never-v1', '1'); localStorage.setItem('vh-notif-optin-dismissed-v1', '1'); } catch { /* */ } }, credentials);
                const page = await context.newPage();
                page.on('pageerror', (e) => console.log(`  ! pageerror ${e.message}`));
                const shot = async (name) => { if (OUT) await page.screenshot({ path: join(OUT, `${tag}-${name}.png`) }); };

                await page.goto(`${APP}/issues`);
                await page.waitForSelector('[data-testid="issues-screen"]', { timeout: 30_000 });
                await dismissNotices(page);
                const create = async (title) => {
                    await page.click('[data-testid="issues-new"]');
                    const dialog = page.locator('[data-testid="new-issue-dialog"]');
                    await dialog.waitFor();
                    await dialog.locator('input.is-new-title-input').fill(title);
                    await dialog.locator('.is-assignee-kind button', { hasText: c.agent }).click();
                    const codex = dialog.locator('.ns-agent', { hasText: 'codex' });
                    const agent = (await codex.count()) && (await codex.getAttribute('aria-disabled')) !== 'true' ? 'codex' : 'claude';
                    await dialog.locator('.ns-agent', { hasText: agent }).click();
                    await dialog.locator('#is-new-dir').fill(WORK);
                    await shot('new-dialog');
                    await dialog.locator('[data-testid="new-issue-create"]').click();
                    await page.waitForSelector('[data-testid="issue-detail"]', { timeout: 15_000 });
                    return { key: await page.getAttribute('[data-testid="issue-detail"]', 'data-issue'), agent };
                };

                // 1–2. create, assign, run starts
                const first = await create(`Live ${tag} ${randomBytes(2).toString('hex')}`);
                check(/^VH-\d+$/.test(first.key ?? ''), `${tag}: created ${first.key} assigned to ${first.agent}`);
                const issue = (await api(`/v1/issues/${first.key}`)).body;
                check(issue?.runs?.length === 1, `${tag}: server started run 1`, JSON.stringify(issue?.runs?.map((r) => r.status)));
                await page.waitForSelector('[data-testid="issue-runs"] .is-run[data-run-status="running"]', { timeout: 20_000 }).then(() => check(true, `${tag}: run 1 running (socket update)`), () => check(false, `${tag}: run 1 running`));
                await until(async () => (await page.locator('.is-detail .is-head').innerText()).includes(c.inProgress), 10_000);
                check((await page.locator('.is-detail .is-head').innerText()).includes(c.inProgress), `${tag}: todo → in_progress on run start`);

                // 3. comment delivered into the live run
                const box = page.locator('[data-testid="issue-comment-box"] textarea');
                await box.fill('Please add a unit test');
                check((await page.locator('[data-testid="issue-trigger-preview"]').innerText()).includes(c.queuedPreview), `${tag}: preview: queued into the running session`);
                await page.click('[data-testid="issue-comment-send"]');
                await page.waitForFunction((t) => document.querySelector('[data-testid="issue-timeline"]')?.textContent?.includes(t), c.delivered, { timeout: 15_000 })
                    .then(() => check(true, `${tag}: comment shows 已送达`), () => check(false, `${tag}: comment shows 已送达`));
                const runId = issue.runs[0].id;
                const sessionId = await until(() => sessions.get(runId), 10_000);
                check(await until(() => workerLog.some((w) => w.kind === 'message' && w.runId === runId), 10_000), `${tag}: worker got the comment as a message dispatch`);
                await shot('detail-running');

                // 4. agent: comment, in_review → 需要我决策 → 完成
                await post('/v1/issues/agent/comment', { sessionId, body: 'Working on it' });
                const rejected = await post('/v1/issues/agent/update', { sessionId, status: 'in_review' });
                check(rejected.status === 400 && rejected.body?.error === 'issue_comment_required', `${tag}: server refuses in_review without a summary`, `${rejected.status} ${rejected.body?.error}`);
                const up = await post('/v1/issues/agent/update', { sessionId, status: 'in_review', comment: 'Added the test; vitest green.' });
                check(up.status === 200, `${tag}: agent moved it to in_review`, `${up.status} ${JSON.stringify(up.body?.error ?? '')}`);
                await page.waitForSelector('[data-testid="issue-review-bar"]', { timeout: 15_000 });
                await shot('detail-review');
                await page.goto(`${APP}/board`);
                await dismissNotices(page);
                const band = page.locator('[data-testid="issue-decisions"]');
                await band.waitFor({ timeout: 20_000 });
                const row = band.locator(`[data-issue="${first.key}"]`);
                check((await row.count()) === 1, `${tag}: 需要我决策 lists ${first.key}`);
                await shot('board-decision');
                await row.locator('[data-testid="issue-accept"]').click();
                const closed = await until(async () => (await api(`/v1/issues/${first.key}`)).body?.issue?.status === 'done', 10_000);
                check(closed, `${tag}: 完成 → done on the server`);
                await until(async () => (await row.count()) === 0, 10_000);
                check((await row.count()) === 0, `${tag}: the decision left the band`);

                // 退回 with a note on a second issue
                await page.goto(`${APP}/issues`);
                await page.waitForSelector('[data-testid="issues-screen"]');
                await dismissNotices(page);
                const second = await create(`Return ${tag} ${randomBytes(2).toString('hex')}`);
                const run2 = (await api(`/v1/issues/${second.key}`)).body.runs[0].id;
                const sid2 = await until(() => sessions.get(run2), 15_000);
                await post('/v1/issues/agent/update', { sessionId: sid2, status: 'in_review', comment: 'Done, please check.' });
                await page.waitForSelector('[data-testid="issue-review-bar"]', { timeout: 15_000 });
                await page.locator('[data-testid="issue-review-bar"] .is-soft').click();
                const prompt = page.locator('.vh-dialog textarea, .vh-dialog input').last();
                await prompt.waitFor();
                await prompt.fill('Missing the migration note');
                await page.locator('.vh-dialog button', { hasText: c.reject }).last().click();
                const returned = await until(async () => {
                    const det = (await api(`/v1/issues/${second.key}`)).body;
                    return det?.issue?.status === 'todo' && det.comments.find((x) => x.kind === 'comment' && x.body.includes('Missing the migration note')) ? det : null;
                }, 10_000);
                check(!!returned, `${tag}: 退回 → todo with my note as a comment`);
                const note = returned?.comments.find((x) => x.body.includes('Missing the migration note'));
                check(note?.author?.kind === 'user' && (note?.routedRunIds?.length ?? 0) > 0, `${tag}: the note is mine and routed to the agent`, JSON.stringify(note?.routedRunIds));

                // ⌘K, /todos
                await page.keyboard.press('Control+k');
                await page.locator('.cp-search-input').fill(second.key);
                await page.waitForSelector('.cp-group--issues .cp-row', { timeout: 5000 }).then(() => check(true, `${tag}: ⌘K finds ${second.key}`), () => check(false, `${tag}: ⌘K finds ${second.key}`));
                await page.keyboard.press('Escape');
                await page.goto(`${APP}/todos`);
                await page.waitForURL(/\/issues\?assignee=none/, { timeout: 15_000 }).then(() => check(true, `${tag}: /todos → /issues?assignee=none`), () => check(false, `${tag}: /todos redirect`, page.url()));
                await page.goto(`${APP}/issues`);
                await page.waitForSelector('[data-testid="issues-list"] .is-row');
                await dismissNotices(page);
                await shot('list');
                if (d.coarse) { await page.goto(`${APP}/`); await page.locator('.sb .sb-header').waitFor({ timeout: 30_000 }); await dismissNotices(page); }
                const caps = await sidebarEntries(page);
                if (d.coarse) await shot('sidebar');
                // desktop rows: Issues, 运行中, …; phone: chips Issues · 项目 · 团队, then 「更多」 starting with 运行中
                const rest = caps.filter((k) => !['projects', 'teams'].includes(k));
                check(caps[0] === 'issues' && rest[1] === 'board' && !caps.includes('todos'), `${tag}: Issues leads, 运行中 next, no 待办`, caps.join(','));
                await context.close();
            }
        }
        if (workerLog.some((w) => w.kind === 'complete-failed')) check(false, 'every dispatch completed', JSON.stringify(workerLog.filter((w) => w.kind === 'complete-failed')));
    }
} finally {
    if (workerTimer) clearInterval(workerTimer);
    if (daemonStarted) spawnSync(process.execPath, [CLI, 'daemon', 'stop'], { env: cliEnv, encoding: 'utf8', timeout: 30_000 });
    spawnSync('tmux', ['-S', join(WORK, 'tmux.sock'), 'kill-server'], { timeout: 5_000 });
    await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
