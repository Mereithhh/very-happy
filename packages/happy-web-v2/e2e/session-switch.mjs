#!/usr/bin/env node
/**
 * B-885: switching sessions from the sidebar, measured on a PRODUCTION build.
 * Not part of CI — run by hand:
 *
 *   pnpm -C packages/happy-web-v2 exec vite build --outDir <web>
 *   DATA_DIR=<tmp> pnpm -C packages/happy-server exec tsx --env-file=.env.dev ./sources/standalone.ts migrate
 *   VH_SERVER_URL=http://127.0.0.1:<port> pnpm -C packages/happy-web-v2 exec vite --port <vite> --strictPort
 *   node packages/happy-web-v2/e2e/session-switch.mjs --web <web> --data-dir <tmp> --port <port> \
 *     --vite http://127.0.0.1:<vite> [--rtt-ms 400] [--device desktop|phone|foldable] [--loops 6] [--out <dir>] [--fold-project]
 *
 * The script starts the standalone server serving <web> (the built bundle, the
 * production shape) on --port, and a TCP proxy on --port + 1 that delays every
 * byte coming back by --rtt-ms once the app is up (a far / slow phone link).
 * Seeding runs in a dev page (Vite, same server): sign up, three sessions with
 * a transcript each. The measured page is the production bundle through the proxy.
 *
 * Per switch (a real click on the sidebar row; on a phone the drawer first):
 *   sync     how many times 「同步消息中…」 (.chat-sync) appeared
 *   bar      how many times the top 「同步中…」 bar (.net-bar[data-net-phase=syncing]) appeared
 *   shift    layout-shift sum, input-excluded entries INCLUDED (a click marks the next
 *            500ms as "recent input", which would hide exactly the shifts at stake)
 *   jump     largest move (px) of the chat header / composer from their final place
 *            in the 2s after the click, sampled every frame
 *   frames   screenshots every ~100ms for the first second (--out)
 *
 * B-887 — the clicked SIDEBAR ROW (desktop; on a phone the list is its own
 * screen and leaves on purpose, so there only the 300ms before the route moves
 * counts). Four seeded sessions cover the row states: S1 read, S2 unread
 * (dot), S3 needs-me (pending permission + heartbeat), S4 pinned (P0 tag).
 *   rowOut   times a [data-dragkey=<clicked>] element was REMOVED from the DOM
 *            (MutationObserver) — 0 means the row never left
 *   rowIn    times one was inserted
 *   inner    removals inside the kept row (its content remounted)
 *   same     the element after the switch is the node that was clicked
 *   moved    the row's index among the rendered rows changed in the 2s after
 *   gone     frames (2s, every rAF) in which the row was absent or 0-height
 * --fold-project: the four sessions live in one project the user folded by hand
 * (vh:sidebar-collapsed-groups:v1), entered by deep link — the B-887 repro.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const WEB = opt('web', null);
const DATA_DIR = opt('data-dir', null);
const PORT = Number(opt('port', '38851'));
const PROXY_PORT = PORT + 1;
const VITE = opt('vite', null);
const RTT_MS = Number(opt('rtt-ms', '400'));
const DEVICE = opt('device', 'desktop');
const OUT = opt('out', null);
const RECORDS = Number(opt('records', '40'));
const LOOPS = Number(opt('loops', '6'));
// B-887: put the four sessions in one project that is folded by hand — the page
// opens S1 by deep link (the reveal opens the fold for that route), then every
// click is a sibling in the same temporarily opened group.
const FOLD_PROJECT = args.includes('--fold-project');
if (!WEB || !DATA_DIR || !VITE) {
    console.error('--web, --data-dir and --vite are required');
    process.exit(2);
}
if (OUT) mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serverDir = resolve(import.meta.dirname, '../../happy-server');

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

// ── server (serves the built bundle) ──────────────────────────────────
const server = spawn(resolve(serverDir, '../../node_modules/.bin/tsx'), ['--env-file=.env.dev', './sources/standalone.ts', 'serve'], {
    cwd: serverDir,
    env: { ...process.env, DATA_DIR, PORT: String(PORT), METRICS_PORT: String(PORT + 6000), SIGNUP_MODE: 'open', HAPPY_STATIC_DIR: resolve(WEB) },
    stdio: 'ignore',
});
for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* starting */ }
    if (i > 300) throw new Error('server did not come up');
    await sleep(200);
}

