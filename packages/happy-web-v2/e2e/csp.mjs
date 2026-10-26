#!/usr/bin/env node
/**
 * B-825: the production build under the server's Content-Security-Policy —
 * every main path renders and the browser reports no violation (enforced or
 * report-only). Not part of CI — run by hand against a local standalone
 * server that serves the BUILT web app (the shape of the production image),
 * plus Vite dev pointed at the same server (only to seed data: its modules
 * can be imported from the page):
 *
 *   pnpm -C packages/happy-web-v2 exec vite build
 *   DATA_DIR=<tmp> PORT=3299 pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts migrate
 *   DATA_DIR=<tmp> PORT=3299 SIGNUP_MODE=open HAPPY_STATIC_DIR=$PWD/packages/happy-web-v2/dist \
 *     pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts serve
 *   VH_SERVER_URL=http://127.0.0.1:3299 pnpm -C packages/happy-web-v2 exec vite --port 8825 --strictPort
 *   pnpm -C packages/happy-cli build   # the daemon for terminal + file preview
 *   node packages/happy-web-v2/e2e/csp.mjs --app http://127.0.0.1:3299 --dev http://127.0.0.1:8825 \
 *     --work <tmp dir> [--server-log <server stdout file>] [--out <dir>]
 *
 * Covers: landing, login, signup, home, settings, a session with Shiki code +
 * Mermaid, the anonymous share page, the CLI pairing page, a real web terminal
 * (xterm, daemon on a private tmux socket) and the HTML file preview frame
 * (its inline script must run). Exit code 1 on any failed check.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const APP = opt('app', 'http://127.0.0.1:3299');
const DEV = opt('dev', 'http://127.0.0.1:8825');
const WORK = opt('work', null);
const SERVER_LOG = opt('server-log', null);
const OUT = opt('out', null);
if (!WORK) {
    console.error('--work <empty tmp dir> is required (CLI home, tmux socket, test files)');
    process.exit(2);
}
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
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The daemon must not inherit this session's team scope or tmux server.
const cliEnv = { ...process.env, HAPPY_HOME_DIR: join(WORK, 'cli-home'), HAPPY_SERVER_URL: APP, HAPPY_WEBAPP_URL: APP, VH_TMUX_SOCKET: join(WORK, 'tmux.sock') };
for (const name of ['VH_TEAM_SCOPE_FILE', 'HAPPY_MANAGED', 'VH_TEAM_OPERATION_ID', 'HAPPY_SPAWNED_BY', 'VH_PEER_SESSION_ID', 'HAPPY_DAEMON_SUPERVISOR', 'HAPPY_SESSION_ID', 'TMUX', 'TMUX_PANE']) delete cliEnv[name];

const violations = [];
const browser = await chromium.launch({ executablePath: findChromium() });

/** Every CSP violation of every page/frame of this context, from the DOM event and the console. */
async function watchedContext(label) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US' });
    await context.exposeBinding('vhCspViolation', ({ frame }, v) => violations.push({ label, frame: frame.url(), ...v }));
    await context.addInitScript(() => {
        try { localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch { /* opaque frame */ }
        document.addEventListener('securitypolicyviolation', (e) => {
            window.vhCspViolation?.({ directive: e.effectiveDirective, blocked: e.blockedURI, disposition: e.disposition, sample: e.sample, source: e.sourceFile });
        });
    });
    context.on('console', (message) => {
        const text = message.text();
        if (/Content[- ]Security[- ]Policy|Refused to (load|execute|apply|connect|frame|create)|Permissions-Policy/i.test(text)) violations.push({ label, console: text.slice(0, 300) });
    });
    context.on('page', (page) => page.on('pageerror', (e) => console.log(`  [${label}] pageerror ${e.message}`)));
    return context;
}

