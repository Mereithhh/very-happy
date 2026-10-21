/**
 * B-724 — generate every static Very Happy logo asset from the single geometry source
 * (packages/happy-web-v2/src/ui/veryHappyMarkGeometry.ts) and the colour tokens in
 * src/styles/tokens.css. Re-run after changing either; the output is committed.
 *
 *     pnpm exec tsx scripts/brand/build-logo-assets.ts           # write
 *     pnpm exec tsx scripts/brand/build-logo-assets.ts --check   # exit 1 if any SVG drifted
 *
 * Rasterising uses sharp (librsvg) resolved from packages/happy-server, so no new
 * dependency. Text is pre-outlined (scripts/brand/outline-text.py → textOutlines.json)
 * so the output never depends on fonts installed on this machine.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARK_PIXELS_16, MARK_PIXELS_32, markBlockPath, markFacePath, markPath, pixelPath,
} from '../../packages/happy-web-v2/src/ui/veryHappyMarkGeometry';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WEB = join(ROOT, 'packages/happy-web-v2');
const PUBLIC = join(WEB, 'public');
const GITHUB = join(ROOT, '.github');
const CHECK = process.argv.includes('--check');

// ---------------------------------------------------------------- tokens

/** Read a hex `--name` from the first top-level block with exactly this selector that defines it. */
export function tokenValue(css: string, selector: string, name: string): string {
  for (let at = css.indexOf(`\n${selector} {`); at >= 0; at = css.indexOf(`\n${selector} {`, at + 1)) {
    const block = css.slice(at, css.indexOf('\n}', at));
    const m = block.match(new RegExp(`\\n\\s*${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
    if (m) return m[1].toLowerCase();
  }
  throw new Error(`tokens.css: ${selector} has no ${name}`);
}

const tokensCss = readFileSync(join(WEB, 'src/styles/tokens.css'), 'utf8');
const C = {
  lightText: tokenValue(tokensCss, ":root[data-theme='light']", '--text'),
  lightBg: tokenValue(tokensCss, ":root[data-theme='light']", '--bg-0'),
  lightDim: tokenValue(tokensCss, ":root[data-theme='light']", '--text-dim'),
  darkText: tokenValue(tokensCss, ":root[data-theme='dark']", '--text'),
  darkBg: tokenValue(tokensCss, ":root[data-theme='dark']", '--bg-0'),
  darkDim: tokenValue(tokensCss, ":root[data-theme='dark']", '--text-dim'),
  tile: tokenValue(tokensCss, ':root', '--logo-tile'),
  tileInk: tokenValue(tokensCss, ':root', '--logo-tile-ink'),
};

// ---------------------------------------------------------------- svg builders

const outlines = JSON.parse(readFileSync(join(ROOT, 'scripts/brand/textOutlines.json'), 'utf8')) as Record<
  'wordmark' | 'slogan' | 'url', { d: string; width: number; cap: number }>;

const MARK = markPath();
const ADAPTIVE = `<style>svg{color:${C.lightText}}@media (prefers-color-scheme:dark){svg{color:${C.darkText}}}</style>`;
const svg = (w: number, h: number, body: string, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"${extra}>${body}</svg>\n`;

/** Knockout mark, `fill` = colour or currentColor. */
const markSvg = (fill: string, label = 'Very Happy') =>
  svg(96, 96, `${fill === 'currentColor' ? ADAPTIVE : ''}<path fill="${fill}" fill-rule="evenodd" d="${MARK}"/>`, ` role="img" aria-label="${label}"`);

const pixelSvg = (rows: readonly string[], fill: string) =>
  svg(rows.length, rows.length, `${fill === 'currentColor' ? ADAPTIVE : ''}<path fill="${fill}" d="${pixelPath(rows)}"/>`,
    ' shape-rendering="crispEdges" role="img" aria-label="Very Happy"');

/** Pixel tile for favicons: block in --logo-tile, face cells in --logo-tile-ink, corners transparent. */
const pixelTileSvg = (rows: readonly string[]) => {
  const n = rows.length;
  // Face = '.' cells that are not on the outer corners.
  const face = rows.map((row, y) => [...row].map((ch, x) => {
    const corner = (y < 2 || y >= n - 2) && (x < 2 || x >= n - 2);
    return ch === '.' && !corner ? '#' : '.';
  }).join(''));
  return svg(n, n, `<path fill="${C.tile}" d="${pixelPath(rows)}"/><path fill="${C.tileInk}" d="${pixelPath(face)}"/>`,
    ' shape-rendering="crispEdges"');
};

/**
 * App tile: the tile IS the block (no square-in-square). `radius` 0 = full bleed for
 * iOS / maskable (the OS applies its own mask); 'any'-purpose PWA icons get rounded corners.
 */
const tileSvg = (bg: string, ink: string, face: number, radius = 0) =>
  svg(96, 96, `<rect width="96" height="96"${radius ? ` rx="${radius}"` : ''} fill="${bg}"/><path fill="${ink}" d="${markFacePath(face)}"/>`,
    ' role="img" aria-label="Very Happy"');

/** Mark + outlined wordmark, 96 units tall. */
function lockupSvg(fill: string) {
  const w = outlines.wordmark;
  const x0 = 96 + 24;
  const width = Math.ceil(x0 + w.width + 2);
  const body = `${fill === 'currentColor' ? ADAPTIVE : ''}<path fill="${fill}" fill-rule="evenodd" d="${MARK}"/>`
    + `<path fill="${fill}" transform="translate(${x0} ${48 + w.cap / 2})" d="${w.d}"/>`;
  return svg(width, 96, body, ` role="img" aria-label="Very Happy"`).replace(`width="${width}" height="96"`, `width="${width / 2}" height="48"`);
}

/** 3 s loop: the cursor block types ^, _, ^, holds, clears. Reduced motion shows the final frame. */
function animatedSvg() {
  const block = markBlockPath();
  const [l, r, mouth] = markFacePath().split('Z').filter(Boolean).map(p => `${p}Z`);
  const frames = [block, block + l, block + l + mouth, block + l + r + mouth];
  // [start, end] in seconds of a 3 s loop, per frame.
  const spans: Array<Array<[number, number]>> = [[[0, 0.45], [2.6, 3]], [[0.45, 0.7]], [[0.7, 0.95]], [[0.95, 2.6]]];
  const pct = (t: number) => `${Math.round((t / 3) * 100000) / 1000}%`;
  const keyframes = spans.map((list, i) => {
    const stops = new Map<string, number>([['0%', 0]]);
    for (const [a, b] of list) { stops.set(pct(a), 1); if (b < 3) stops.set(pct(b), 0); }
    if (!stops.has('100%')) stops.set('100%', list.some(([, b]) => b === 3) ? 1 : 0);
    if (list.some(([a]) => a === 0)) stops.set('0%', 1);
    const body = [...stops].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).map(([k, v]) => `${k}{opacity:${v}}`).join('');
    return `@keyframes vhm${i}{${body}}.f${i}{animation:vhm${i} 3s steps(1,end) infinite}`;
  }).join('');
  const style = `<style>svg{color:${C.lightText}}@media (prefers-color-scheme:dark){svg{color:${C.darkText}}}`
    + `.fr{opacity:0}.fr.final{opacity:1}@media (prefers-reduced-motion:no-preference){${keyframes}}</style>`;
  const body = frames.map((d, i) => `<path class="fr f${i}${i === 3 ? ' final' : ''}" fill="currentColor" fill-rule="evenodd" d="${d}"/>`).join('');
  return svg(96, 96, style + body, ' role="img" aria-label="Very Happy"');
}

/** Link-preview card, 1200×630: lockup + slogan + URL. */
function ogSvg(theme: 'dark' | 'light', w = 1200, h = 630) {
  const bg = theme === 'dark' ? C.darkBg : C.lightBg;
  const ink = theme === 'dark' ? C.darkText : C.lightText;
  const dim = theme === 'dark' ? C.darkDim : C.lightDim;
  const tileBg = theme === 'dark' ? C.tile : C.lightText;
  const tileInk = theme === 'dark' ? C.tileInk : C.lightBg;
  const markSize = 168;
  const word = outlines.wordmark;
  const wordScale = 96 / word.cap; // cap height 96 px
  const gap = 48;
  const lockW = markSize + gap + word.width * wordScale;
  const x0 = Math.round((w - lockW) / 2);
  const y0 = Math.round(h / 2 - markSize / 2 - 48);
  const k = markSize / 96;
  const slogan = outlines.slogan;
  const sloganScale = 28 / slogan.cap;
  const url = outlines.url;
  const urlScale = 18 / url.cap;
  const body = `<rect width="${w}" height="${h}" fill="${bg}"/>`
    + `<g transform="translate(${x0} ${y0}) scale(${k})"><rect width="96" height="96" rx="20" fill="${tileBg}"/><path fill="${tileInk}" d="${markFacePath(0.84)}"/></g>`
    + `<path fill="${ink}" transform="translate(${x0 + markSize + gap} ${y0 + markSize / 2 + 48}) scale(${wordScale})" d="${word.d}"/>`
    + `<path fill="${dim}" transform="translate(${Math.round((w - slogan.width * sloganScale) / 2)} ${y0 + markSize + 96}) scale(${sloganScale})" d="${slogan.d}"/>`
    + `<path fill="${dim}" transform="translate(${Math.round((w - url.width * urlScale) / 2)} ${h - 48}) scale(${urlScale})" d="${url.d}"/>`;
  return svg(w, h, body);
}

// ---------------------------------------------------------------- outputs

const svgOut: Record<string, string> = {
  [join(PUBLIC, 'logo/very-happy-mark.svg')]: markSvg('currentColor'),
  [join(PUBLIC, 'logo/very-happy-mark-16.svg')]: pixelSvg(MARK_PIXELS_16, 'currentColor'),
  [join(PUBLIC, 'logo/very-happy-mark-32.svg')]: pixelSvg(MARK_PIXELS_32, 'currentColor'),
  [join(PUBLIC, 'logo/very-happy-lockup.svg')]: lockupSvg('currentColor'),
  [join(PUBLIC, 'logo/very-happy-mark-animated.svg')]: animatedSvg(),
  [join(PUBLIC, 'logo/very-happy-app-icon.svg')]: tileSvg(C.tile, C.tileInk, 0.84),
  [join(PUBLIC, 'logo/very-happy-app-icon-ink.svg')]: tileSvg(C.lightText, C.lightBg, 0.84),
  [join(PUBLIC, 'logo/very-happy-favicon-16.svg')]: pixelTileSvg(MARK_PIXELS_16),
  [join(PUBLIC, 'logo/very-happy-favicon-32.svg')]: pixelTileSvg(MARK_PIXELS_32),
  [join(GITHUB, 'logo-lockup-light.svg')]: lockupSvg(C.lightText),
  [join(GITHUB, 'logo-lockup-dark.svg')]: lockupSvg(C.darkText),
};

type Raster = { out: string; svg: string; size: [number, number] };
const rasters: Raster[] = [
  { out: join(PUBLIC, 'favicon.png'), svg: pixelTileSvg(MARK_PIXELS_32), size: [32, 32] },
  { out: join(PUBLIC, 'apple-touch-icon.png'), svg: tileSvg(C.tile, C.tileInk, 0.84), size: [180, 180] },
  { out: join(PUBLIC, 'icon-192.png'), svg: tileSvg(C.tile, C.tileInk, 0.84, 20), size: [192, 192] },
  { out: join(PUBLIC, 'icon-512.png'), svg: tileSvg(C.tile, C.tileInk, 0.84, 20), size: [512, 512] },
  { out: join(PUBLIC, 'icon-maskable-512.png'), svg: tileSvg(C.tile, C.tileInk, 0.72), size: [512, 512] },
  // Android notification badge: alpha-only silhouette (the OS tints it).
  { out: join(PUBLIC, 'badge-96.png'), svg: markSvg('#ffffff'), size: [96, 96] },
  { out: join(PUBLIC, 'og-image.png'), svg: ogSvg('dark'), size: [1200, 630] },
  { out: join(PUBLIC, 'og-image-light.png'), svg: ogSvg('light'), size: [1200, 630] },
  { out: join(GITHUB, 'social-preview.png'), svg: ogSvg('dark', 1280, 640), size: [1280, 640] },
];

/** ICO container with embedded PNGs (supported by every current browser). */
export function icoFromPngs(pngs: Array<{ size: number; data: Buffer }>): Buffer {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map(p => p.data)]);
}

async function main() {
  let drift = 0;
  for (const [file, content] of Object.entries(svgOut)) {
    let prev = '';
    try { prev = readFileSync(file, 'utf8'); } catch { /* new file */ }
    if (prev === content) continue;
    drift += 1;
    if (CHECK) { console.error(`drift: ${relative(ROOT, file)}`); continue; }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    console.log(`svg  ${relative(ROOT, file)}`);
  }
  if (CHECK) process.exit(drift ? 1 : 0);

  const sharp = createRequire(join(ROOT, 'packages/happy-server/package.json'))('sharp') as typeof import('sharp');
  const render = (src: string, [w, h]: [number, number]) =>
    sharp(Buffer.from(src), { density: 72 * Math.max(w / Number(src.match(/width="([\d.]+)"/)![1]), 1) * 4 })
      .resize(w, h, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
  const crisp = (src: string, size: number) =>
    sharp(Buffer.from(src), { density: 72 }).resize(size, size, { kernel: 'nearest' }).png({ compressionLevel: 9 }).toBuffer();

  for (const r of rasters) {
    // Pixel favicons stay nearest-neighbour; everything else is supersampled.
    const data = r.svg.includes('crispEdges') ? await crisp(r.svg, r.size[0]) : await render(r.svg, r.size);
    writeFileSync(r.out, data);
    console.log(`png  ${relative(ROOT, r.out)} ${r.size.join('×')}`);
  }
  const ico = icoFromPngs([
    { size: 16, data: await crisp(pixelTileSvg(MARK_PIXELS_16), 16) },
    { size: 32, data: await crisp(pixelTileSvg(MARK_PIXELS_32), 32) },
    { size: 48, data: await crisp(pixelTileSvg(MARK_PIXELS_16), 48) },
  ]);
  writeFileSync(join(PUBLIC, 'favicon.ico'), ico);
  console.log('ico  packages/happy-web-v2/public/favicon.ico 16/32/48');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
