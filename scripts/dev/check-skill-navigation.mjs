#!/usr/bin/env node
// Regression: a PWA navigation to SKILL.md must not receive the SPA shell.
// Usage: node scripts/dev/check-skill-navigation.mjs <before-dist> <after-dist> <evidence.json>
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../packages/happy-web-v2/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const [beforeArg, afterArg, evidenceFile] = process.argv.slice(2);
assert(beforeArg && afterArg && evidenceFile, 'expected before-dist after-dist evidence.json');
const before = resolve(beforeArg), after = resolve(afterArg);
let active = before;
const evidence = { controllers: [], workerRequests: [] };
const persist = () => writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.md': 'text/markdown', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  try {
    const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '');
    if (relative === 'sw.js') evidence.workerRequests.push({ active, at: Date.now() });
    if (relative.split('/').includes('..')) { res.writeHead(400).end(); return; }
    let file = join(active, relative || 'index.html');
    try { if (!(await stat(file)).isFile()) throw Error('not file'); }
    catch {
      // Preserve old hashed assets when swapping builds, as a deployment must.
      const retained = join(before, relative);
      try { if (!(await stat(retained)).isFile()) throw Error('missing'); file = retained; }
      catch { file = join(active, 'index.html'); }
    }
    res.writeHead(200, { 'Content-Type': `${mime[extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch { res.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let executablePath;
for (const cache of [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]) {
  if (!existsSync(cache)) continue;
  for (const revision of readdirSync(cache).filter(x => x.startsWith('chromium-')).sort().reverse()) {
    for (const binary of ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome']) {
      const candidate = join(cache, revision, binary);
      if (!executablePath && existsSync(candidate)) executablePath = candidate;
    }
  }
}
assert(executablePath, 'Install the repository-pinned Chromium before running this regression');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", error => console.error("pageerror:", error.message));
  page.on('console', msg => { if (msg.type() === 'error' || msg.type() === 'warning') console.error(msg.text()); });
  console.log("open baseline");
  let onNextController;
  await page.exposeFunction('recordController', event => { evidence.controllers.push(event); onNextController?.(); });
  await page.addInitScript(() => navigator.serviceWorker.addEventListener('controllerchange', () => window.recordController({ at: Date.now(), url: navigator.serviceWorker.controller?.scriptURL, state: navigator.serviceWorker.controller?.state })));
  await page.goto(origin);
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const inspect = () => page.evaluate(() => ({ entry: [...document.scripts].map(x => x.src).find(x => x.includes('/assets/index-')), css: [...document.querySelectorAll('link[rel="stylesheet"]')].map(x => x.href), controller: navigator.serviceWorker.controller?.scriptURL, state: navigator.serviceWorker.controller?.state }));
  evidence.before = await inspect();
  console.log("baseline controlled");
  await persist();
  const navigateDocument = async () => {
    // Native target=_blank navigation, identical to both Todo skill links.
    await page.evaluate(() => { document.getElementById('skill-regression-link')?.remove(); const a = document.createElement('a'); a.id = 'skill-regression-link'; a.href = '/skills/very-happy-todo-provider/SKILL.md'; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = 'skill regression'; a.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;background:white;color:black'; document.body.append(a); });
    const [popup] = await Promise.all([context.waitForEvent('page'), page.locator('#skill-regression-link').click()]);
    await popup.waitForLoadState('domcontentloaded');
    const result = { url: popup.url(), html: await popup.content(), text: await popup.locator('body').innerText() };
    await popup.close();
    return result;
  };
  console.log("click baseline skill");
  const broken = await navigateDocument();
  evidence.beforeDocument = { url: broken.url, receivedShell: broken.html.includes('/assets/index-') };
  assert(evidence.beforeDocument.receivedShell, 'baseline did not reproduce shell interception');
  // Settle the popup bootstrap's old-build update before swapping the server.
  // Otherwise update() can join that already-running check and see no new worker.
  await page.evaluate(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.update(); });
  const previousEvents = evidence.controllers.length;
  console.log("switch build");
  active = after;
  let timer;
  const controlled = new Promise((resolve, reject) => { onNextController = resolve; timer = setTimeout(() => reject(Error('controllerchange timeout')), 30000); });
  await Promise.all([controlled, page.evaluate(async () => { for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.update(); })]).finally(() => clearTimeout(timer));
  await persist();
  console.log('updated controller');
  try { if ((await inspect()).entry === evidence.before.entry) await page.reload(); }
  catch (error) { if (!String(error).includes('ERR_ABORTED') && !String(error).includes('Execution context was destroyed')) throw error; }
  await page.waitForFunction(previousEntry => [...document.scripts].some(x => x.src.includes('/assets/index-') && x.src !== previousEntry), evidence.before.entry, { timeout: 45000 });
  assert(evidence.controllers.length > previousEvents, 'new controllerchange was not observed');
  evidence.after = await inspect();
  assert.equal(evidence.after.state, 'activated');
  const fixed = await navigateDocument();
  evidence.afterDocument = { url: fixed.url, receivedShell: fixed.html.includes('/assets/index-'), receivedSkill: fixed.text.includes('name: very-happy-todo-provider') };
  assert(!evidence.afterDocument.receivedShell && evidence.afterDocument.receivedSkill, 'skill navigation did not reach the real document');
  await persist();
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) { evidence.error = error.message; await persist(); throw error; }
finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
