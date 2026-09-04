#!/usr/bin/env node
/**
 * css-probe —— 用**仓库真实 CSS** 在真实 Chromium 里量布局，并能采样像素。
 *
 * AGENTS「验收」那一节要求「复制真实 CSS 到一次性 harness 量 `scrollWidth - clientWidth`…
 * 修前修后各留一份」。2026-09 那两批下来，这个 harness 被现搭了三次，而且**两次最严重的
 * 缺陷只有它抓得到**：
 *
 *  - 滚动阴影**从未可见**：四层渐变画在包裹器背景层，被表格自己的不透明背景盖住。
 *    当时的验收断言的是 `is-scrollable` / `tabindex` / `aria-label` **存在**——三样都真的
 *    生效了，效果却是零。**类名存在 ≠ 效果可见，有渐变/遮挡/层叠就必须采像素。**
 *  - 折叠盒用 `overflow: hidden` 时**能被焦点和 ⌘F 滚走**（`scrollTop = 500` 生效），
 *    而表格里有可聚焦的链接。computed style 看不出来，单测更看不出来。
 *
 * 所以把脚手架固化在这里，别每次现写：找 Chromium、拼真 CSS、量、采像素。
 *
 * 用法：写一个 scenario 文件（ESM，default export），然后
 *
 *   node scripts/dev/css-probe.mjs <scenario.mjs> [--out <dir>]
 *
 * scenario 的形状：
 *
 *   export default {
 *     css: ['screens/session/markdown.css'],       // 相对 packages/happy-web-v2/src，tokens.css 自动带上
 *     html: '<div class="md">…</div>',             // 或 (variant) => string
 *     variants: [{ name: 'wide', width: 900 }, { name: 'phone', width: 390, theme: 'light' }],
 *     measure: () => ({ … }),                      // 在页面里跑，返回可 JSON 化的东西
 *     pixels: () => ({ x, y, width, height }),     // 可选：返回要采样的矩形（页面坐标）
 *   }
 *
 * 每个 variant 打印 measure 的结果、可选的像素行（R 通道），并把截图写进 --out。
 * **修前修后各跑一次、把两份都留下**——这是验收要的证据，不是「我看了一眼」。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(REPO, 'packages/happy-web-v2/src');

const [scenarioPath, ...rest] = process.argv.slice(2);
if (!scenarioPath) {
    console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    process.exit(2);
}
const outDir = rest.includes('--out') ? rest[rest.indexOf('--out') + 1] : null;

/** Chromium 从 playwright 的浏览器缓存里找，不下载。 */
function findChromium() {
    const base = join(homedir(), 'Library/Caches/ms-playwright');
    const alt = join(homedir(), '.cache/ms-playwright');
    for (const dir of [base, alt]) {
        if (!existsSync(dir)) continue;
        for (const entry of readdirSync(dir).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
            for (const rel of ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome']) {
                const exe = join(dir, entry, rel);
                if (existsSync(exe)) return exe;
            }
        }
    }
    return null;
}

/** 1px 宽的 PNG 竖条 → R 通道数组。手写过两次，固化在这里。 */
function pngColumn(buffer) {
    let i = 8;
    let idat = Buffer.alloc(0);
    let width = 0;
    let height = 0;
    let colorType = 6;
    while (i < buffer.length) {
        const len = buffer.readUInt32BE(i);
        const type = buffer.subarray(i + 4, i + 8).toString();
        const data = buffer.subarray(i + 8, i + 8 + len);
        if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
        if (type === 'IDAT') idat = Buffer.concat([idat, data]);
        i += 12 + len;
    }
    const raw = zlib.inflateSync(idat);
    const channels = colorType === 6 ? 4 : 3;
    const stride = 1 + width * channels;
    // 只取每行第一个像素的 R；scanline filter 未反解，所以采样条请用 width:1 且
    // 背景平坦的位置（这正是「看渐变有没有出现」需要的）。
    return Array.from({ length: height }, (_, row) => raw[row * stride + 1]);
}

const exe = findChromium();
if (!exe) {
    console.error('css-probe: no Chromium in the playwright browser cache.\n'
        + '  install one with:  pnpm dlx playwright-core@1.55.0 install chromium');
    process.exit(2);
}

let chromium;
try {
    ({ chromium } = await import('playwright-core'));
} catch {
    console.error('css-probe: playwright-core is not installed (devDependency of happy-web-v2).');
    process.exit(2);
}

const scenario = (await import(pathToFileURL(isAbsolute(scenarioPath) ? scenarioPath : resolve(scenarioPath)).href)).default;
const css = ['styles/tokens.css', ...(scenario.css ?? [])]
    .map((rel) => readFileSync(isAbsolute(rel) ? rel : join(SRC, rel), 'utf8'))
    .join('\n');
if (outDir) mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: exe });
for (const variant of scenario.variants ?? [{ name: 'default', width: 900 }]) {
    const context = await browser.newContext({
        viewport: { width: variant.width ?? 900, height: variant.height ?? 800 },
        deviceScaleFactor: variant.dpr ?? 2,
        colorScheme: variant.theme ?? 'dark',
        hasTouch: (variant.width ?? 900) < 500,   // AGENTS: 窄屏必须按 coarse pointer 量
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
    const html = typeof scenario.html === 'function' ? scenario.html(variant) : scenario.html;
    await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width">
<style>${css}\nhtml,body{margin:0;background:var(--bg-0)}</style>${html}`);
    await page.waitForTimeout(variant.settleMs ?? 200);

    const measured = scenario.measure ? await page.evaluate(scenario.measure) : null;
    console.log(`\n── ${variant.name} (${variant.width ?? 900}px, ${variant.theme ?? 'dark'})`);
    if (measured !== null) console.log(JSON.stringify(measured, null, 2));
    if (errors.length) console.log('pageerror:', JSON.stringify(errors));

    if (scenario.pixels) {
        const clip = await page.evaluate(scenario.pixels);
        if (clip) {
            const shot = await page.screenshot({ clip });
            console.log(`pixels @ ${JSON.stringify(clip)} → ${pngColumn(shot).join(' ')}`);
        }
    }
    if (outDir) await page.screenshot({ path: join(outDir, `${variant.name}.png`), fullPage: true });
    await context.close();
}
await browser.close();
