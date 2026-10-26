#!/usr/bin/env node
/**
 * B-024: post-deploy browser smoke — login → sidebar → open a web terminal →
 * the shell really ran a command. Runs after `Deploy production`
 * (.github/workflows/e2e-smoke.yml) or by hand:
 *
 *   VH_SMOKE_URL=https://veryhappy.dev VH_SMOKE_USERNAME=… VH_SMOKE_PASSWORD=… \
 *     pnpm -C packages/happy-web-v2 exec node e2e/smoke.mjs
 *
 * The account needs one ONLINE machine (or set VH_SMOKE_MACHINE to the
 * machine name shown in the terminal picker). The terminal it opens is closed
 * again with `exit`. On failure a screenshot + page text land in
 * VH_SMOKE_ARTIFACTS (default ./smoke-artifacts) and the exit code is 1.
 * Missing credentials print a notice and exit 0 (skip).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { smokeConfig, smokeMarker, terminalShowsOutput } from './smokeLib.mjs';

const config = smokeConfig(process.env);
if (config.skipReason) {
    console.log(`::notice title=Browser smoke skipped::${config.skipReason}`);
    process.exit(0);
}
const artifacts = process.env.VH_SMOKE_ARTIFACTS || 'smoke-artifacts';
const T = config.timeoutMs;
const started = Date.now();
const step = (name) => console.log(`[smoke +${((Date.now() - started) / 1000).toFixed(1)}s] ${name}`);

const browser = await chromium.launch(process.env.VH_SMOKE_CHROMIUM ? { executablePath: process.env.VH_SMOKE_CHROMIUM } : {});
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
// The install-app card would cover the page; this is the card's own "never show again".
await context.addInitScript(() => { try { localStorage.setItem('vh-pwa-install-never-v1', '1'); } catch { /* ignore */ } });
const page = await context.newPage();
let failed = false;
try {
    step(`login at ${config.url}`);
    await page.goto(`${config.url}/login`, { waitUntil: 'domcontentloaded', timeout: T });
    const username = page.locator('input[autocomplete="username"]');
    const toggle = page.locator('.auth-method-toggle');
    await username.or(toggle).first().waitFor({ state: 'visible', timeout: T });
    // Relays with e-mail / OIDC sign-in fold the password form behind a toggle.
    if (!(await username.isVisible())) await toggle.first().click();
    await username.fill(config.username, { timeout: T });
    await page.locator('input[autocomplete="current-password"]').fill(config.password);
    await page.locator('form.auth-password-form button[type="submit"], button[type="submit"]').first().click();

    step('sidebar');
    await page.locator('.sb .sb-header').waitFor({ state: 'visible', timeout: T });
    // One-time onboarding / what's-new overlays would swallow the next clicks.
    // B-823: the release notes open after the first screen, and not at all on
    // a page that already saw typing (the login form above) — so they can
    // arrive with the NEXT page load instead. Dismiss after every load.
    const dismissOverlays = async () => {
        await page.locator('.wn-card').waitFor({ timeout: 4_000 }).catch(() => {});
        for (const name of ['Got it', 'Not now']) {
            for (const b of await page.getByRole('button', { name, exact: true }).all()) await b.click({ timeout: 2_000 }).catch(() => {});
        }
    };
    await dismissOverlays();

    step('open a web terminal');
    await page.goto(`${config.url}/terminal`, { timeout: T });
    await dismissOverlays();
    // Terminal picker: the first group lists machines; only ONLINE ones are buttons.
    const online = page.locator('.vh-itemgroup').first().locator('button.vh-item.is-interactive');
    const pick = config.machine ? online.filter({ hasText: config.machine }).first() : online.first();
    await pick.click({ timeout: T });
    await page.locator('.xterm-screen').waitFor({ state: 'visible', timeout: T });

    step('echo through the shell');
    const marker = smokeMarker(randomBytes(6).toString('hex'));
    const screen = page.locator('.xterm-rows');
    await page.locator('.xterm-screen').click();
    // Wait for a prompt-ish first paint before typing (fresh tmux session).
    await page.waitForFunction(() => (document.querySelector('.xterm-rows')?.textContent ?? '').trim().length > 0, null, { timeout: T });
    await page.keyboard.type(marker.command, { delay: 15 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(
        (expected) => (document.querySelector('.xterm-rows')?.textContent ?? '').includes(expected),
        marker.expected,
        { timeout: T },
    );
    if (!terminalShowsOutput(await screen.textContent(), marker)) throw new Error('marker not on screen');
    step(`saw ${marker.expected}`);

    step('close the terminal');
    await page.keyboard.type('exit', { delay: 15 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1_500);
    step('ok');
} catch (error) {
    failed = true;
    console.error(`::error title=Browser smoke failed::${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: false }).catch(() => {});
    // Page text only — never cookies, storage or credentials.
    writeFileSync(join(artifacts, 'failure.txt'), `${page.url()}\n\n${await page.innerText('body').catch(() => '')}`.slice(0, 20_000));
} finally {
    await browser.close();
}
process.exit(failed ? 1 : 0);
