#!/usr/bin/env node
/**
 * File download (B-562) end to end: every download button must produce a real
 * browser download (Playwright `download` event) with the file's exact bytes —
 * desktop and phone, md / png / pdf / zip, small / medium / large. Not part of
 * CI — run by hand against a local standalone server serving the BUILT web app
 * (the production shape) plus a real daemon, set up exactly like `csp.mjs`:
 *
 *   pnpm -C packages/happy-web-v2 exec vite build
 *   pnpm -C packages/happy-cli build
 *   (standalone server on --app with HAPPY_STATIC_DIR=…/happy-web-v2/dist, Vite dev on --dev; see csp.mjs)
 *   node packages/happy-web-v2/e2e/file-download.mjs --app http://127.0.0.1:3299 --dev http://127.0.0.1:8825 \
 *     --work <tmp dir> [--out <dir>] [--sizes small,medium,large]
 *
 * Paths covered, per device:
 *  - head ⬇ of the file viewer docked in the session's side panel (opened from a file link),
 *  - the large "Download" block of a file that cannot be previewed (zip),
 *  - the bar shown for an `open_preview(download: true)` push (a pushed request
 *    without a session context → the app-level FsPreviewOverlay),
 *  - "Not saved? Save" — the real `<a download>` fallback rendered after the bytes arrive.
 * Exit code 1 on any failed check.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, devices } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const APP = opt('app', 'http://127.0.0.1:3299');
const DEV = opt('dev', 'http://127.0.0.1:8825');
const WORK = opt('work', null);
const OUT = opt('out', null);
const SIZES = opt('sizes', 'small,medium,large').split(',');
if (!WORK) {
    console.error('--work <empty tmp dir> is required (CLI home, test files)');
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
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

const cliEnv = { ...process.env, HAPPY_HOME_DIR: join(WORK, 'cli-home'), HAPPY_SERVER_URL: APP, HAPPY_WEBAPP_URL: APP, VH_TMUX_SOCKET: join(WORK, 'tmux.sock') };
for (const name of Object.keys(cliEnv)) {
    if (/^(VH_TEAM_|CLAUDE_CODE_)/.test(name) || ['HAPPY_MANAGED', 'HAPPY_SPAWNED_BY', 'VH_PEER_SESSION_ID', 'HAPPY_DAEMON_SUPERVISOR', 'HAPPY_SESSION_ID', 'TMUX', 'TMUX_PANE', 'CLAUDE_AGENT_SDK_VERSION'].includes(name)) delete cliEnv[name];
}
cliEnv.VH_TMUX_SOCKET = join(WORK, 'tmux.sock');

// ---- test files: md / png / pdf / zip × small / medium / large ----
const SIZE_BYTES = { small: 2 * 1024, medium: 3 * 1024 * 1024, large: 24 * 1024 * 1024 };
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
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
    return Buffer.from(body, 'latin1');
}
/** Valid head + filler to the wanted size (trailing bytes after IEND / %%EOF still decode). */
function fileBytes(type, size) {
    if (type === 'md') {
        const line = '- download e2e line, some **markdown** text 0123456789\n';
        return Buffer.from(`# Download e2e\n\n${line.repeat(Math.ceil(size / line.length))}`.slice(0, size));
    }
    const head = type === 'png' ? PNG_1PX : type === 'pdf' ? minimalPdf('PDF OK') : Buffer.from('PK\u0003\u0004', 'latin1');
    return Buffer.concat([head, randomBytes(Math.max(0, size - head.length))]);
}
const filesDir = join(WORK, 'files');
mkdirSync(filesDir, { recursive: true });
const FILES = [];
for (const size of SIZES) {
    for (const type of ['md', 'png', 'pdf', 'zip']) {
        const bytes = fileBytes(type, SIZE_BYTES[size]);
        const path = join(filesDir, `dl-${size}.${type}`);
        writeFileSync(path, bytes);
        FILES.push({ type, size, path, name: `dl-${size}.${type}`, bytes: bytes.length, sha: sha(bytes) });
    }
}

const browser = await chromium.launch({ executablePath: findChromium() });
let daemonStarted = false;

async function dismissOverlays(page) {
    await page.locator('.wn-card').waitFor({ timeout: 4_000 }).catch(() => {});
    for (const name of ['Got it', 'Not now', '知道了', '暂不']) {
        for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 1_000 }).catch(() => {});
    }
}

