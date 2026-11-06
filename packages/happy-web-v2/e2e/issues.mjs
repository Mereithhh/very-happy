#!/usr/bin/env node
/**
 * B-873: Issues on the Web, end to end in a real browser — the REAL app shell
 * (DEV device harness `/dev/device`, `AppLayout` + the production screens)
 * against the in-page fake of the S line's `/v1/issues*` routes
 * (`src/sync/issuesFake.ts`, same wire schemas and pure rules the server uses).
 * The fake stands in for B-872 until it is deployed; `window.__vhIssues.agent`
 * plays the daemon and the agent. Not part of CI:
 *
 *   pnpm -C packages/happy-web-v2 exec vite --port 5873
 *   node packages/happy-web-v2/e2e/issues.mjs --app http://127.0.0.1:5873 [--out <dir>] [--devices desktop,phone] [--langs zh-CN,en-US]
 *
 * Per device (desktop 1280, phone 390 with pointer: coarse) × language × theme:
 *   1. 新建 issue → 指派 Codex on the harness machine → the detail page shows
 *      run 1 queued (「等待 … 上线」);
 *   2. the daemon starts the run → run running, issue todo → in_progress;
 *   3. a comment previews 「排队送进 codex … 正在运行的会话」, a `/note` previews
 *      「只记录」; after sending, the timeline shows it with 「已送达 · 第 1 次执行」;
 *      typing `@cl` offers @claude inline and previews a new run for it;
 *   4. the agent comments and moves the issue to in_review → /board 「需要我决策」
 *      lists 「VH-1 待验收」 with 完成 / 退回; 完成 → issue done, the band empties;
 *   5. the run row opens its session; its header shows 「VH-1 · 已完成」 (a bar
 *      chip on desktop, a ⋯ row on the phone header) and that opens VH-1 again;
 *   6. switch off (`#issues-off`): /todos is the old Todos page, the sidebar has
 *      待办 and no Issues / 运行中, ⌘K has no issue rows, a session header has no VH chip; switch on: /todos → /issues?assignee=none.
 * No horizontal overflow, coarse touch targets ≥ 44px on the main controls.
 * Exit code 1 on any failed check.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const APP = opt('app', 'http://127.0.0.1:5873');
const OUT = opt('out', null);
const DEVICES = {
    desktop: { width: 1280, height: 860, dpr: 1, coarse: false },
    phone: { width: 390, height: 844, dpr: 3, coarse: true },
};
const LANGS = opt('langs', 'zh-CN,en-US').split(',');
const ONLY_DEVICES = opt('devices', 'desktop,phone').split(',');
const THEMES = opt('themes', 'light,dark').split(',');
if (OUT) mkdirSync(OUT, { recursive: true });

const COPY = {
    'zh-CN': { newIssue: '新建 issue', agent: 'Agent', create: '创建', queued: '排队中', waiting: '等待', running: '运行中', inProgress: '进行中', queuedPreview: '排队送进', notePreview: '只记录', delivered: '已送达 · 第 1 次执行', review: '待验收', accept: '完成', done: '已完成', todos: '待办', issues: 'Issues', running2: '运行中', send: '发送', moreActions: '更多会话操作' },
    'en-US': { newIssue: 'New issue', agent: 'Agent', create: 'Create', queued: 'Queued', waiting: 'Waiting for', running: 'Running', inProgress: 'In progress', queuedPreview: 'Queued into', notePreview: 'recorded only', delivered: 'Delivered · run 1', review: 'in review', accept: 'Done', done: 'Done', todos: 'Todos', issues: 'Issues', running2: 'Running', send: 'Send', moreActions: 'More session actions' },
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
const shot = async (page, name) => { if (OUT) await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false }); };
const noOverflow = (page) => page.evaluate(() => {
    const el = document.querySelector('.is-screen') ?? document.scrollingElement;
    return { scroll: el.scrollWidth, client: el.clientWidth, body: document.documentElement.scrollWidth, vw: window.innerWidth };
});

async function go(page, path) {
    await page.evaluate((p) => window.__vhDevNavigate?.(p), path);
}

const browser = await chromium.launch({ executablePath: findChromium() });
try {
    for (const deviceName of ONLY_DEVICES) {
        const d = DEVICES[deviceName];
        for (const lang of LANGS) {
            const c = COPY[lang];
            for (const theme of THEMES) {
                const tag = `${deviceName}-${lang}-${theme}`;
                step(`flow ${tag}`);
                const context = await browser.newContext({
                    viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.dpr, hasTouch: d.coarse, isMobile: d.coarse,
                    locale: lang, colorScheme: theme, serviceWorkers: 'block',
                });
                const page = await context.newPage();
                page.on('pageerror', (e) => console.log(`  ! pageerror ${e.message}`));
                await page.goto(`${APP}/dev/device/issues#issues-empty`);
                await page.waitForSelector('[data-testid="issues-screen"]', { timeout: 20000 });
                await shot(page, `${tag}-01-empty`);

                // 1. new issue → assign Codex
                await page.click('[data-testid="issues-new"]');
                const dialog = page.locator('[data-testid="new-issue-dialog"]');
                await dialog.waitFor();
                await dialog.locator('input.is-new-title-input').fill(`E2E ${tag}`);
                await dialog.locator('.is-assignee-kind button', { hasText: c.agent }).click();
                await dialog.locator('.ns-agent', { hasText: 'codex' }).click();
                // B-896: an agent needs a directory (server: issue_no_directory) — the dialog asks for it up front.
                await dialog.locator('#is-new-dir').fill('/work/e2e');
                await shot(page, `${tag}-02-new-dialog`);
                await dialog.locator('[data-testid="new-issue-create"]').click();
                await page.waitForSelector('[data-testid="issue-detail"]');
                const key = await page.getAttribute('[data-testid="issue-detail"]', 'data-issue');
                check(key === 'VH-1', `${tag}: created ${key}`);
                const runRow = page.locator('[data-testid="issue-runs"] .is-run').first();
                await runRow.waitFor();
                check((await runRow.getAttribute('data-run-status')) === 'queued', `${tag}: run 1 queued`);
                check((await runRow.innerText()).includes(c.waiting), `${tag}: queued run says it waits for the machine`);

                // 2. daemon starts it → running + in_progress
                await page.evaluate(() => { const s = window.__vhIssues; s.agent.start(s.runs()[0].id, 'dev-plain'); });
                await page.waitForSelector('[data-testid="issue-runs"] .is-run[data-run-status="running"]');
                check((await page.locator('.is-detail .is-head').innerText()).includes(c.inProgress), `${tag}: issue moved to in_progress on run start`);

                // 3. comment preview + send; /note preview
                const box = page.locator('[data-testid="issue-comment-box"] textarea');
                await box.fill('/note just for me');
                check((await page.locator('[data-testid="issue-trigger-preview"]').innerText()).includes(c.notePreview), `${tag}: /note previews no trigger`);
                await box.fill('Please add a unit test');
                check((await page.locator('[data-testid="issue-trigger-preview"]').innerText()).includes(c.queuedPreview), `${tag}: comment previews a queued delivery to the live run`);
                await shot(page, `${tag}-03-detail-running`);
                await page.click('[data-testid="issue-comment-send"]');
                await page.waitForFunction((t) => document.querySelector('[data-testid="issue-timeline"]')?.textContent?.includes(t), c.delivered);
                check(true, `${tag}: timeline shows the delivered comment`);
                // typing @ offers the agents inline; @claude would start a new run (not the assignee)
                await box.fill('also have a look @cl');
                const suggest = page.locator('[data-testid="issue-mention-suggest"] button', { hasText: '@claude' });
                await suggest.waitFor({ timeout: 5000 });
                await suggest.click();
                check((await box.inputValue()) === 'also have a look ', `${tag}: picking @claude removes the typed @cl`);
                check((await page.locator('[data-testid="issue-trigger-preview"]').innerText()).includes('claude'), `${tag}: @claude previews a new run for claude`);
                await shot(page, `${tag}-03b-mention`);
                await box.fill('');

                // 4. agent → in_review → 需要我决策 → 完成
                await page.evaluate(() => {
                    const s = window.__vhIssues; const run = s.runs()[0].id;
                    s.agent.comment(run, 'Working on it');
                    s.agent.setStatus(run, 'in_review', 'Added the test; vitest green.');
                });
                await page.waitForSelector('[data-testid="issue-review-bar"]');
                await shot(page, `${tag}-04-detail-review`);
                const overflow = await noOverflow(page);
                check(overflow.body <= overflow.vw + 1, `${tag}: detail has no horizontal overflow`, JSON.stringify(overflow));
                await go(page, '/dev/device/board');
                const band = page.locator('[data-testid="issue-decisions"]');
                await band.waitFor({ timeout: 10000 });
                check((await band.innerText()).includes(`VH-1`) && (await band.innerText()).toLowerCase().includes(c.review.toLowerCase()), `${tag}: 需要我决策 lists VH-1 in review`);
                if (d.coarse) {
                    const box2 = await band.locator('[data-testid="issue-accept"]').boundingBox();
                    check(box2 && box2.height >= 44, `${tag}: 完成 is a 44px touch target`, `${box2?.height}`);
                }
                await shot(page, `${tag}-05-board-decision`);
                await band.locator('[data-testid="issue-accept"]').click();
                await page.waitForFunction(() => !document.querySelector('[data-testid="issue-decisions"]'), null, { timeout: 10000 });
                const status = await page.evaluate(() => window.__vhIssues.issues()[0].status);
                check(status === 'done', `${tag}: 完成 closes the issue`, status);

                // 5. run row opens the session
                await go(page, `/dev/device/issues/${key}`);
                await page.waitForSelector('[data-testid="issue-runs"] .is-run');
                await page.locator('[data-testid="issue-runs"] .is-run-main').first().click();
                await page.waitForURL(/\/dev\/device\/session\/dev-plain/, { timeout: 10000 }).then(() => check(true, `${tag}: run row opens its session`), () => check(false, `${tag}: run row opens its session`, page.url()));
                // 5b. B-873b: the session header points back at the issue
                const chipText = `${key} · ${c.done}`;
                if (deviceName === 'phone') {
                    await page.locator('.ch [aria-label="' + c.moreActions + '"]').click();
                    const row = page.getByRole('menuitem', { name: chipText });
                    await row.waitFor({ timeout: 5000 }).then(() => check(true, `${tag}: phone ⋯ offers ${chipText}`), () => check(false, `${tag}: phone ⋯ offers ${chipText}`));
                    const rb = await row.boundingBox();
                    check(rb && rb.height >= 44, `${tag}: the ⋯ issue row is a 44px touch target`, `${rb?.height}`);
                    await shot(page, `${tag}-05c-session-issue-menu`);
                    await row.click();
                } else {
                    const chip = page.locator('[data-testid="session-issue-chip"]');
                    await chip.waitFor({ timeout: 5000 }).then(() => check(true, `${tag}: session header shows the VH chip`), () => check(false, `${tag}: session header shows the VH chip`));
                    check((await chip.innerText()).trim() === chipText, `${tag}: chip reads ${chipText}`, await chip.innerText());
                    await shot(page, `${tag}-05c-session-issue-chip`);
                    await chip.click();
                }
                await page.waitForURL(new RegExp(`/dev/device/issues/${key}$`), { timeout: 10000 }).then(() => check(true, `${tag}: the header entry opens ${key}`), () => check(false, `${tag}: the header entry opens ${key}`, page.url()));

                // list / board views with seeded data (screens only)
                if (theme === THEMES[0]) {
                    await page.goto(`${APP}/dev/device/issues#issues`);
                    await page.waitForSelector('[data-testid="issues-list"] .is-row');
                    await page.waitForTimeout(400);
                    await shot(page, `${tag}-06-list`);
                    const o2 = await noOverflow(page);
                    check(o2.body <= o2.vw + 1, `${tag}: list has no horizontal overflow`, JSON.stringify(o2));
                    check(await page.locator('.is-idle-still').count() > 0, `${tag}: idle-but-in-progress marker shown`);
                    await page.locator('.vh-segmented button', { hasText: lang === 'zh-CN' ? '看板' : 'Board' }).click();
                    await page.waitForSelector('[data-testid="issues-board"]');
                    await shot(page, `${tag}-07-board`);
                    await page.locator('.is-tabs button').nth(2).click();
                    await page.waitForSelector('[data-testid="issue-decisions"]');
                    await shot(page, `${tag}-08-waiting`);
                    check((await page.locator('[data-testid="issue-decisions"] [data-kind="failed"]').count()) === 1, `${tag}: failed sessionless run in 等我处理`);
                    // ⌘K: issue rows by key; no match → 「新建 issue：<查询>」
                    await page.keyboard.press('Control+k');
                    const input = page.locator('.cp-search-input');
                    await input.waitFor();
                    await input.fill('VH-4');
                    await page.waitForSelector('.cp-group--issues .cp-row', { timeout: 5000 }).then(() => check(true, `${tag}: ⌘K finds VH-4`), () => check(false, `${tag}: ⌘K finds VH-4`));
                    await input.fill('zzqq unmatched');
                    await page.waitForTimeout(300);
                    check((await page.locator('.cp-row', { hasText: c.newIssue === '新建 issue' ? '新建 issue：zzqq unmatched' : 'New issue: zzqq unmatched' }).count()) === 1, `${tag}: ⌘K offers 新建 issue for an unmatched query`);
                    await shot(page, `${tag}-11-palette`);
                    await page.keyboard.press('Escape');
                    // /todos → /issues?assignee=none while on
                    await go(page, '/dev/device/todos');
                    await page.waitForURL(/\/dev\/device\/issues\?assignee=none/, { timeout: 10000 }).then(() => check(true, `${tag}: /todos redirects to unassigned issues`), () => check(false, `${tag}: /todos redirects`, page.url()));
                }
                await context.close();

                // 6. switch off: old Todos, old sidebar
                if (theme === THEMES[0]) {
                    const offCtx = await browser.newContext({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.dpr, hasTouch: d.coarse, isMobile: d.coarse, locale: lang, colorScheme: theme, serviceWorkers: 'block' });
                    const off = await offCtx.newPage();
                    await off.goto(`${APP}/dev/device/todos#issues-off`);
                    await off.waitForSelector('.td-title', { timeout: 20000 });
                    check((await off.locator('.td-title').innerText()).trim() === c.todos, `${tag}: switch off → old Todos page`);
                    check(off.url().includes('/dev/device/todos'), `${tag}: switch off → no redirect`);
                    await shot(off, `${tag}-09-off-todos`);
                    await off.goto(`${APP}/dev/device#issues-off`);
                    await off.waitForTimeout(1200);
                    const caps = await off.evaluate(() => [...document.querySelectorAll('[data-cap]')].map((e) => e.getAttribute('data-cap')));
                    check(!caps.includes('issues') && !caps.includes('board'), `${tag}: switch off → no Issues / 运行中 entries`, caps.join(','));
                    await shot(off, `${tag}-10-off-sidebar`);
                    await off.keyboard.press('Control+k');
                    const offInput = off.locator('.cp-search-input');
                    await offInput.waitFor();
                    await offInput.fill('VH-1');
                    await off.waitForTimeout(400);
                    check((await off.locator('.cp-group--issues').count()) === 0 && (await off.locator('.cp-row', { hasText: c.newIssue === '新建 issue' ? '新建 issue：' : 'New issue:' }).count()) === 0, `${tag}: switch off → ⌘K has no issue rows`);
                    await off.keyboard.press('Escape');
                    await off.goto(`${APP}/dev/device/session/dev-plain#issues-off`);
                    await off.waitForSelector('.ch', { timeout: 20000 });
                    await off.waitForTimeout(600);
                    check((await off.locator('[data-testid="session-issue-chip"]').count()) === 0, `${tag}: switch off → no VH chip in the session header`);
                    await offCtx.close();
                }
            }
        }
    }
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
