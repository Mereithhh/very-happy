import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderStartupSplash } from '../../build/startupSplash';
import { syncThemeColorMeta } from './themeColor';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const indexHtml = read('../../index.html').replace(/<!--[\s\S]*?-->/g, '');
const tokens = read('../styles/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');

function bg0(selector: string): string {
  const block = tokens.slice(tokens.indexOf(selector));
  return block.match(/--bg-0:\s*(#[0-9a-f]{6})/i)![1].toLowerCase();
}

type Meta = { media: string | null; content: string };
function fakeDocument(metas: Meta[]) {
  return {
    documentElement: { setAttribute() {}, removeAttribute() {} },
    querySelectorAll: (selector: string) => {
      expect(selector).toBe('meta[name="theme-color"]');
      return metas.map((m) => ({
        getAttribute: (name: string) => (name === 'media' ? m.media : null),
        setAttribute: (_name: string, value: string) => { m.content = value; },
      }));
    },
  };
}
const shippedMetas = (): Meta[] => [...indexHtml.matchAll(/<meta name="theme-color"([^>]*)>/g)].map((m) => ({
  media: m[1].match(/media="([^"]+)"/)?.[1] ?? null,
  content: m[1].match(/content="([^"]+)"/)![1],
}));

afterEach(() => vi.unstubAllGlobals());

describe('B-643 iOS home-screen status bar', () => {
  it('never draws the page under the status bar (iOS 26 blurs that strip)', () => {
    const style = indexHtml.match(/<meta name="apple-mobile-web-app-status-bar-style" content="([^"]+)"/)?.[1];
    expect(style).toBe('default');
    expect(indexHtml).not.toContain('black-translucent');
  });

  it('shipped theme-color metas equal the header canvas --bg-0 of each scheme', () => {
    const dark = bg0(":root,\n:root[data-theme='dark']");
    const light = bg0(":root[data-theme='light']");
    expect(shippedMetas()).toEqual([
      { media: '(prefers-color-scheme: dark)', content: dark },
      { media: '(prefers-color-scheme: light)', content: light },
      { media: null, content: dark },
    ]);
    const metas = shippedMetas();
    vi.stubGlobal('document', fakeDocument(metas));
    syncThemeColorMeta('system');
    expect(metas.map((m) => m.content)).toEqual([dark, light, dark]);
    syncThemeColorMeta('light');
    expect(metas.map((m) => m.content)).toEqual([light, light, light]);
    syncThemeColorMeta('dark');
    expect(metas.map((m) => m.content)).toEqual([dark, dark, dark]);
  });

  it.each([['light', '#fcfcfb'], ['dark', '#151515']])('pre-paint script tints the bar for stored %s before React mounts', (stored, color) => {
    const metas = shippedMetas();
    const html = renderStartupSplash('<!-- vh-startup-style -->');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    runInNewContext(script, { localStorage: { getItem: () => stored }, document: fakeDocument(metas) });
    expect(metas.map((m) => m.content)).toEqual([color, color, color]);
  });
});
