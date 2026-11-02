#!/usr/bin/env node
/**
 * B-868: web terminals in projects, end to end on the real stack — a standalone
 * server serving the BUILT web app, a real daemon (this branch's CLI) on a
 * private tmux socket, and Chromium. Not part of CI; set up like `csp.mjs`:
 *
 *   pnpm -C packages/happy-web-v2 exec vite build
 *   pnpm -C packages/happy-cli build
 *   DATA_DIR=<tmp> PORT=3868 tsx --env-file=.env.dev ./sources/standalone.ts migrate   (in packages/happy-server)
 *   DATA_DIR=<tmp> PORT=3868 SIGNUP_MODE=open HAPPY_STATIC_DIR=$PWD/packages/happy-web-v2/dist tsx --env-file=.env.dev ./sources/standalone.ts serve
 *   node packages/happy-web-v2/e2e/terminal-projects.mjs --app http://127.0.0.1:3868 --work <empty tmp dir> [--out <dir>]
 *
 * Per device (desktop, phone with pointer: coarse) × language (zh-CN, en-US):
 *   1. 「新建终端」 on the project page creates a terminal that belongs to the
 *      project (tmux `@vh_project` = the project id) and is listed there;
 *   2. a plain terminal is NOT in the project, nor under the ⌘K project chip;
 *   3. its row ⋯ 「移到项目…」 moves it: it sits under the project's sidebar
 *      group, on the project page and under the ⌘K project chip;
 *   4. a reload keeps all of that;
 *   5. 「从「X」移出」 (row menu) and the project page's leave button take them
 *      out again — gone from the page, the group and the chip; tmux option unset;
 *   6. nothing is ever typed into a terminal (pane text unchanged by the moves).
 * Exit code 1 on any failed check.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const APP = opt('app', 'http://127.0.0.1:3868');
const WORK = opt('work', null);
const OUT = opt('out', null);
const DEVICES = {
    desktop: { width: 1440, height: 900, dpr: 1, coarse: false },
    phone: { width: 390, height: 844, dpr: 3, coarse: true },
};
const LANGS = opt('langs', 'zh-CN,en-US').split(',');
const ONLY_DEVICES = opt('devices', 'desktop,phone').split(',');
if (!WORK) {
    console.error('--work <empty tmp dir> is required (CLI home, tmux socket)');
    process.exit(2);
}
mkdirSync(WORK, { recursive: true });
if (OUT) mkdirSync(OUT, { recursive: true });
const CLI = resolve(import.meta.dirname, '../../happy-cli/dist/index.mjs');
const SOCK = join(WORK, 'tmux.sock');
const PROJECT_NAME = 'B868 Proj';
const COPY = {
    'zh-CN': { newTerminal: '新建终端', move: '移到项目…', moveBtn: '移动', leave: `从「${PROJECT_NAME}」移出`, removeFromProject: '从项目移出', search: '搜索', more: '更多操作' },
    'en-US': { newTerminal: 'New terminal', move: 'Move to project…', moveBtn: 'Move', leave: `Remove from "${PROJECT_NAME}"`, removeFromProject: 'Remove from project', search: 'Search', more: 'More actions' },
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

const cliEnv = { ...process.env, HAPPY_HOME_DIR: join(WORK, 'cli-home'), HAPPY_SERVER_URL: APP, HAPPY_WEBAPP_URL: APP };
for (const name of Object.keys(cliEnv)) {
    if (/^(VH_|CLAUDE_CODE_)/.test(name) || ['HAPPY_MANAGED', 'HAPPY_SPAWNED_BY', 'HAPPY_DAEMON_SUPERVISOR', 'HAPPY_SESSION_ID', 'HAPPY_MCP_URL', 'TMUX', 'TMUX_PANE', 'CLAUDE_AGENT_SDK_VERSION'].includes(name)) delete cliEnv[name];
}
cliEnv.VH_TMUX_SOCKET = SOCK;
const tmux = (...a) => spawnSync('tmux', ['-S', SOCK, ...a], { encoding: 'utf8', timeout: 5_000 });
const tmuxProject = (tid) => tmux('show-options', '-v', '-t', `=vh-${tid}:`, '@vh_project').stdout.trim();
const paneText = (tid) => tmux('capture-pane', '-p', '-t', `=vh-${tid}:`).stdout.trim();
/** A unique title so rows / palette items can be found by text (test setup, not the feature). */
function titleTerminal(tid, title) {
    tmux('set-option', '-t', `=vh-${tid}:`, '@vh_title', title);
    tmux('set-option', '-t', `=vh-${tid}:`, '@vh_title_manual', '1');
}

