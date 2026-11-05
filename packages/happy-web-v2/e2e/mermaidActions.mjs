#!/usr/bin/env node
/**
 * B-890: a rendered mermaid diagram can be expanded (pan / zoom / reset / Esc),
 * its source copied and its SVG / PNG downloaded — in a session and on the
 * anonymous share page, desktop (light, 中文) and phone (coarse touch, dark,
 * English), on the BUILT app under the server's CSP. Not part of CI; run by hand
 * like csp.mjs, against a local standalone server (never production):
 *
 *   pnpm -C packages/happy-web-v2 exec vite build
 *   DATA_DIR=<tmp> PORT=3890 pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts migrate
 *   DATA_DIR=<tmp> PORT=3890 SIGNUP_MODE=open HAPPY_STATIC_DIR=$PWD/packages/happy-web-v2/dist \
 *     pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts serve
 *   VH_SERVER_URL=http://127.0.0.1:3890 pnpm -C packages/happy-web-v2 exec vite --port 8890 --strictPort
 *   node packages/happy-web-v2/e2e/mermaidActions.mjs --app http://127.0.0.1:3890 --dev http://127.0.0.1:8890 --out <dir>
 *
 * The dev server is only used to seed the session (its modules can be imported).
 * Exit code 1 on any failed check.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const APP = opt('app', 'http://127.0.0.1:3890');
const DEV = opt('dev', 'http://127.0.0.1:8890');
const OUT = opt('out', null);
if (!OUT) { console.error('--out <dir> is required (downloads + screenshots)'); process.exit(2); }
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
function check(ok, what, detail = '') {
    console.log(`${ok ? '  ✓' : '  ✗'} ${what}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MERMAID = 'graph TD\n  A[Web] --> B[Server]\n  B --> C{Daemon online?}\n  C -->|yes| D[Run agent]\n  C -->|no| E[Queue]';
const BROKEN = 'graph TD\n  this is (( not mermaid';
const violations = [];
const pageErrors = [];
const prodRequests = [];
const browser = await chromium.launch({ executablePath: findChromium() });

const PROFILES = {
    desktop: { label: 'desktop light zh', options: { viewport: { width: 1280, height: 860 }, locale: 'zh-CN', colorScheme: 'light' },
        names: { expand: '展开图表', more: '图表操作', copy: '复制源码', svg: '下载 SVG', png: '下载 PNG', source: '查看源码', copied: '已复制源码', fit: '适应窗口', close: '关闭图片预览' } },
    phone: { label: 'phone coarse dark en', options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'en-US', colorScheme: 'dark' },
        names: { expand: 'Expand diagram', more: 'Diagram actions', copy: 'Copy source', svg: 'Download SVG', png: 'Download PNG', source: 'View source', copied: 'Source copied', fit: 'Fit image to view', close: 'Close image preview' } },
};

async function watchedContext(label, profile, credentials) {
    const context = await browser.newContext({ ...profile.options, acceptDownloads: true, serviceWorkers: 'block' });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP });
    // Never reach production from a test build.
    await context.route(/^https?:\/\/([^/]*\.)?veryhappy\.dev(\/|$)/, (route) => { prodRequests.push(route.request().url()); return route.abort(); });
    await context.exposeBinding('vhCspViolation', ({ frame }, v) => violations.push({ label, frame: frame.url(), ...v }));
    await context.addInitScript((creds) => {
        try {
            localStorage.setItem('vh-pwa-install-never-v1', '1');
            if (creds) localStorage.setItem('auth_credentials', creds);
        } catch { /* opaque frame */ }
        document.addEventListener('securitypolicyviolation', (e) => {
            window.vhCspViolation?.({ directive: e.effectiveDirective, blocked: e.blockedURI, disposition: e.disposition });
        });
    }, credentials ?? null);
    context.on('console', (message) => {
        const text = message.text();
        if (/Content[- ]Security[- ]Policy|Refused to (load|execute|apply|connect|frame|create)/i.test(text)) violations.push({ label, console: text.slice(0, 300) });
    });
    context.on('page', (page) => page.on('pageerror', (e) => pageErrors.push(`[${label}] ${e.message}`)));
    if (process.env.VH_E2E_DEBUG) context.on('console', (m) => { if (m.type() === 'error') console.log(`  [${label}] console.error ${m.text().slice(0, 300)}`); });
    return context;
}