// ── latency proxy: every downstream chunk waits `latency` ms (order kept) ──
let latency = 0;
const proxy = net.createServer((client) => {
    const up = net.connect(PORT, '127.0.0.1');
    client.pipe(up);
    up.on('data', (chunk) => {
        if (latency > 0) setTimeout(() => client.write(chunk), latency);
        else client.write(chunk);
    });
    up.on('end', () => setTimeout(() => client.end(), latency));
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
    client.on('close', () => up.destroy());
});
await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
const APP = `http://127.0.0.1:${PROXY_PORT}`;

const browser = await chromium.launch({ executablePath: findChromium() });
const results = [];
let heartbeat = null;
try {
    // ── seed through the dev page (its /src modules) ──────────────────
    const seedCtx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 860 }, locale: 'zh-CN' });
    const seed = await seedCtx.newPage();
    const username = `b885${randomBytes(4).toString('hex')}`;
    await seed.goto(`${VITE}/signup`);
    const toggle = seed.locator('.auth-method-toggle');
    const usernameInput = seed.locator('input[autocomplete="username"]');
    await usernameInput.or(toggle).first().waitFor({ timeout: 60_000 });
    if (!(await usernameInput.isVisible())) await usernameInput.waitFor({ timeout: 1_500 }).catch(() => toggle.click());
    await usernameInput.fill(username);
    const pw = `pw-${randomBytes(6).toString('hex')}`;
    await seed.locator('input[autocomplete="new-password"]').nth(0).fill(pw);
    await seed.locator('input[autocomplete="new-password"]').nth(1).fill(pw);
    await seed.locator('form.auth-password-form button[type="submit"]').click();
    await seed.waitForFunction(() => import('/src/sync/storage.ts').then(({ storage }) => storage.getState().socketStatus === 'connected'), null, { timeout: 60_000, polling: 300 });
    await seed.waitForFunction(() => import('/src/sync/sync.ts').then(({ sync }) => !!sync.encryption), null, { timeout: 60_000, polling: 300 });
    const ids = await seed.evaluate(async (records) => {
        const { sync } = await import('/src/sync/sync.ts');
        const { apiSocket } = await import('/src/sync/apiSocket.ts');
        const { encodeBase64 } = await import('/src/encryption/base64.ts');
        for (let i = 0; i < 150 && !sync.encryption; i++) await new Promise((r) => setTimeout(r, 200));
        const out = [];
        // B-887: S1 read · S2 unread · S3 needs-me (pending permission) · S4 pinned (P0).
        for (const n of [1, 2, 3, 4]) {
            const enc = await sync.encryption.openEncryption(null);
            const [metadata] = await enc.encrypt([{ path: `/tmp/b885-${n}`, host: 'e2e', flavor: 'claude', summary: { text: `B885 session ${n}`, updatedAt: Date.now() }, ...(n === 4 ? { tags: ['P0'] } : {}) }]);
            const agentState = n === 3
                ? encodeBase64((await enc.encrypt([{ requests: { r1: { tool: 'Bash', arguments: { command: 'ls' }, createdAt: Date.now() } } }]))[0], 'base64')
                : null;
            const res = await apiSocket.request('/v1/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag: crypto.randomUUID(), metadata: encodeBase64(metadata, 'base64'), agentState, dataEncryptionKey: null }),
            });
            out.push((await res.json()).session.id);
        }
        await sync.refreshSessions?.();
        for (const sid of out) {
            let encryption = null;
            for (let i = 0; i < 100 && !(encryption = sync.encryption.getSessionEncryption(sid)); i++) await new Promise((r) => setTimeout(r, 100));
            const messages = [];
            for (let i = 0; i < records; i++) {
                const record = i % 2 === 0
                    ? { role: 'user', content: { type: 'text', text: `question ${i} for ${sid.slice(0, 6)}` } }
                    : { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'assistant', model: 'e2e', content: [{ type: 'text', text: `answer ${i}: ${'lorem ipsum dolor sit amet '.repeat(6)}` }] } } } };
                messages.push({ localId: crypto.randomUUID(), content: await encryption.encryptRawRecord(record) });
            }
            const res = await apiSocket.request(`/v3/sessions/${sid}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }) });
            if (!res.ok) throw new Error(`seed POST ${res.status}`);
        }
        const { saveUnreadSessionIds } = await import('/src/sync/persistence.ts');
        saveUnreadSessionIds([out[1]]);
        return out;
    }, RECORDS);
    if (FOLD_PROJECT) {
        await seed.evaluate(async (sessionIds) => {
            const { projectsApi } = await import('/src/sync/projects.ts');
            const { project } = await projectsApi.create({ name: 'B887 folded', sessionIds });
            localStorage.setItem('vh:sidebar-collapsed-groups:v1', JSON.stringify({ [`project:${project.id}`]: true }));
        }, ids);
        console.log('project created and folded by hand');
    }
    const storageDump = await seed.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    // S3 stays online (its request is only "needs me" while the agent is alive).
    heartbeat = setInterval(() => {
        seed.evaluate((sid) => import('/src/sync/apiSocket.ts').then(({ apiSocket }) => apiSocket.send('session-alive', { sid, time: Date.now(), thinking: false })), ids[2]).catch(() => {});
    }, 5_000);
    await seed.evaluate((sid) => import('/src/sync/apiSocket.ts').then(({ apiSocket }) => apiSocket.send('session-alive', { sid, time: Date.now(), thinking: false })), ids[2]);
    console.log(`seeded ${ids.length} sessions × ${RECORDS} records`);

    // ── the production page ───────────────────────────────────────────
    const phone = DEVICE === 'phone';
    // B-887: an unfolded foldable / iPad portrait (coarse, <1100px) — the sidebar is a drawer that stays mounted.
    const foldable = DEVICE === 'foldable';
    const ctx = await browser.newContext({
        serviceWorkers: 'block',
        locale: 'zh-CN',
        ...(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
            : foldable ? { viewport: { width: 890, height: 626 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
            : { viewport: { width: 1280, height: 860 } }),
    });
    await ctx.addInitScript((entries) => {
        if (window.top !== window) return;
        if (!sessionStorage.getItem('b885-seeded')) {
            sessionStorage.setItem('b885-seeded', '1');
            for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
            localStorage.setItem('vh-pwa-install-never-v1', '1');
            localStorage.setItem('vh.featureTips.seen.v1', JSON.stringify(['quick-open@1', 'prompt-rail@1', 'review-all@1', 'session-peek@1']));
        }
        const probe = { shifts: [], sync: 0, bar: 0, syncOn: false, barOn: false };
        window.__b885 = probe;
        new PerformanceObserver((list) => {
            for (const e of list.getEntries()) probe.shifts.push({ at: e.startTime, value: e.value, recentInput: e.hadRecentInput });
        }).observe({ type: 'layout-shift', buffered: true });
        const check = () => {
            const syncOn = !!document.querySelector('.chat-sync');
            const barOn = document.querySelector('.net-bar')?.getAttribute('data-net-phase') === 'syncing';
            if (syncOn && !probe.syncOn) probe.sync += 1;
            if (barOn && !probe.barOn) probe.bar += 1;
            probe.syncOn = syncOn;
            probe.barOn = barOn;
        };
        new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-net-phase', 'class'] });
        // B-887: every sidebar row element that leaves / enters the DOM, and any
        // removal INSIDE a row that stays (its content remounting).
        const rows = { out: [], in: [], inner: [] };
        window.__b887 = rows;
        const keysOf = (node) => {
            if (!(node instanceof Element)) return [];
            const own = node.matches('[data-dragkey]') ? [node] : [];
            return [...own, ...node.querySelectorAll('[data-dragkey]')].map((el) => el.getAttribute('data-dragkey'));
        };
        new MutationObserver((list) => {
            const at = performance.now();
            for (const m of list) {
                for (const n of m.removedNodes) {
                    const keys = keysOf(n);
                    for (const key of keys) rows.out.push({ key, at });
                    const host = keys.length === 0 && m.target instanceof Element ? m.target.closest('[data-dragkey]') : null;
                    if (host && n instanceof Element) rows.inner.push({ key: host.getAttribute('data-dragkey'), at, tag: n.tagName, cls: String(n.className).slice(0, 40) });
                }
                for (const n of m.addedNodes) for (const key of keysOf(n)) rows.in.push({ key, at });
            }
        }).observe(document, { subtree: true, childList: true });
    }, storageDump);
    // Never production: anything aimed at veryhappy.dev is cut (and counted).
    let prodHits = 0;
    await ctx.route(/veryhappy\.dev/, (route) => { prodHits += 1; return route.abort(); });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    await page.goto(`${APP}/session/${ids[0]}`);
    await page.locator('textarea.ci-textarea').waitFor({ timeout: 60_000 });
    await sleep(3_000);
    for (const name of ['知道了', '暂不', 'Got it', 'Not now']) {
        for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 1_000 }).catch(() => {});
    }
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    if (FOLD_PROJECT) {
        // In-app route change once the projects are loaded (⌘K / a notification): the reveal opens the fold.
        await page.evaluate(() => { history.pushState({}, '', '/'); dispatchEvent(new PopStateEvent('popstate')); });
        await sleep(800);
        await page.evaluate((sid) => { history.pushState({}, '', `/session/${sid}`); dispatchEvent(new PopStateEvent('popstate')); }, ids[0]);
        await sleep(1_500);
    }
    if (OUT) await page.screenshot({ path: join(OUT, `${DEVICE}-0-start.png`) });
    console.log(`device ${DEVICE}, pointer coarse: ${coarse}`);
    latency = RTT_MS / 2;
    await sleep(500);

    async function dismiss() {
        for (const name of ['知道了', '暂不', 'Got it', 'Not now']) {
            for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 1_000 }).catch(() => {});
        }
    }
    async function switchTo(sid, label) {
        await dismiss();
        const link = page.locator(`[data-dragkey="${sid}"]`).first();
        if (!(await link.isVisible().catch(() => false))) {
            // Phone: the session list is its own screen — open it in-app (no reload), like the header's back.
            const rail = page.locator('.app-rail-btn').first();
            if (await rail.isVisible().catch(() => false)) await rail.click();
            else await page.evaluate(() => { history.pushState({}, '', '/'); dispatchEvent(new PopStateEvent('popstate')); });
            await link.waitFor({ state: 'visible', timeout: 10_000 }).catch(async (e) => {
                if (OUT) await page.screenshot({ path: join(OUT, `${label}-missing.png`) });
                throw e;
            });
            await sleep(400);
        }
        const before = await page.evaluate((sid) => {
            const el = document.querySelector(`[data-dragkey="${sid}"]`);
            window.__b887node = el;
            const keys = [...document.querySelectorAll('[data-dragkey]')].map((e) => e.getAttribute('data-dragkey'));
            return { sync: __b885.sync, bar: __b885.bar, n: __b885.shifts.length, now: performance.now(), out: __b887.out.length, in: __b887.in.length, inner: __b887.inner.length,
                index: keys.indexOf(sid), state: el?.querySelector('[aria-label], [title]')?.getAttribute('aria-label') ?? '', text: el?.innerText.replace(/\s+/g, ' ').slice(0, 60) ?? '' };
        }, sid);
        // B-887: the clicked row every frame for 2s — present / height / index.
        const rowSamples = page.evaluate((sid) => new Promise((done) => {
            const out = [];
            const t0 = performance.now();
            const tick = () => {
                const all = [...document.querySelectorAll('[data-dragkey]')];
                const el = all.find((e) => e.getAttribute('data-dragkey') === sid);
                out.push({ at: Math.round(performance.now() - t0), path: location.pathname, present: !!el, h: el ? Math.round(el.getBoundingClientRect().height) : 0, index: el ? all.indexOf(el) : -1 });
                if (performance.now() - t0 < 2_000) requestAnimationFrame(tick);
                else done(out);
            };
            requestAnimationFrame(tick);
        }), sid);
        // Header / composer tops every frame for 2s from the click.
        const samples = page.evaluate(() => new Promise((done) => {
            const out = [];
            const t0 = performance.now();
            const tick = () => {
                const header = document.querySelector('header.ch')?.getBoundingClientRect().top ?? null;
                const composer = document.querySelector('textarea.ci-textarea')?.getBoundingClientRect().top ?? null;
                const shell = parseFloat(getComputedStyle(document.querySelector('.app-shell') ?? document.body).paddingTop) || 0;
                out.push({ at: Math.round(performance.now() - t0), path: location.pathname.slice(-6), header, composer, shell });
                if (performance.now() - t0 < 2_000) requestAnimationFrame(tick);
                else done(out);
            };
            requestAnimationFrame(tick);
        }));
        if (phone || foldable) await link.tap(); else await link.click();
        const frames = [];
        if (OUT) {
            for (let i = 0; i < 10; i++) {
                const file = join(OUT, `${label}-${String(i).padStart(2, '0')}.png`);
                await page.screenshot({ path: file }).catch(() => {});
                frames.push(file);
                await sleep(60);
            }
        }
        const rows = (await samples).filter((s) => s.path === sid.slice(-6));
        await sleep(1_000);
        const after = await page.evaluate(({ n, out, in: inn, inner, sid }) => ({
            sync: __b885.sync, bar: __b885.bar, shifts: __b885.shifts.slice(n),
            rowOut: __b887.out.slice(out).filter((e) => e.key === sid).length,
            rowIn: __b887.in.slice(inn).filter((e) => e.key === sid).length,
            anyOut: __b887.out.slice(out).length,
            inner: __b887.inner.slice(inner).filter((e) => e.key === sid),
            same: window.__b887node != null && window.__b887node.isConnected && document.querySelector(`[data-dragkey="${sid}"]`) === window.__b887node,
        }), { ...before, sid });
        const frames2 = await rowSamples;
        // Phone: the list screen leaves on purpose once the route moves — judge only before that.
        const judged = phone ? frames2.filter((f) => f.at < 300 && !f.path.endsWith(sid)) : frames2;
        const gone = judged.filter((f) => !f.present || f.h === 0).length;
        const moved = judged.some((f) => f.present && f.index !== before.index);
        const last = rows.at(-1) ?? {};
        const jump = rows.reduce((max, s) => Math.max(max,
            s.header != null && last.header != null ? Math.abs(s.header - last.header) : 0,
            s.composer != null && last.composer != null ? Math.abs(s.composer - last.composer) : 0), 0);
        const result = {
            label,
            sync: after.sync - before.sync,
            bar: after.bar - before.bar,
            shift: Number(after.shifts.reduce((sum, e) => sum + e.value, 0).toFixed(4)),
            clsExcludingInput: Number(after.shifts.filter((e) => !e.recentInput).reduce((sum, e) => sum + e.value, 0).toFixed(4)),
            jump: Math.round(jump),
            shellPadMax: Math.max(0, ...rows.map((s) => s.shell)),
            rowState: before.text,
            rowOut: after.rowOut,
            rowIn: after.rowIn,
            anyRowOut: after.anyOut,
            inner: after.inner.length,
            innerTags: [...new Set(after.inner.map((e) => `${e.tag}.${e.cls}`))].slice(0, 4),
            same: after.same,
            moved,
            gone,
            index: before.index,
        };
        results.push(result);
        console.log(JSON.stringify(result));
    }

    // S2 / S3 never opened in this tab (cold); S1 / S2 then switched back to (loaded).
    await switchTo(ids[1], `${DEVICE}-1-cold-S2`);
    await sleep(1_500);
    await switchTo(ids[0], `${DEVICE}-2-loaded-S1`);
    await sleep(1_500);
    await switchTo(ids[1], `${DEVICE}-3-loaded-S2`);
    await sleep(1_500);
    await switchTo(ids[2], `${DEVICE}-4-cold-S3`);
    await sleep(1_500);
    await switchTo(ids[0], `${DEVICE}-5-loaded-S1`);
    await sleep(1_500);
    await switchTo(ids[2], `${DEVICE}-6-loaded-S3`);
    await sleep(1_500);
    await switchTo(ids[3], `${DEVICE}-7-cold-S4`);
    for (let i = 0; i < LOOPS; i++) {
        await sleep(1_500);
        await switchTo(ids[i % 4], `${DEVICE}-${8 + i}-loaded-S${(i % 4) + 1}`);
    }
    const loaded = results.filter((r) => r.label.includes('loaded'));
    const cold = results.filter((r) => r.label.includes('cold'));
    const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0);
    console.log(`SIDEBAR ${DEVICE}: switches ${results.length}, clicked row removed ${sum(results, 'rowOut')}×, inserted ${sum(results, 'rowIn')}×, inner removals ${sum(results, 'inner')}, node replaced ${results.filter((r) => !r.same).length}×, moved ${results.filter((r) => r.moved).length}×, gone frames ${sum(results, 'gone')}`);
    console.log(`SUMMARY ${DEVICE} rtt ${RTT_MS}ms: loaded switches ${loaded.length}, 「同步消息中」 ${sum(loaded, 'sync')}×, top bar ${sum(loaded, 'bar')}×, shift sum ${sum(loaded, 'shift').toFixed(4)}, max jump ${Math.max(...loaded.map((r) => r.jump))}px; cold switches ${cold.length}, 「同步消息中」 ${sum(cold, 'sync')}×, shift sum ${sum(cold, 'shift').toFixed(4)}, max jump ${Math.max(...cold.map((r) => r.jump))}px`);
    console.log(`requests to veryhappy.dev (blocked): ${prodHits}`);
    if (OUT) writeFileSync(join(OUT, `${DEVICE}-results.json`), JSON.stringify({ rttMs: RTT_MS, coarse, results }, null, 2));
} finally {
    clearInterval(heartbeat);
    await browser.close();
    proxy.close();
    server.kill('SIGTERM');
}