const browser = await chromium.launch({ executablePath: findChromium() });
let daemonStarted = false;
try {
    step('sign up, pair and start a real daemon');
    const setup = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
    await setup.addInitScript(() => { try { localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch { /* */ } });
    const page0 = await setup.newPage();
    const handle = `tp${randomBytes(3).toString('hex')}`;
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

    const login = spawn(process.execPath, [CLI, 'auth', 'login'], { env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let loginOut = '';
    login.stdout.on('data', (d) => { loginOut += d; });
    login.stderr.on('data', (d) => { loginOut += d; });
    const connectUrl = await until(() => /(https?:\/\/\S+\/terminal\/connect#key=\S+)/.exec(loginOut)?.[1], 20_000, 200);
    if (!connectUrl) throw new Error(`no pairing URL from auth login: ${loginOut.slice(0, 300)}`);
    await page0.goto(connectUrl);
    await page0.getByRole('button', { name: /approve|connect|批准|连接/i }).first().click();
    check((await new Promise((r) => login.once('exit', r))) === 0, 'CLI paired');
    const daemon = spawnSync(process.execPath, [CLI, 'daemon', 'start'], { env: cliEnv, encoding: 'utf8', timeout: 60_000 });
    daemonStarted = true;
    check(daemon.status === 0, 'daemon started', (daemon.stdout + daemon.stderr).trim().split('\n').slice(-1)[0]);
    const machineId = await until(async () => {
        const { body } = await api('/v1/machines');
        return (Array.isArray(body) ? body : body?.machines ?? []).find((m) => m.active)?.id ?? null;
    }, 30_000, 300);
    check(!!machineId, 'the machine is online');
    await setup.close();

    step('create the project (primary folder on the daemon machine)');
    const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ name: PROJECT_NAME, folders: [{ machineId, path: WORK, primary: true }] }) });
    const projectId = created.body?.project?.id;
    check(created.status === 200 && !!projectId, 'project created', `${created.status}`);

    for (const [deviceName, d] of Object.entries(DEVICES).filter(([n]) => ONLY_DEVICES.includes(n))) {
        for (const lang of LANGS) {
            const c = COPY[lang];
            const tag = `${deviceName}-${lang}`;
            console.log(`\n${deviceName} · ${lang}`);
            const context = await browser.newContext({
                viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.dpr,
                hasTouch: d.coarse, isMobile: d.coarse, locale: lang, serviceWorkers: 'block',
            });
            await context.addInitScript((creds) => {
                try {
                    localStorage.setItem('auth_credentials', creds);
                    localStorage.setItem('vh-pwa-install-never-v1', '1');
                } catch { /* */ }
            }, credentials);
            const page = await context.newPage();
            page.on('pageerror', (e) => console.log('  pageerror', e.message));
            const shot = async (name) => { if (OUT) await page.screenshot({ path: join(OUT, `${tag}-${name}.png`) }); };
            const dismiss = async () => {
                await sleep(600);
                for (const name of ['Got it', 'Not now', '知道了', '暂不', '以后再说', 'Later']) {
                    for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 800 }).catch(() => {});
                }
            };
            const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
            check(coarse === d.coarse, `pointer: coarse = ${d.coarse}`);
            const projectPage = `${APP}/projects/${encodeURIComponent(projectId)}`;
            const terminalsSection = page.locator('[data-testid="project-terminals"]');

            // 1. 新建终端 on the project page → the terminal belongs to the project.
            await page.goto(projectPage);
            await terminalsSection.waitFor({ timeout: 30_000 });
            await dismiss();
            await terminalsSection.getByRole('button', { name: c.newTerminal }).click();
            await page.waitForURL(/\/terminal\//, { timeout: 15_000 });
            const tidA = new URL(page.url()).searchParams.get('tid');
            check(!!(await until(() => tmuxProject(tidA) === projectId, 20_000)), '1. created from the project page → tmux @vh_project = project', tmuxProject(tidA) || '(unset)');
            const titleA = `B868-A-${tag}`;
            titleTerminal(tidA, titleA);

            // 2. a plain terminal (the app's own fresh-create URL) is not in it.
            const tidB = randomBytes(6).toString('hex');
            await page.goto(`${APP}/terminal/${machineId}?tid=${tidB}&fresh=1`);
            check(!!(await until(() => tmux('has-session', '-t', `=vh-${tidB}:`).status === 0, 20_000)), '2. plain terminal created');
            check(tmuxProject(tidB) === '', '2. plain terminal has no project');
            const titleB = `B868-B-${tag}`;
            titleTerminal(tidB, titleB);
            await sleep(800);
            const paneB = paneText(tidB);

            await page.goto(projectPage);
            await terminalsSection.waitFor({ timeout: 30_000 });
            check(await until(() => terminalsSection.getByText(titleA).isVisible(), 15_000), '1. project page lists the terminal created there');
            check((await terminalsSection.getByText(titleB).count()) === 0, '2. project page does not list the plain terminal');
            await shot('project-page-one');

            const openPalette = async () => {
                if (d.coarse) await page.goto(`${APP}/`);
                if (!d.coarse) await page.keyboard.press('Control+k');
                else await page.locator(`.sb-icon-btn[aria-label="${c.search}"]`).first().click();
                await page.locator('.cp-panel').waitFor({ timeout: 8_000 });
            };
            const paletteWithProject = async () => {
                await openPalette();
                await page.locator('.cp-filters .cp-filter').nth(1).click();
                await page.getByRole('option', { name: PROJECT_NAME }).click();
                await sleep(400);
            };
            const closePalette = async () => {
                for (let i = 0; i < 3 && await page.locator('.cp-panel').isVisible(); i++) { await page.keyboard.press('Escape'); await sleep(200); }
            };
            const paletteHas = async (title) => (await page.locator('.cp-item-title', { hasText: title }).count()) > 0;

            await paletteWithProject();
            check(await until(() => paletteHas(titleA), 5_000), '2. ⌘K project chip finds the project terminal');
            check(!(await paletteHas(titleB)), '2. ⌘K project chip leaves the plain terminal out');
            await shot('palette-before');
            await closePalette();

            // 3. row ⋯ → 移到项目… → the project.
            await page.goto(`${APP}/`);
            const rowB = page.locator(`[data-dragkey="t:${tidB}"]`);
            await rowB.waitFor({ timeout: 20_000 });
            await dismiss();
            const groupOf = (row) => row.evaluate((el) => el.closest('.sb-section')?.classList.contains('sb-section--project') ? el.closest('.sb-section').querySelector('.sb-tree-project-name')?.textContent : null);
            check((await groupOf(rowB)) === null, '3. before: the plain terminal is not under a project group');
            check((await groupOf(page.locator(`[data-dragkey="t:${tidA}"]`))) === PROJECT_NAME, '1. sidebar files the project terminal under its project group');
            const openRowMenu = async (row) => {
                await row.hover().catch(() => {});
                await row.locator('.sb-row-menu').click({ force: true });
            };
            await openRowMenu(rowB);
            const moveItem = page.getByRole('menuitem', { name: c.move });
            await moveItem.waitFor({ timeout: 5_000 });
            if (d.coarse) {
                const box = await moveItem.boundingBox();
                check(!!box && box.height >= 43.5, 'phone: 移到项目 menu row ≥44px', JSON.stringify(box));
            }
            await shot('row-menu');
            await moveItem.click();
            await page.locator('#mtp-project').click();
            await page.getByRole('option', { name: PROJECT_NAME }).click();
            await shot('move-modal');
            await page.getByRole('dialog').getByRole('button', { name: c.moveBtn, exact: true }).click();
            check(!!(await until(() => tmuxProject(tidB) === projectId, 15_000)), '3. moved → tmux @vh_project = project', tmuxProject(tidB) || '(unset)');
            check(await until(async () => (await groupOf(rowB)) === PROJECT_NAME, 10_000), '3. sidebar: the terminal now sits under the project group');
            await shot('sidebar-after-move');

            // 4. reload keeps it (state lives on the machine and comes back in the push).
            await page.reload();
            await rowB.waitFor({ timeout: 30_000 });
            check(await until(async () => (await groupOf(rowB)) === PROJECT_NAME, 15_000), '4. after reload: still under the project group');
            await page.goto(projectPage);
            await terminalsSection.waitFor({ timeout: 30_000 });
            check(await until(() => terminalsSection.getByText(titleB).isVisible(), 15_000), '4. after reload: project page lists the moved terminal');
            await shot('project-page-both');
            await paletteWithProject();
            check(await until(() => paletteHas(titleB), 5_000), '3. ⌘K project chip now finds the moved terminal');
            await shot('palette-after');
            await closePalette();

            // 5a. row menu 从「X」移出.
            await page.goto(`${APP}/`);
            await rowB.waitFor({ timeout: 20_000 });
            await openRowMenu(rowB);
            await page.getByRole('menuitem', { name: c.leave }).click();
            check(!!(await until(() => tmuxProject(tidB) === '', 15_000)), '5. 移出 (row menu) → tmux option unset');
            check(await until(async () => (await groupOf(rowB)) === null, 10_000), '5. sidebar: back under 不在项目中');
            // 5b. project page leave button.
            await page.goto(projectPage);
            await terminalsSection.waitFor({ timeout: 30_000 });
            const leaveA = terminalsSection.getByRole('button', { name: `${c.removeFromProject}: ${titleA}` });
            await leaveA.waitFor({ timeout: 10_000 });
            if (d.coarse) {
                const box = await leaveA.boundingBox();
                check(!!box && box.height >= 31.5, 'phone: leave button is a touch-sized icon button', JSON.stringify(box));
            }
            await leaveA.click();
            check(!!(await until(() => tmuxProject(tidA) === '', 15_000)), '5. 移出 (project page) → tmux option unset');
            check(await until(async () => (await terminalsSection.getByText(titleA).count()) === 0 && (await terminalsSection.getByText(titleB).count()) === 0, 10_000), '5. project page no longer lists either terminal');
            await page.reload();
            await terminalsSection.waitFor({ timeout: 30_000 });
            await sleep(1500);
            check((await terminalsSection.getByText(titleA).count()) === 0 && (await terminalsSection.getByText(titleB).count()) === 0, '5. after reload: still gone');
            await shot('project-page-empty');
            await paletteWithProject();
            await sleep(500);
            check(!(await paletteHas(titleA)) && !(await paletteHas(titleB)), '5. ⌘K project chip no longer finds them');
            await closePalette();

            // 6. ownership only — nothing typed into the terminal.
            check(paneText(tidB) === paneB, '6. pane text unchanged by move / remove (nothing injected)');

            // tidy: close both terminals for the next round.
            tmux('kill-session', '-t', `=vh-${tidA}:`);
            tmux('kill-session', '-t', `=vh-${tidB}:`);
            await context.close();
        }
    }
} catch (e) {
    check(false, 'run', String(e?.stack ?? e).split('\n').slice(0, 3).join(' | '));
} finally {
    if (daemonStarted) spawnSync(process.execPath, [CLI, 'daemon', 'stop'], { env: cliEnv, encoding: 'utf8', timeout: 30_000 });
    tmux('kill-server');
    await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
