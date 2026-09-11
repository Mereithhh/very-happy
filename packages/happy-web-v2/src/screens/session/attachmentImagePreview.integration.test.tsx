// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentPreview } from '@/sync/attachmentTypes';

const mocks = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('@/sync/sync', () => ({ sync: { downloadAttachment: mocks.download } }));
// The modal's own keyboard/focus/zoom behaviour is covered by ImagePreview tests.
// These tests exercise the actual attachment triggers and cache ownership.
vi.mock('@/components/ImagePreview', () => ({
    ImagePreview: ({ src, name, onClose }: { src: string; name: string; onClose: () => void }) => (
        <div role="dialog" aria-label={name} data-src={src}>
            <button type="button" aria-label="Close preview" onClick={onClose}>Close</button>
        </div>
    ),
}));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({
    t: (key: string, args?: { name?: string }) => args?.name ? `${key}: ${args.name}` : key,
}) }));

import { ComposerAttachments } from './ComposerAttachments';
import { UserAttachments, type AttachmentItem } from './UserAttachments';
import { acquireAttachmentUrl, ATTACHMENT_PREVIEW_MAX_ENTRIES, attachmentPreviewCacheSize, cachedAttachmentUrl, forgetAttachmentUrl, loadAttachmentUrl, resetAttachmentPreviewCache } from './attachmentPreview';