function minimalPdf(text) {
    const objects = [
        '<</Type/Catalog/Pages 2 0 R>>',
        '<</Type/Pages/Kids[3 0 R]/Count 1>>',
        '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
        null,
        '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    ];
    const stream = `BT /F1 36 Tf 40 90 Td (${text}) Tj ET`;
    objects[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
    let body = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((object, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = body.length;
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
    return body;
}

const shot = async (page, name) => { if (OUT) await page.screenshot({ path: join(OUT, `${name}.png`) }); };
async function dismissOverlays(page) {
    for (const name of ['Got it', 'Not now', '知道了', '暂不']) {
        for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 1_000 }).catch(() => {});
    }
}

let daemonStarted = false;
try {
    const app = await watchedContext('app');
    const page = await app.newPage();

    step('anonymous: landing, login, signup');
    const landing = await page.goto(`${APP}/`);
    const csp = landing.headers()['content-security-policy'] ?? '';
    check(/script-src 'self' 'sha256-/.test(csp) && !/script-src[^;]*'unsafe-inline'/.test(csp), 'enforced CSP with hashed inline scripts, no unsafe-inline script', csp.slice(0, 120));
    check(!!landing.headers()['content-security-policy-report-only'], 'report-only stage-two policy present');
    check(landing.headers()['x-frame-options'] === 'SAMEORIGIN' && !!landing.headers()['permissions-policy'] && !!landing.headers()['referrer-policy'], 'other security headers present');
    await page.waitForLoadState('networkidle');
    check(await page.evaluate(() => !!document.documentElement.dataset.theme || document.querySelector('#root')?.children.length > 0), 'landing rendered (startup theme script ran)');
    await shot(page, '01-landing');
    await page.goto(`${APP}/login`);
    await page.locator('input[autocomplete="username"], .auth-method-toggle').first().waitFor({ timeout: 30_000 });

    const handle = `b825csp${randomBytes(3).toString('hex')}`;
    const pw = `pw-${randomBytes(6).toString('hex')}`;
    await page.goto(`${APP}/signup`);
    const toggle = page.locator('.auth-method-toggle');
    await page.locator('input[autocomplete="username"]').or(toggle).first().waitFor({ timeout: 30_000 });
    if (!(await page.locator('input[autocomplete="username"]').isVisible())) await toggle.click();
    await page.locator('input[autocomplete="username"]').fill(handle);
    const pws = page.locator('input[autocomplete="new-password"]');
    await pws.nth(0).fill(pw);
    await pws.nth(1).fill(pw);
    await page.locator('form.auth-password-form button[type="submit"]').click();
    await page.locator('.sb .sb-header').waitFor({ timeout: 30_000 });
    await dismissOverlays(page);
    await shot(page, '02-home');
    check(true, 'signed up, workspace shell rendered');

    step('settings');
    await page.goto(`${APP}/settings`);
    await page.waitForLoadState('networkidle');
    await shot(page, '03-settings');

    step('pair a CLI daemon (pairing page under CSP) and start it');
    const credentials = await page.evaluate(() => localStorage.getItem('auth_credentials'));
    const token = JSON.parse(credentials).token;
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
    const loginExit = await new Promise((r) => login.once('exit', r));
    check(loginExit === 0, 'CLI paired through the pairing page', `exit ${loginExit}`);
    const daemon = spawnSync(process.execPath, [CLI, 'daemon', 'start'], { env: cliEnv, encoding: 'utf8', timeout: 60_000 });
    daemonStarted = true;
    check(daemon.status === 0, 'daemon started', (daemon.stdout + daemon.stderr).trim().split('\n').slice(-1)[0]);
    let machineId = null;
    for (let i = 0; i < 100 && !machineId; i++) {
        const res = await fetch(`${APP}/v1/machines`, { headers: { Authorization: `Bearer ${token}` } });
        const list = res.ok ? await res.json() : [];
        machineId = (Array.isArray(list) ? list : list.machines ?? []).find((m) => m.active)?.id ?? null;
        if (!machineId) await sleep(300);
    }
    check(!!machineId, 'the machine is online');

    step('seed a session (code, mermaid, file link) and a share link via Vite dev');
    const htmlDir = join(WORK, 'files');
    mkdirSync(htmlDir, { recursive: true });
    const htmlPath = join(htmlDir, 'report.html');
    writeFileSync(htmlPath, '<!doctype html><html><body><h1 id="r">pending</h1><script>document.getElementById("r").textContent = "SCRIPT_RAN_" + (40 + 2);</script></body></html>');
    // A valid one-page PDF (objects + byte-exact xref).
    const pdfPath = join(htmlDir, 'doc.pdf');
    writeFileSync(pdfPath, minimalPdf('PDF OK'));
    const dev = await browser.newContext();
    await dev.addInitScript((creds) => { localStorage.setItem('auth_credentials', creds); localStorage.setItem('vh-pwa-install-never-v1', '1'); }, credentials);
    const devPage = await dev.newPage();
    await devPage.goto(`${DEV}/`);
    await devPage.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 60_000, polling: 300 });
    const seeded = await devPage.evaluate(async ({ machineId, htmlDir, htmlPath, pdfPath }) => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const { encodeBase64 } = await import('/src/encryption/base64.ts');
        for (let i = 0; i < 150 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
        // A per-session data key, like a daemon-spawned session (share links need one).
        const dataKey = crypto.getRandomValues(new Uint8Array(32));
        const sealedKey = await sync.encryption.encryptEncryptionKey(dataKey);
        const enc = await sync.encryption.openEncryption(dataKey);
        const [metadata] = await enc.encrypt([{ path: htmlDir, host: 'e2e', machineId, flavor: 'claude' }]);
        const created = await apiSocket.request('/v1/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState: null, dataEncryptionKey: encodeBase64(sealedKey, 'base64') }),
        });
        const sessionId = (await created.json()).session.id;
        let encryption = null;
        for (let i = 0; i < 100 && !(encryption = sync.encryption.getSessionEncryption(sessionId)); i++) {
            await sync.refreshSessions?.();
            await new Promise((r) => setTimeout(r, 200));
        }
        const text = [
            'CSP_E2E_MESSAGE highlighted code:',
            '```ts\nconst answer: number = 40 + 2;\nexport function hello(name: string) { return `hi ${name}`; }\n```',
            'and a diagram:',
            '```mermaid\ngraph TD\n  A[Web] --> B[Server]\n  B --> C[Daemon]\n```',
            `Open [the report](${htmlPath}) or [the pdf](${pdfPath}).`,
        ].join('\n\n');
        const record = { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'assistant', model: 'e2e', content: [{ type: 'text', text }] } } } };
        const content = await encryption.encryptRawRecord(record);
        const posted = await apiSocket.request(`/v3/sessions/${sessionId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ localId: crypto.randomUUID(), content }] }) });
        const link = await apiSocket.request(`/v1/sessions/${sessionId}/share-links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'live', expiresInDays: 7 }) });
        const linkBody = link.ok ? await link.json() : null;
        return { sessionId, posted: posted.status, link: link.status, linkId: linkBody?.link?.id, secret: linkBody?.secret };
    }, { machineId, htmlDir, htmlPath, pdfPath });
    await dev.close();
    check(seeded.posted === 200 && seeded.link === 200, 'session message and share link created', JSON.stringify({ posted: seeded.posted, link: seeded.link }));

    step('session: Shiki code + Mermaid');
    await page.goto(`${APP}/session/${seeded.sessionId}`);
    await page.getByText('CSP_E2E_MESSAGE').first().waitFor({ timeout: 30_000 });
    await dismissOverlays(page);
    await page.locator('pre.shiki').first().waitFor({ timeout: 30_000 }).then(() => check(true, 'code highlighted by Shiki'), () => check(false, 'code highlighted by Shiki'));
    await page.locator('.mmd-svg svg').first().waitFor({ timeout: 30_000 }).then(() => check(true, 'Mermaid diagram rendered as SVG'), () => check(false, 'Mermaid diagram rendered as SVG'));
    await shot(page, '04-session');

    step('HTML file preview frame');
    await page.locator('.md-link--file').first().click();
    const frame = page.frameLocator('iframe.fsb-html');
    await frame.locator('#r').filter({ hasText: 'SCRIPT_RAN_42' }).waitFor({ timeout: 30_000 })
        .then(() => check(true, 'the previewed page rendered and its inline script ran (own sandboxed CSP)'), () => check(false, 'the previewed page rendered and its inline script ran'));
    check(await page.locator('iframe.fsb-html').getAttribute('sandbox').then((s) => !s.includes('allow-same-origin')), 'preview frame stays sandboxed without allow-same-origin');
    await shot(page, '05-html-preview');
    await page.keyboard.press('Escape');

    step('PDF preview (blob: frame inherits the policy)');
    await page.locator('.md-link--file').nth(1).click();
    await page.locator('iframe.fsb-pdf').waitFor({ timeout: 30_000 })
        .then(() => check(true, 'PDF preview frame shown'), () => check(false, 'PDF preview frame shown'));
    // Chromium's viewer draws the (white) page; a plugin blocked by object-src leaves a flat grey shell
    // and fires no securitypolicyviolation — so count near-white pixels of the frame.
    const whiteShare = async () => {
        const png = (await page.locator('iframe.fsb-pdf').screenshot()).toString('base64');
        return page.evaluate(async (data) => {
            const img = new Image();
            img.src = `data:image/png;base64,${data}`;
            await img.decode();
            const canvas = new OffscreenCanvas(img.width, img.height);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const px = ctx.getImageData(0, 0, img.width, img.height).data;
            let white = 0;
            for (let i = 0; i < px.length; i += 4) if (px[i] > 240 && px[i + 1] > 240 && px[i + 2] > 240) white += 1;
            return white / (px.length / 4);
        }, png);
    };
    let pdfWhite = 0;
    for (let i = 0; i < 20 && pdfWhite < 0.02; i++) { await sleep(500); pdfWhite = await whiteShare(); }
    check(pdfWhite >= 0.02, 'the PDF viewer drew the document (plugin not blocked by object-src)', `white ${(pdfWhite * 100).toFixed(1)}%`);
    await sleep(1_000);
    await shot(page, '05b-pdf-preview');
    await page.keyboard.press('Escape');

    step('web terminal (xterm)');
    await page.goto(`${APP}/terminal`);
    const online = page.locator('.vh-itemgroup').first().locator('button.vh-item.is-interactive');
    await online.first().click({ timeout: 30_000 });
    await page.locator('.xterm-screen').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('.xterm-screen').click();
    await page.waitForFunction(() => (document.querySelector('.xterm-rows')?.textContent ?? '').trim().length > 0, null, { timeout: 30_000 });
    const marker = `CSP_TERM_${randomBytes(3).toString('hex')}`;
    await page.keyboard.type(`echo ${marker}_$((40+2))`, { delay: 15 });
    await page.keyboard.press('Enter');
    await page.waitForFunction((m) => (document.querySelector('.xterm-rows')?.textContent ?? '').includes(`${m}_42`), marker, { timeout: 30_000 })
        .then(() => check(true, 'terminal ran a command and rendered its output'), () => check(false, 'terminal ran a command and rendered its output'));
    await shot(page, '06-terminal');
    await page.keyboard.type('exit', { delay: 15 });
    await page.keyboard.press('Enter');

    step('anonymous share page');
    const share = await watchedContext('share');
    const sharePage = await share.newPage();
    if (process.env.VH_E2E_DEBUG) console.log('  share path', `/s/${seeded.linkId}#${seeded.secret}`);
    const shareRes = await sharePage.goto(`${APP}/s/${seeded.linkId}#${seeded.secret}`);
    check(shareRes.headers()['referrer-policy'] === 'no-referrer' && !!shareRes.headers()['content-security-policy'], 'share page: no-referrer kept, CSP present');
    await sharePage.getByText('CSP_E2E_MESSAGE').first().waitFor({ timeout: 30_000 })
        .then(() => check(true, 'share page rendered the conversation'), () => check(false, 'share page rendered the conversation'));
    await sharePage.locator('pre.shiki').first().waitFor({ timeout: 30_000 }).then(() => check(true, 'share page: code highlighted'), () => check(false, 'share page: code highlighted'));
    await sharePage.locator('.mmd-svg svg').first().waitFor({ timeout: 30_000 }).then(() => check(true, 'share page: Mermaid rendered'), () => check(false, 'share page: Mermaid rendered'));
    await shot(sharePage, '07-share');
    await share.close();

    await sleep(1_000);
    await app.close();

    step('violations');
    check(violations.length === 0, 'no CSP violation (enforced or report-only) in any page or frame', violations.length ? JSON.stringify(violations.slice(0, 5)) : '');
    if (SERVER_LOG && existsSync(SERVER_LOG)) {
        const reports = readFileSync(SERVER_LOG, 'utf8').split('\n').filter((line) => line.includes('CSP violation'));
        check(reports.length === 0, 'the server received no CSP report', reports.slice(0, 3).join(' | '));
    }
} catch (error) {
    console.log('  ✗ aborted:', error instanceof Error ? error.message : error);
    failures += 1;
} finally {
    await browser.close();
    if (daemonStarted) spawnSync(process.execPath, [CLI, 'daemon', 'stop'], { env: cliEnv, encoding: 'utf8', timeout: 30_000 });
    spawnSync('tmux', ['-S', join(WORK, 'tmux.sock'), 'kill-server'], { encoding: 'utf8' });
}
console.log(failures === 0 ? 'csp e2e: all checks passed' : `csp e2e: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