async function dismissOverlays(page) {
    await page.locator('.wn-card').waitFor({ timeout: 4_000 }).catch(() => {});
    for (const name of ['Got it', 'Not now', '知道了', '暂不']) {
        for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 1_000 }).catch(() => {});
    }
}

/** PNG IHDR width/height. */
function pngSize(buf) {
    return { sig: buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function press(page, locator, touch) { if (touch) await locator.tap(); else await locator.click(); }

async function menuAction(page, names, touch, item) {
    await press(page, page.getByRole('button', { name: names.more, exact: true }).first(), touch);
    const entry = page.getByRole('menuitem', { name: item, exact: true });
    await entry.waitFor({ timeout: 5_000 });
    await press(page, entry, touch);
}

/** Every check a profile runs on one page (session or share). */
async function exercise(page, profile, tag) {
    const { names } = profile;
    const touch = !!profile.options.hasTouch;
    const frame = page.locator('.mmd-frame').first();
    await frame.locator('.mmd-svg svg').waitFor({ timeout: 30_000 });
    const env = await page.evaluate(() => ({
        coarse: matchMedia('(pointer: coarse)').matches,
        theme: document.documentElement.getAttribute('data-theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark*' : 'light*'),
        lang: document.documentElement.lang,
        bg1: getComputedStyle(document.documentElement).getPropertyValue('--bg-1').trim(),
    }));
    console.log(`  [${tag}] env`, JSON.stringify(env));
    check(env.coarse === touch, `[${tag}] pointer is ${touch ? 'coarse' : 'fine'}`);

    // The broken diagram: source only, no tools.
    const failedBlocks = await page.locator('.mmd').filter({ hasText: 'not mermaid' }).count();
    const failedTools = await page.locator('.mmd').filter({ hasText: 'not mermaid' }).locator('.mmd-tools').count();
    check(failedBlocks === 1 && failedTools === 0, `[${tag}] a diagram that failed to render shows no expand / ⋯`, `blocks ${failedBlocks}, tools ${failedTools}`);

    // Buttons always visible (no hover); touch targets.
    const tools = await frame.locator('.mmd-tool').evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        const after = getComputedStyle(el, '::after');
        return { w: Math.round(r.width), h: Math.round(r.height), opacity: getComputedStyle(el.parentElement).opacity, label: el.getAttribute('aria-label'), afterInset: after.content !== 'none' ? after.top : null };
    }));
    console.log(`  [${tag}] tools`, JSON.stringify(tools));
    check(tools.length === 2 && tools[0].label === names.expand && tools[1].label === names.more, `[${tag}] expand + ⋯ present with ${touch ? 'English' : 'Chinese'} labels`);
    if (touch) check(tools.every((t) => t.opacity === '1' && t.w >= 34 && t.afterInset === '-5px'), `[${tag}] touch: tools fully visible without hover, 34px + 5px hit slop = 44px`);
    else check(tools.every((t) => Number(t.opacity) >= 0.6), `[${tag}] desktop: tools visible before hover`, tools.map((t) => t.opacity).join('/'));
    await page.screenshot({ path: join(OUT, `${tag}-1-inline.png`) });

    // ---- full screen ----
    await press(page, frame.getByRole('button', { name: names.expand, exact: true }), touch);
    const dialog = page.locator('.image-preview');
    await dialog.waitFor({ timeout: 5_000 });
    const img = dialog.locator('img.image-preview-image');
    await page.waitForFunction(() => { const i = document.querySelector('img.image-preview-image'); return i && i.complete && i.naturalWidth > 0 && getComputedStyle(i).visibility === 'visible'; }, null, { timeout: 10_000 });
    const geo = await page.evaluate(() => {
        const d = document.querySelector('.image-preview').getBoundingClientRect();
        const i = document.querySelector('img.image-preview-image');
        return { dialog: [Math.round(d.left), Math.round(d.top), Math.round(d.width), Math.round(d.height)], vw: innerWidth, vh: innerHeight, natural: [i.naturalWidth, i.naturalHeight], title: document.querySelector('.image-preview-title')?.textContent };
    });
    console.log(`  [${tag}] fullscreen`, JSON.stringify(geo));
    check(geo.natural[0] > 100 && geo.natural[1] > 100, `[${tag}] full screen shows the diagram image`, geo.natural.join('×'));
    if (touch) check(geo.dialog[0] === 0 && geo.dialog[1] === 0 && geo.dialog[2] === geo.vw && geo.dialog[3] === geo.vh, `[${tag}] full screen uses the whole phone screen`, geo.dialog.join(','));
    const scaleText = () => dialog.locator('.image-preview-scale').textContent();
    const transform = () => img.evaluate((el) => el.style.transform);
    const before = await scaleText();
    await page.screenshot({ path: join(OUT, `${tag}-2-fullscreen.png`) });
    const canvas = dialog.locator('.image-preview-canvas');
    const box = await canvas.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    if (touch) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 30, y: cy, id: 1 }, { x: cx + 30, y: cy, id: 2 }] });
        for (let s = 1; s <= 10; s++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 30 - s * 10, y: cy, id: 1 }, { x: cx + 30 + s * 10, y: cy, id: 2 }] });
            await sleep(16);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await sleep(100);
        const pinched = await scaleText();
        const vv = await page.evaluate(() => ({ scale: visualViewport.scale, scrollY }));
        check(pinched !== before && parseFloat(pinched) > parseFloat(before), `[${tag}] two-finger pinch zooms the diagram`, `${before} → ${pinched}`);
        check(vv.scale === 1, `[${tag}] the page itself did not zoom (visualViewport.scale 1)`, JSON.stringify(vv));
        const t0 = await transform();
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 3 }] });
        for (let s = 1; s <= 8; s++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + s * 8, y: cy + s * 6, id: 3 }] }); await sleep(16); }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await sleep(100);
        check((await transform()) !== t0, `[${tag}] one-finger drag pans the zoomed diagram`);
        await cdp.detach();
    } else {
        await page.mouse.move(cx, cy);
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, -400);
        await page.keyboard.up('Control');
        await sleep(100);
        const zoomed = await scaleText();
        check(parseFloat(zoomed) > parseFloat(before), `[${tag}] ctrl/pinch wheel zooms at the cursor`, `${before} → ${zoomed}`);
        const t0 = await transform();
        await page.mouse.down();
        await page.mouse.move(cx + 80, cy + 60, { steps: 8 });
        await page.mouse.up();
        check((await transform()) !== t0, `[${tag}] drag pans the zoomed diagram`);
    }
    await page.screenshot({ path: join(OUT, `${tag}-3-zoomed.png`) });
    await press(page, dialog.getByRole('button', { name: names.fit }), touch);
    await sleep(300);
    check((await scaleText()) === before, `[${tag}] fit resets the zoom`, `${await scaleText()}`);

    // Full-screen header actions: copy + SVG download from inside the viewer.
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await press(page, dialog.getByRole('button', { name: names.copy, exact: true }), touch);
    await sleep(200);
    check((await page.evaluate(() => navigator.clipboard.readText())) === MERMAID_SRC, `[${tag}] full screen: copy puts the diagram source on the clipboard`);
    const [fsDownload] = await Promise.all([page.waitForEvent('download'), press(page, dialog.getByRole('button', { name: names.svg, exact: true }), touch)]);
    check(fsDownload.suggestedFilename() === 'mermaid-diagram.svg', `[${tag}] full screen: SVG download`, fsDownload.suggestedFilename());

    if (touch) await press(page, dialog.getByRole('button', { name: names.close }), touch);
    else await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 5_000 }).then(() => check(true, `[${tag}] ${touch ? 'close button' : 'Esc'} leaves full screen`), () => check(false, `[${tag}] leaves full screen`));

    // ---- ⋯ menu ----
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await menuAction(page, names, touch, names.copy);
    await sleep(200);
    check((await page.evaluate(() => navigator.clipboard.readText())) === MERMAID_SRC, `[${tag}] ⋯ copy source = the block's source`);
    check((await page.locator('.mmd-note[role="status"]').first().textContent()) === names.copied, `[${tag}] inline "copied" status shown (no toast provider needed)`);

    const [svgDl] = await Promise.all([page.waitForEvent('download'), menuAction(page, names, touch, names.svg)]);
    const svgPath = join(OUT, `${tag}-diagram.svg`);
    await svgDl.saveAs(svgPath);
    const svg = readFileSync(svgPath, 'utf8');
    const svgOk = svg.startsWith('<svg') && svg.includes('xmlns="http://www.w3.org/2000/svg"') && ['Web', 'Server', 'Daemon online?', 'Run agent', 'Queue'].every((s) => svg.includes(s)) && !/max-width/.test(/^<svg[^>]*>/.exec(svg)?.[0] ?? 'max-width');
    check(svgDl.suggestedFilename() === 'mermaid-diagram.svg' && svgOk, `[${tag}] ⋯ Download SVG: standalone SVG with every node label`, `${svg.length} bytes`);
    check(/@font-face\{font-family:'IBM Plex Sans'[^}]*data:font\/woff2;base64,/.test(svg), `[${tag}] SVG embeds the page font (labels keep the width mermaid measured)`);
    check(svg.includes(`fill="${env.bg1}"`), `[${tag}] SVG background baked from this theme's --bg-1`, env.bg1);

    const [pngDl] = await Promise.all([page.waitForEvent('download'), menuAction(page, names, touch, names.png)]);
    const pngPath = join(OUT, `${tag}-diagram.png`);
    await pngDl.saveAs(pngPath);
    const png = readFileSync(pngPath);
    const size = pngSize(png);
    const svgHead = /^<svg[^>]*>/.exec(svg)?.[0] ?? '';
    const svgSize = [null, /\swidth="(\d+)"/.exec(svgHead)?.[1], /\sheight="(\d+)"/.exec(svgHead)?.[1]];
    const ratio = svgSize ? size.width / Number(svgSize[1]) : 0;
    const expectRatio = Math.max(2, profile.options.deviceScaleFactor ?? 1);
    check(pngDl.suggestedFilename() === 'mermaid-diagram.png' && size.sig && Math.abs(ratio - expectRatio) < 0.02, `[${tag}] ⋯ Download PNG: real PNG at ${expectRatio}×`, `${size.width}×${size.height}, svg ${svgSize?.[1]}×${svgSize?.[2]}`);

    // Open both files as images (a blank page, no app) and compare their pixels.
    const viewer = await page.context().newPage();
    await viewer.setContent('<body style="margin:0;background:#888"></body>');
    const pixels = await viewer.evaluate(async ({ svgText, pngB64 }) => {
        const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
        const svgImg = await load(`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgText)))}`);
        const pngImg = await load(`data:image/png;base64,${pngB64}`);
        const stats = (img) => {
            const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
            const x = c.getContext('2d');
            x.drawImage(img, 0, 0);
            const d = x.getImageData(0, 0, c.width, c.height).data;
            const colours = new Set();
            for (let i = 0; i < d.length; i += 4 * 97) colours.add(`${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3]}`);
            return { w: c.width, h: c.height, corner: `${d[0]},${d[1]},${d[2]},${d[3]}`, colours: colours.size };
        };
        document.body.append(svgImg, pngImg);
        pngImg.style.width = `${svgImg.naturalWidth}px`;
        return { svg: stats(svgImg), png: stats(pngImg) };
    }, { svgText: svg, pngB64: png.toString('base64') });
    console.log(`  [${tag}] files`, JSON.stringify(pixels));
    check(pixels.svg.w > 100 && pixels.svg.colours > 3 && pixels.png.colours > 3 && pixels.svg.corner === pixels.png.corner && pixels.png.corner.endsWith(',255'),
        `[${tag}] downloaded SVG and PNG both draw the diagram on the same opaque background`, pixels.png.corner);
    await viewer.screenshot({ path: join(OUT, `${tag}-4-downloads.png`), fullPage: true });
    await viewer.close();

    await menuAction(page, names, touch, names.source);
    await page.locator('.mmd .cv').filter({ hasText: 'Daemon online?' }).first().waitFor({ timeout: 5_000 })
        .then(() => check(true, `[${tag}] ⋯ View source swaps to the code block`), () => check(false, `[${tag}] ⋯ View source swaps to the code block`));
}

