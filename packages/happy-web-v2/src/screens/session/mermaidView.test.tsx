// @vitest-environment happy-dom
/**
 * B-890: the expand button and the ⋯ menu act on THIS diagram — copy writes its
 * source, the downloads carry its SVG — and a diagram that failed to render
 * offers neither (there is nothing to enlarge or save).
 */
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Item = { key: string; label: string; disabled?: boolean; onSelect: () => void };
const menus = vi.hoisted(() => ({ items: [] as Item[] }));
const render = vi.hoisted(() => ({ result: { ok: true, svg: '' } as { ok: boolean; svg?: string; reason?: string } }));
const png = vi.hoisted(() => vi.fn());
const FONT = vi.hoisted(() => "@font-face{font-family:'IBM Plex Sans';src:url(data:font/woff2;base64,AAAA)}");
const preview = vi.hoisted(() => ({ src: '' as string, open: 0 }));

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/ui/Menu', () => ({
    ActionDropdownMenu: ({ items, children }: { items: Item[]; children: ReactElement }) => { menus.items = items; return children; },
}));
vi.mock('@/components/ImagePreview', () => ({
    ImagePreview: ({ src, actions }: { src: string; actions?: ReactNode }) => {
        preview.src = src;
        preview.open += 1;
        return <div data-testid="preview">{actions}</div>;
    },
}));
vi.mock('./CodeView', () => ({ CodeView: ({ code }: { code: string }) => <pre data-testid="code">{code}</pre> }));
vi.mock('./mermaidRender', () => ({
    renderMermaid: async () => render.result,
    sanitizeMermaidId: (id: string) => `mmd-${id.replace(/[^a-z0-9]/gi, '')}`,
    shouldDeferMermaid: () => false,
}));
vi.mock('./mermaidExport', async (orig) => ({ ...(await orig<typeof import('./mermaidExport')>()), svgToPngBlob: png, exportFontCss: async () => FONT }));

import { MermaidView } from './MermaidView';
import { standaloneSvg } from './mermaidExport';

const CODE = 'graph TD;\nA-->B;';
const SVG = '<svg id="mmd-x" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 120px;" viewBox="0 0 120 80"><g><text>A</text></g></svg>';

let host: HTMLDivElement;
let root: Root;
const blobs = new Map<string, Blob>();
const downloads: Array<{ name: string; blob: Blob | undefined }> = [];
const writeText = vi.fn();

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    menus.items = [];
    preview.src = '';
    preview.open = 0;
    blobs.clear();
    downloads.length = 0;
    png.mockReset();
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    let n = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { const url = `blob:t/${++n}`; blobs.set(url, blob as Blob); return url; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push({ name: this.download, blob: blobs.get(this.href) });
    });
    document.documentElement.style.setProperty('--bg-1', '#171815');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
});

