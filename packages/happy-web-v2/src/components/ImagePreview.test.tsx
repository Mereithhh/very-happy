// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: 'en' }) }));
import { ImagePreview } from './ImagePreview';

let host: HTMLDivElement;
let root: Root;
let trigger: HTMLButtonElement;
const close = vi.fn();
const fetchImage = vi.fn();
const downloadClick = vi.fn();

function Fixture({ src = 'data:image/png;base64,aGVsbG8=' }: { src?: string }) {
    const [open, setOpen] = useState(true);
    return open ? <ImagePreview src={src} name="picture.png" onClose={() => { close(); setOpen(false); }} /> : null;
}

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchImage);
    fetchImage.mockResolvedValue({ ok: true, blob: async () => new Blob(['original-image'], { type: 'image/png' }) });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download-image');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloadClick(this.href, this.download); });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('image-preview-canvas') ? 640 : 0; });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('image-preview-canvas') ? 480 : 0; });
    host = document.createElement('div');
    trigger = document.createElement('button');
    trigger.textContent = 'Open image';
    document.body.append(trigger, host);
    trigger.focus();
    root = createRoot(host);
});

afterEach(async () => {
    vi.useRealTimers();
    await act(async () => { root.unmount(); await new Promise(resolve => setTimeout(resolve, 0)); });
    host.remove(); trigger.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function show(src?: string) {
    await act(async () => root.render(<Fixture src={src} />));
}
function dialog() { return document.querySelector<HTMLDivElement>('.image-preview')!; }
function button(name: string) {
    const found = [...dialog().querySelectorAll('button')].find(node => node.getAttribute('aria-label') === name || node.textContent === name);
    expect(found, name).toBeDefined(); return found!;
}
async function click(name: string) { await act(async () => button(name).click()); }
async function load(width = 1600, height = 800) {
    const image = dialog().querySelector('img')!;
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: width });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: height });
    await act(async () => image.dispatchEvent(new Event('load')));
    return image;
}

describe('workspace image preview', () => {
    it('opens a real modal portal, traps focus, closes with Escape and restores the trigger', async () => {
        await show(); await load();
        expect(dialog().getAttribute('role')).toBe('dialog');
        expect(dialog().getAttribute('aria-modal')).toBe('true');
        expect(host.contains(dialog())).toBe(false);
        expect(document.activeElement).toBe(dialog());
        const last = button('Original size');
        last.focus();
        // Real browser verification covers Tab wrapping; happy-dom's TreeWalker
        // incorrectly prunes FILTER_SKIP subtrees used by Radix's tabbable scan.
        await act(async () => trigger.focus());
        expect(document.activeElement).toBe(last);
        await act(async () => {
            last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            await new Promise(resolve => setTimeout(resolve, 0));
        });
        expect(close).toHaveBeenCalledOnce();
        expect(dialog()).toBeNull();
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(document.activeElement).toBe(trigger);
    });

    it('fits a large image, exposes original dimensions and zooms without changing its aspect ratio', async () => {
        await show();
        expect(dialog().textContent).toContain('Loading image');
        expect(button('Zoom in').disabled).toBe(true);
        const image = await load();
        expect(image.style.width).toBe('608px');
        expect(image.style.height).toBe('304px');
        expect(dialog().querySelector('output')?.textContent).toBe('38%');
        await click('Original size');
        expect(image.style.width).toBe('1600px');
        expect(image.style.height).toBe('800px');
        await click('Zoom in');
        expect(image.style.width).toBe('2000px');
        expect(dialog().querySelector('output')?.textContent).toBe('125%');
        await click('Zoom out');
        expect(image.style.width).toBe('1600px');
        await click('Fit image to view');
        expect(image.style.width).toBe('608px');
    });

    it('keeps failures recoverable and resets the image and scale on a new source', async () => {
        await show();
        await act(async () => dialog().querySelector('img')!.dispatchEvent(new Event('error')));
        expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('Could not load');
        await click('Retry');
        expect(dialog().textContent).toContain('Loading image');
        await load(); await click('Original size');
        await show('data:image/png;base64,bmV3');
        expect(dialog().textContent).toContain('Loading image');
        expect(button('Zoom in').disabled).toBe(true);
        const next = await load(2000, 1000);
        expect(next.style.width).toBe('608px');
        expect(button('Fit image to view').getAttribute('aria-pressed')).toBe('true');
    });

    it('downloads original bytes through a blob URL and releases it after the browser has resolved it', async () => {
        await show();
        vi.useFakeTimers();
        await click('Download image');
        expect(fetchImage).toHaveBeenCalledWith('data:image/png;base64,aGVsbG8=', { signal: expect.any(AbortSignal) });
        const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
        expect(await blob.text()).toBe('original-image');
        expect(downloadClick).toHaveBeenCalledWith('blob:download-image', 'picture.png');
        expect(document.querySelector('a[download]')).toBeNull();
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:download-image');
    });

    it('shows download failures and lets the user retry without closing the image', async () => {
        fetchImage.mockRejectedValueOnce(new Error('offline'));
        await show(); await click('Download image');
        expect(dialog().querySelector('.image-preview-error')?.textContent).toContain('Download failed');
        expect(button('Download image').disabled).toBe(false);
        expect(downloadClick).not.toHaveBeenCalled();
        vi.useFakeTimers();
        await click('Download image');
        expect(dialog().querySelector('.image-preview-error')).toBeNull();
        expect(downloadClick).toHaveBeenCalledOnce();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    });

    it('cancels a pending download on close and ignores its late completion', async () => {
        let resolve!: (value: unknown) => void;
        fetchImage.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
        await show(); await click('Download image');
        expect(button('Downloading image…').disabled).toBe(true);
        const signal = fetchImage.mock.calls[0][1].signal as AbortSignal;
        await click('Close image preview');
        expect(signal.aborted).toBe(true);
        await act(async () => resolve({ ok: true, blob: async () => new Blob(['late']) }));
        expect(downloadClick).not.toHaveBeenCalled();
        expect(dialog()).toBeNull();
    });
});