const MERMAID_SRC = MERMAID;
try {
    console.log('signup + seed (isolated server)');
    const seedCtx = await watchedContext('seed', PROFILES.desktop);
    const page = await seedCtx.newPage();
    const handle = `b890${randomBytes(3).toString('hex')}`;
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
    const credentials = await page.evaluate(() => localStorage.getItem('auth_credentials'));
    await seedCtx.close();

    const dev = await browser.newContext();
    await dev.route(/^https?:\/\/([^/]*\.)?veryhappy\.dev(\/|$)/, (route) => { prodRequests.push(route.request().url()); return route.abort(); });
    await dev.addInitScript((creds) => { localStorage.setItem('auth_credentials', creds); localStorage.setItem('vh-pwa-install-never-v1', '1'); }, credentials);
    const devPage = await dev.newPage();
    await devPage.goto(`${DEV}/`);
    await devPage.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 60_000, polling: 300 });
    const seeded = await devPage.evaluate(async ({ mermaid, broken }) => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const { encodeBase64 } = await import('/src/encryption/base64.ts');
        for (let i = 0; i < 150 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
        const dataKey = crypto.getRandomValues(new Uint8Array(32));
        const sealedKey = await sync.encryption.encryptEncryptionKey(dataKey);
        const enc = await sync.encryption.openEncryption(dataKey);
        const [metadata] = await enc.encrypt([{ path: '/tmp/b890', host: 'e2e', machineId: 'b890-none', flavor: 'claude' }]);
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
        const text = ['B890_MESSAGE the flow:', '```mermaid\n' + mermaid + '\n```', 'and a broken one:', '```mermaid\n' + broken + '\n```'].join('\n\n');
        const record = { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'assistant', model: 'e2e', content: [{ type: 'text', text }] } } } };
        const content = await encryption.encryptRawRecord(record);
        const posted = await apiSocket.request(`/v3/sessions/${sessionId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ localId: crypto.randomUUID(), content }] }) });
        const link = await apiSocket.request(`/v1/sessions/${sessionId}/share-links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'live', expiresInDays: 7 }) });
        const linkBody = link.ok ? await link.json() : null;
        return { sessionId, posted: posted.status, link: link.status, linkId: linkBody?.link?.id, secret: linkBody?.secret };
    }, { mermaid: MERMAID, broken: BROKEN });
    await dev.close();
    check(seeded.posted === 200 && seeded.link === 200, 'seeded a session with a mermaid diagram + an anonymous share link');

    for (const [key, profile] of Object.entries(PROFILES)) {
        console.log(`\n== ${profile.label}: session page`);
        const app = await watchedContext(`${key}-session`, profile, credentials);
        const p = await app.newPage();
        await p.goto(`${APP}/session/${seeded.sessionId}`);
        await p.getByText('B890_MESSAGE').first().waitFor({ timeout: 30_000 });
        await dismissOverlays(p);
        await exercise(p, profile, `${key}-session`);
        await app.close();

        console.log(`\n== ${profile.label}: anonymous share page`);
        const anon = await watchedContext(`${key}-share`, profile, null);
        const s = await anon.newPage();
        await s.goto(`${APP}/s/${seeded.linkId}#${seeded.secret}`);
        await s.getByText('B890_MESSAGE').first().waitFor({ timeout: 30_000 });
        check(await s.evaluate(() => !localStorage.getItem('auth_credentials')), `[${key}-share] not signed in`);
        await exercise(s, profile, `${key}-share`);
        await anon.close();
    }

    console.log('\n== totals');
    check(pageErrors.length === 0, 'pageerror 0', pageErrors.slice(0, 5).join(' | '));
    check(violations.length === 0, 'CSP violations 0 (enforced + report-only)', JSON.stringify(violations.slice(0, 5)));
    check(prodRequests.length === 0, 'no request reached *.veryhappy.dev', prodRequests.slice(0, 3).join(' '));
} catch (error) {
    console.log('  ✗ aborted:', error instanceof Error ? error.stack : error);
    failures += 1;
} finally {
    await browser.close();
}
console.log(failures === 0 ? 'mermaid actions e2e: all checks passed' : `mermaid actions e2e: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