async function mount() {
    await act(async () => { root.render(<MermaidView code={CODE} />); });
    await act(async () => { await Promise.resolve(); });
}
const item = (key: string) => menus.items.find((i) => i.key === key)!;
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe('MermaidView actions (B-890)', () => {
    it('a rendered diagram has expand + ⋯ with copy, SVG, PNG and view source', async () => {
        render.result = { ok: true, svg: SVG };
        await mount();
        expect(button('session.chat.mermaidExpand')).not.toBeNull();
        expect(button('session.chat.mermaidMore')).not.toBeNull();
        expect(menus.items.map((i) => [i.key, !!i.disabled])).toEqual([['copy', false], ['svg', false], ['png', false], ['source', false]]);
    });

    it('copy writes exactly the diagram source and says so inline', async () => {
        render.result = { ok: true, svg: SVG };
        await mount();
        await act(async () => { item('copy').onSelect(); });
        expect(writeText).toHaveBeenCalledWith(CODE);
        expect(host.querySelector('[role="status"]')?.textContent).toBe('session.chat.mermaidCopied');
    });

    it('a refused clipboard is reported, not swallowed', async () => {
        render.result = { ok: true, svg: SVG };
        writeText.mockRejectedValue(new Error('denied'));
        await mount();
        await act(async () => { item('copy').onSelect(); });
        expect(host.querySelector('[role="status"]')?.textContent).toBe('session.chat.mermaidCopyFailed');
    });

    it('Download SVG saves this diagram as a standalone SVG with the theme background', async () => {
        render.result = { ok: true, svg: SVG };
        await mount();
        await act(async () => { item('svg').onSelect(); });
        expect(downloads.map((d) => d.name)).toEqual(['mermaid-diagram.svg']);
        const saved = await downloads[0].blob!.text();
        expect(downloads[0].blob!.type).toMatch(/^image\/svg\+xml/);
        expect(saved).toBe(standaloneSvg(SVG, '#171815', FONT)!.svg);
        expect(saved).toContain('<text>A</text>');
        expect(saved).toContain('fill="#171815"');
    });

    it('Download PNG rasterises the same standalone SVG and saves the result', async () => {
        render.result = { ok: true, svg: SVG };
        const pngBlob = new Blob(['png-bytes'], { type: 'image/png' });
        png.mockResolvedValue(pngBlob);
        await mount();
        await act(async () => { item('png').onSelect(); });
        expect(png).toHaveBeenCalledWith(standaloneSvg(SVG, '#171815', FONT), expect.any(Number));
        expect(downloads).toEqual([{ name: 'mermaid-diagram.png', blob: pngBlob }]);
    });

    it('a failed PNG export (e.g. tainted canvas) tells the user instead of failing silently', async () => {
        render.result = { ok: true, svg: SVG };
        png.mockRejectedValue(new DOMException('tainted', 'SecurityError'));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await mount();
        await act(async () => { item('png').onSelect(); });
        expect(downloads).toEqual([]);
        expect(host.querySelector('[role="status"]')?.textContent).toBe('session.chat.mermaidPngFailed');
    });

    it('expand (button or a click on the diagram) opens the viewer on this diagram’s SVG, with the same actions', async () => {
        render.result = { ok: true, svg: SVG };
        await mount();
        await act(async () => { button('session.chat.mermaidExpand')!.click(); });
        expect(host.querySelector('[data-testid="preview"]')).not.toBeNull();
        expect(await blobs.get(preview.src)!.text()).toBe(standaloneSvg(SVG, '#171815', FONT)!.svg);
        await act(async () => { button('session.chat.mermaidDownloadSvg')!.click(); });
        expect(downloads.map((d) => d.name)).toEqual(['mermaid-diagram.svg']);
        await act(async () => { button('session.chat.mermaidCopySource')!.click(); });
        expect(writeText).toHaveBeenCalledWith(CODE);
    });

    it('a click on the diagram also opens the viewer', async () => {
        render.result = { ok: true, svg: SVG };
        await mount();
        await act(async () => { host.querySelector<HTMLElement>('.mmd-svg')!.click(); });
        expect(host.querySelector('[data-testid="preview"]')).not.toBeNull();
    });

    it('view source swaps to the code block', async () => {
        render.result = { ok: true, svg: SVG };
        await mount();
        await act(async () => { item('source').onSelect(); });
        expect(host.querySelector('[data-testid="code"]')?.textContent).toBe(CODE);
        expect(button('session.chat.mermaidExpand')).toBeNull();
    });

    it.each(['syntax', 'render', 'load'])('a diagram that failed (%s) shows no expand or ⋯ — only the source', async (reason) => {
        render.result = { ok: false, reason };
        await mount();
        expect(host.querySelector('[data-testid="code"]')?.textContent).toBe(CODE);
        expect(host.querySelector('.mmd-tools')).toBeNull();
        expect(button('session.chat.mermaidExpand')).toBeNull();
        expect(button('session.chat.mermaidMore')).toBeNull();
        expect(menus.items).toEqual([]);
        expect(host.textContent).toContain('session.chat.mermaidFailed');
    });
});