const draft: AttachmentPreview = { id: 'draft-image', name: 'draft.png', uri: 'blob:owned-by-composer', width: 640, height: 480, mimeType: 'image/png', size: 100 };
const historical: AttachmentItem = { key: 'sent-image', name: 'sent.png', mimeType: 'image/png', size: 100, ref: 'file-ref' };
let host: HTMLDivElement;
let root: Root;
let urlSequence = 0;
let revoke: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetAttachmentPreviewCache();
    vi.clearAllMocks();
    mocks.download.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:download-${++urlSequence}`);
    revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    resetAttachmentPreviewCache();
    host.remove();
    vi.restoreAllMocks();
});

async function click(selector: string) {
    const button = host.querySelector<HTMLButtonElement>(selector);
    expect(button, `button ${selector}`).not.toBeNull();
    await act(async () => { button!.click(); });
}

async function renderHistory() {
    await act(async () => { root.render(<UserAttachments sessionId="session" items={[historical]} />); });
    const thumb = host.querySelector<HTMLImageElement>('.ua-thumb img');
    expect(thumb).not.toBeNull();
    return thumb!.src;
}

describe('composer image preview integration', () => {
    it('opens an in-app preview and closes it without deleting or revoking the draft', async () => {
        const remove = vi.fn();
        act(() => root.render(<ComposerAttachments attachments={[draft]} onRemove={remove} />));
        await click('.ci-att-preview');
        expect(host.querySelector('[role="dialog"]')?.getAttribute('data-src')).toBe(draft.uri);
        expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(draft.name);
        await click('[aria-label="Close preview"]');
        expect(host.querySelector('[role="dialog"]')).toBeNull();
        expect(host.querySelector<HTMLImageElement>('.ci-att-img')?.src).toBe(draft.uri);
        expect(remove).not.toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalled();
        expect(mocks.download).not.toHaveBeenCalled();
    });

    it('deletes through the remove button without triggering a preview', async () => {
        const remove = vi.fn();
        function DraftOwner() {
            const [attachments, setAttachments] = useState([draft]);
            return <ComposerAttachments attachments={attachments} onRemove={id => {
                remove(id);
                setAttachments(items => items.filter(item => item.id !== id));
            }} />;
        }
        act(() => root.render(<DraftOwner />));
        await click('.ci-att-remove');
        expect(remove).toHaveBeenCalledExactlyOnceWith(draft.id);
        expect(host.querySelector('[role="dialog"]')).toBeNull();
        expect(host.querySelector('.ci-att')).toBeNull();
        expect(revoke).not.toHaveBeenCalled();
    });

    it('drops the preview when its draft is removed by the owner without taking URL ownership', async () => {
        const remove = vi.fn();
        act(() => root.render(<ComposerAttachments attachments={[draft]} onRemove={remove} />));
        await click('.ci-att-preview');
        act(() => root.render(<ComposerAttachments attachments={[]} onRemove={remove} />));
        expect(host.querySelector('[role="dialog"]')).toBeNull();
        expect(remove).not.toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalled();
    });

    it('keeps a non-image attachment as a file item without an image preview trigger', () => {
        act(() => root.render(<ComposerAttachments attachments={[{ ...draft, name: 'report.pdf', width: 0, height: 0, mimeType: 'application/pdf' }]} onRemove={vi.fn()} />));
        expect(host.querySelector('.ci-att-preview')).toBeNull();
        expect(host.querySelector('.ci-att-file')?.textContent).toBe('report.pdf');
        expect(host.querySelector('.ci-att-remove')).not.toBeNull();
    });
});

describe('historical image preview integration', () => {
    it('opens a ref-backed image inside the app instead of a new tab and leaves the thumbnail intact on close', async () => {
        const url = await renderHistory();
        expect(host.querySelector('.ua-thumb')?.tagName).toBe('BUTTON');
        expect(host.querySelector('a[target="_blank"]')).toBeNull();
        expect(host.querySelector('.ua-thumb')?.getAttribute('href')).toBeNull();
        await click('.ua-thumb');
        expect(host.querySelector('[role="dialog"]')?.getAttribute('data-src')).toBe(url);
        expect(mocks.download).toHaveBeenCalledExactlyOnceWith('session', historical.ref);
        await click('[aria-label="Close preview"]');
        expect(host.querySelector('[role="dialog"]')).toBeNull();
        expect(host.querySelector<HTMLImageElement>('.ua-thumb img')?.src).toBe(url);
        expect(cachedAttachmentUrl('session', historical.ref!)).toBe(url);
        expect(revoke).not.toHaveBeenCalledWith(url);
    });

    it('holds a forgotten URL while previewing and releases that lease on close', async () => {
        const url = await renderHistory();
        await click('.ua-thumb');
        forgetAttachmentUrl('session', historical.ref!);
        expect(revoke).not.toHaveBeenCalledWith(url);
        expect(host.querySelector('[role="dialog"]')?.getAttribute('data-src')).toBe(url);
        await click('[aria-label="Close preview"]');
        expect(revoke).toHaveBeenCalledExactlyOnceWith(url);
    });

    it('releases the preview lease when leaving the transcript', async () => {
        const url = await renderHistory();
        await click('.ua-thumb');
        forgetAttachmentUrl('session', historical.ref!);
        expect(revoke).not.toHaveBeenCalledWith(url);
        act(() => root.render(null));
        expect(revoke).toHaveBeenCalledExactlyOnceWith(url);
        expect(host.querySelector('[role="dialog"]')).toBeNull();
    });

    it('reloads an evicted thumbnail URL before opening the full-size preview', async () => {
        const oldUrl = await renderHistory();
        forgetAttachmentUrl('session', historical.ref!);
        expect(revoke).toHaveBeenCalledWith(oldUrl);
        await click('.ua-thumb');
        const freshUrl = host.querySelector('[role="dialog"]')?.getAttribute('data-src');
        expect(freshUrl).toBeTruthy();
        expect(freshUrl).not.toBe(oldUrl);
        expect(revoke).not.toHaveBeenCalledWith(freshUrl);
        expect(mocks.download).toHaveBeenCalledTimes(2);
    });

    it('does not open or retain a late preview download after leaving the transcript', async () => {
        await renderHistory();
        forgetAttachmentUrl('session', historical.ref!);
        let finish!: (bytes: Uint8Array) => void;
        mocks.download.mockImplementationOnce(() => new Promise<Uint8Array>(resolve => { finish = resolve; }));
        await click('.ua-thumb');
        act(() => root.render(null));
        await act(async () => { finish(new Uint8Array([4, 5, 6])); });
        const lateUrl = cachedAttachmentUrl('session', historical.ref!);
        expect(lateUrl).toBeTruthy();
        expect(host.querySelector('[role="dialog"]')).toBeNull();
        forgetAttachmentUrl('session', historical.ref!);
        expect(revoke).toHaveBeenCalledWith(lateUrl);
    });

    it('releases a superseded preview attempt when the same thumbnail is clicked twice during loading', async () => {
        await renderHistory();
        forgetAttachmentUrl('session', historical.ref!);
        let finish!: (bytes: Uint8Array) => void;
        mocks.download.mockImplementationOnce(() => new Promise<Uint8Array>(resolve => { finish = resolve; }));
        await click('.ua-thumb');
        await click('.ua-thumb');
        await act(async () => { finish(new Uint8Array([7, 8, 9])); });
        const url = host.querySelector('[role="dialog"]')?.getAttribute('data-src');
        expect(url).toBeTruthy();
        expect(mocks.download).toHaveBeenCalledTimes(2);
        forgetAttachmentUrl('session', historical.ref!);
        expect(revoke).not.toHaveBeenCalledWith(url);
        await click('[aria-label="Close preview"]');
        expect(revoke.mock.calls.filter(([revoked]) => revoked === url)).toHaveLength(1);
    });

    it('keeps manifest-only images as file rows because there is no downloadable ref', async () => {
        await act(async () => root.render(<UserAttachments sessionId="session" items={[{ ...historical, ref: null }]} />));
        expect(host.querySelector('.ua-file-name')?.textContent).toBe(historical.name);
        expect(host.querySelector('.ua-thumb')).toBeNull();
        expect(mocks.download).not.toHaveBeenCalled();
    });
});

describe('full-size preview cache leases', () => {
    it('protects an acquired preview while more than a cache of concurrent thumbnails finish', async () => {
        const preview = acquireAttachmentUrl('session', 'preview', 'image/png');
        const thumbnails = Array.from({ length: ATTACHMENT_PREVIEW_MAX_ENTRIES + 1 }, (_, index) =>
            loadAttachmentUrl('session', `thumbnail-${index}`, 'image/png'));
        const [lease] = await Promise.all([preview, ...thumbnails]);
        expect(lease).not.toBeNull();
        // Only the first Promise returns a lease; the rest return thumbnail URLs.
        if (!lease || typeof lease === 'string') throw new Error('Expected a preview lease');
        expect(revoke).not.toHaveBeenCalledWith(lease.url);
        forgetAttachmentUrl('session', 'preview');
        expect(revoke).not.toHaveBeenCalledWith(lease.url);
        lease.release();
        expect(revoke).toHaveBeenCalledWith(lease.url);
    });

    it('does not return a revoked URL when every existing cache entry has an open preview', async () => {
        const leases: NonNullable<Awaited<ReturnType<typeof acquireAttachmentUrl>>>[] = [];
        try {
            for (let index = 0; index <= ATTACHMENT_PREVIEW_MAX_ENTRIES; index++) {
                const lease = await acquireAttachmentUrl('session', `open-${index}`, 'image/png');
                expect(lease).not.toBeNull();
                leases.push(lease!);
            }
            expect(attachmentPreviewCacheSize()).toBe(ATTACHMENT_PREVIEW_MAX_ENTRIES + 1);
            expect(revoke).not.toHaveBeenCalled();
            leases[0].release();
            expect(revoke).toHaveBeenCalledExactlyOnceWith(leases[0].url);
            expect(attachmentPreviewCacheSize()).toBe(ATTACHMENT_PREVIEW_MAX_ENTRIES);
            expect(revoke).not.toHaveBeenCalledWith(leases.at(-1)!.url);
        } finally {
            leases.forEach(lease => lease.release());
        }
    });

    it('shares a concurrent download and releases a forgotten URL only after both previews close', async () => {
        const [first, second] = await Promise.all([
            acquireAttachmentUrl('session', 'shared', 'image/png'),
            acquireAttachmentUrl('session', 'shared', 'image/png'),
        ]);
        expect(first?.url).toBe(second?.url);
        expect(mocks.download).toHaveBeenCalledExactlyOnceWith('session', 'shared');
        if (!first || !second) throw new Error('Expected both preview leases');
        forgetAttachmentUrl('session', 'shared');
        first.release();
        first.release();
        expect(revoke).not.toHaveBeenCalledWith(first.url);
        second.release();
        second.release();
        expect(revoke).toHaveBeenCalledExactlyOnceWith(first.url);
    });

    it('does not leave a failed preview key pinned in subsequent thumbnail cache use', async () => {
        mocks.download.mockResolvedValueOnce(null);
        expect(await acquireAttachmentUrl('session', 'retry', 'image/png')).toBeNull();
        const url = await loadAttachmentUrl('session', 'retry', 'image/png');
        for (let index = 0; index < ATTACHMENT_PREVIEW_MAX_ENTRIES; index++) {
            await loadAttachmentUrl('session', `next-${index}`, 'image/png');
        }
        expect(cachedAttachmentUrl('session', 'retry')).toBeNull();
        expect(revoke).toHaveBeenCalledWith(url);
    });
});