/** Run `act`, require a browser download of `file` (exact bytes). */
async function expectDownload(page, file, label, act) {
    const wait = page.waitForEvent('download', { timeout: 90_000 });
    const t0 = Date.now();
    try {
        await act();
        const download = await wait;
        const saved = await download.path();
        const got = readFileSync(saved);
        const ok = download.suggestedFilename() === file.name && got.length === file.bytes && sha(got) === file.sha;
        check(ok, `${label}: ${file.name} downloaded`, `${download.suggestedFilename()} ${got.length}B ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return ok;
    } catch (e) {
        wait.catch(() => {});
        const err = await page.locator('.fdl-error, .fsb-download-status').allTextContents().catch(() => []);
        check(false, `${label}: ${file.name} downloaded`, `${String(e.message).split('\n')[0]}${err.length ? ` | ui: ${err.join(' / ')}` : ''}`);
        if (OUT) await page.screenshot({ path: join(OUT, `fail-${label.replace(/\W+/g, '_')}-${file.name}.png`) }).catch(() => {});
        return false;
    }
}

try {
    step('sign up');
    const setup = await browser.newContext({ locale: 'en-US' });
    await setup.addInitScript(() => { try { localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch { /* */ } });
    const page0 = await setup.newPage();
    const handle = `dl${randomBytes(3).toString('hex')}`;
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

    step('pair and start a real daemon');
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
    await page0.goto(connectUrl);
    await page0.getByRole('button', { name: /approve|connect|批准|连接/i }).first().click();
    check((await new Promise((r) => login.once('exit', r))) === 0, 'CLI paired');
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
    await setup.close();

    step('seed a session whose message links every test file (via Vite dev)');
    const dev = await browser.newContext();
    await dev.addInitScript((creds) => { localStorage.setItem('auth_credentials', creds); }, credentials);
    const devPage = await dev.newPage();
    await devPage.goto(`${DEV}/`);
    await devPage.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 60_000, polling: 300 });
    const sessionId = await devPage.evaluate(async ({ machineId, filesDir, paths }) => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const { encodeBase64 } = await import('/src/encryption/base64.ts');
        for (let i = 0; i < 150 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
        const dataKey = crypto.getRandomValues(new Uint8Array(32));
        const sealedKey = await sync.encryption.encryptEncryptionKey(dataKey);
        const enc = await sync.encryption.openEncryption(dataKey);
        const [metadata] = await enc.encrypt([{ path: filesDir, host: 'e2e', machineId, flavor: 'claude' }]);
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
        const text = ['DL_E2E_MESSAGE files:', ...paths.map((p) => `- [${p.split('/').pop()}](${p})`)].join('\n');
        const record = { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'assistant', model: 'e2e', content: [{ type: 'text', text }] } } } };
        // An `open_preview(download: true)` call per small file → the chat's 「发送文件」 tool rows.
        const toolRecords = [];
        for (const p of paths.filter((p) => p.includes('/dl-small.'))) {
            const id = `toolu_${crypto.randomUUID().replace(/-/g, '')}`;
            toolRecords.push({ role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'assistant', model: 'e2e', content: [{ type: 'tool_use', id, name: 'mcp__happy__open_preview', input: { path: p, download: true } }] } } } });
            toolRecords.push({ role: 'agent', content: { type: 'output', data: { type: 'user', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Sent to the web app.' }] } } } });
        }
        const messages = [];
        for (const r of [record, ...toolRecords]) messages.push({ localId: crypto.randomUUID(), content: await encryption.encryptRawRecord(r) });
        await apiSocket.request(`/v3/sessions/${sessionId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }) });
        return sessionId;
    }, { machineId, filesDir, paths: FILES.map((f) => f.path) });
    await dev.close();
    check(!!sessionId, 'session seeded');

    const DEVICES = [
        { label: 'desktop', options: { viewport: { width: 1280, height: 860 } } },
        { label: 'phone', options: { ...devices['iPhone 13'] } },
    ];
    for (const device of DEVICES) {
        step(`${device.label}: open the session`);
        const context = await browser.newContext({ ...device.options, locale: 'en-US', acceptDownloads: true });
        await context.addInitScript((creds) => {
            try { localStorage.setItem('auth_credentials', creds); localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch { /* */ }
        }, credentials);
        const page = await context.newPage();
        page.on('pageerror', (e) => console.log(`  [${device.label}] pageerror ${e.message}`));
        page.on('console', (m) => { if (m.type() === 'error') console.log(`  [${device.label}] console.error ${m.text().slice(0, 200)}`); });
        await page.goto(`${APP}/session/${sessionId}`);
        await page.getByText('DL_E2E_MESSAGE').first().waitFor({ timeout: 30_000 });
        await dismissOverlays(page);
        console.log(`  pointer coarse: ${await page.evaluate(() => matchMedia('(pointer: coarse)').matches)}`);

        for (const file of FILES) {
            // 1) viewer head ⬇ (preview opened from the file link)
            await page.goto(`${APP}/session/${sessionId}`);
            await page.getByText('DL_E2E_MESSAGE').first().waitFor({ timeout: 30_000 });
            await page.locator('.md-link--file', { hasText: file.name }).first().click();
            const head = page.getByRole('button', { name: 'Download file' }).first();
            await head.waitFor({ timeout: 30_000 }).catch(() => {});
            await expectDownload(page, file, `${device.label} viewer ⬇`, () => head.click());
            // 2) the real <a download> fallback rendered after the bytes arrived
            const save = page.locator('a.fdl-save').first();
            if (await save.isVisible().catch(() => false)) {
                await expectDownload(page, file, `${device.label} save link`, () => save.click());
            } else {
                check(false, `${device.label} save link: ${file.name} rendered after the download`);
            }
            if (OUT && file.size === 'small') await page.screenshot({ path: join(OUT, `${device.label}-viewer-${file.name}.png`) });
        }

        // 3) the chat's tool row for an `open_preview(download: true)` call: inline 「下载」
        await page.goto(`${APP}/session/${sessionId}`);
        await page.getByText('DL_E2E_MESSAGE').first().waitFor({ timeout: 30_000 });
        const rows = page.locator('.tg-preview-row');
        if (!(await rows.first().isVisible().catch(() => false))) {
            // A finished turn folds its tools into the activity summary; open it.
            await page.getByText(/\d+ tool calls?/).first().click().catch(() => {});
        }
        await rows.first().waitFor({ timeout: 15_000 }).catch(() => {});
        check(await rows.count() > 0, `${device.label} chat tool rows for open_preview(download) rendered`, `${await rows.count()}`);
        for (const file of FILES.filter((f) => f.size === 'small')) {
            const row = rows.filter({ hasText: file.name }).first();
            await expectDownload(page, file, `${device.label} tool row inline`, () => row.locator('.fdl--inline button.fdl-btn').click());
            const save = row.locator('a.fdl-save');
            if (await save.isVisible().catch(() => false)) await expectDownload(page, file, `${device.label} tool row save link`, () => save.click());
            else check(false, `${device.label} tool row save link: ${file.name} rendered after the download`);
        }
        if (OUT) await page.screenshot({ path: join(OUT, `${device.label}-tool-rows.png`) });

        // 3b) the composer's 「Previews」 history drawer: inline 「下载」 per entry
        await page.goto(`${APP}/session/${sessionId}`);
        await page.getByText('DL_E2E_MESSAGE').first().waitFor({ timeout: 30_000 });
        await page.getByRole('button', { name: /^Previews\b/ }).first().click().catch(() => {});
        for (const file of FILES.filter((f) => f.size === 'small').slice(0, 2)) {
            const btn = page.locator(`[title="Download ${file.name}"]`).first();
            await expectDownload(page, file, `${device.label} previews drawer`, () => btn.click({ timeout: 15_000 }));
        }
        await page.keyboard.press('Escape').catch(() => {});

        // 3c) a session's push (`open_preview(download: true)` with its sessionId), on that session's page:
        // docks into the side panel on desktop (B-539), the overlay on a phone.
        for (const file of FILES) {
            await page.goto(`${APP}/session/${sessionId}`);
            await page.getByText('DL_E2E_MESSAGE').first().waitFor({ timeout: 30_000 });
            await sleep(300);
            const bar = page.locator('.fdl--bar button.fdl-btn').first();
            await expectDownload(page, file, `${device.label} session push`, async () => {
                await page.evaluate(({ sessionId, machineId, path }) => {
                    window.dispatchEvent(new CustomEvent('vh:fs-preview-open', { detail: { sessionId, machineId, path, mode: 'file', fromPush: true, intent: 'download' } }));
                }, { sessionId, machineId, path: file.path });
                await bar.waitFor({ timeout: 30_000 });
                if (device.label === 'phone') await bar.click();
            });
            if (OUT && file.size === 'small' && file.type === 'md') await page.screenshot({ path: join(OUT, `${device.label}-session-push.png`) });
        }

        // 4) open_preview(download: true) push without a session context → the overlay's bar
        for (const file of FILES) {
            await page.goto(`${APP}/`);
            await page.locator('.sb .sb-header, .vh-mobile-home, body').first().waitFor({ timeout: 30_000 });
            await sleep(500);
            const bar = page.locator('.fdl--bar button.fdl-btn').first();
            // Desktop auto-starts once the preview read finished; the phone needs the click.
            await expectDownload(page, file, `${device.label} pushed bar`, async () => {
                await page.evaluate(({ machineId, path }) => {
                    window.dispatchEvent(new CustomEvent('vh:fs-preview-open', { detail: { machineId, path, mode: 'file', fromPush: true, intent: 'download' } }));
                }, { machineId, path: file.path });
                await bar.waitFor({ timeout: 30_000 });
                if (device.label === 'phone') await bar.click();
            });
            if (OUT && file.size === 'small') await page.screenshot({ path: join(OUT, `${device.label}-pushed-${file.name}.png`) });
        }
        await context.close();
    }
} finally {
    if (daemonStarted) spawnSync(process.execPath, [CLI, 'daemon', 'stop'], { env: cliEnv, timeout: 30_000 });
    await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
