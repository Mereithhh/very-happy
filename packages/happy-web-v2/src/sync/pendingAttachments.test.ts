/**
 * B-929: the files of a pending session's outbox — kept across a reload
 * (IndexedDB) and sent all-or-nothing, with a reason when they cannot go.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentSendError } from './attachmentCapabilities';
import {
    holdPendingAttachments,
    loadPendingAttachments,
    releasePendingAttachments,
    resetPendingAttachmentsForTest,
    sendPendingItem,
    sweepPendingAttachments,
    takePendingAttachments,
} from './pendingAttachments';

const blobs = new Map<string, Blob>();
const png = (id: string) => {
    const blob = new Blob([`bytes-of-${id}`], { type: 'image/png' });
    const uri = `blob:test/${id}`;
    blobs.set(uri, blob);
    return { id, uri, width: 4, height: 3, size: blob.size, name: `${id}.png`, mimeType: 'image/png' };
};
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => {
    resetPendingAttachmentsForTest();
    vi.stubGlobal('fetch', vi.fn(async (uri: string) => ({ blob: async () => blobs.get(uri)! })));
    let n = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:restored/${++n}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('pending attachments store', () => {
    it('survives a reload: memory is gone, the stored copy comes back as new Blob URLs with the same description', async () => {
        holdPendingAttachments('item-1', [png('a')]);
        await settle();
        resetPendingAttachmentsForTest(); // the page reloaded
        const back = await loadPendingAttachments('item-1');
        expect(back).toEqual([{ id: 'a', uri: 'blob:restored/1', width: 4, height: 3, size: png('a').size, name: 'a.png', mimeType: 'image/png' }]);
    });

    it('take hands them over without revoking; release revokes and forgets; sweep drops copies nobody refers to', async () => {
        const a = png('a');
        holdPendingAttachments('take-me', [a]);
        holdPendingAttachments('release-me', [png('b')]);
        holdPendingAttachments('orphan', [png('c')]);
        await settle();
        const taken = await takePendingAttachments(['take-me', 'never-held']);
        expect(taken).toEqual({ items: [a], lost: 1 });
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        releasePendingAttachments(['release-me']);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test/b');
        await settle();
        resetPendingAttachmentsForTest();
        expect(await loadPendingAttachments('take-me')).toBeNull();
        expect(await loadPendingAttachments('release-me')).toBeNull();
        resetPendingAttachmentsForTest();
        await sweepPendingAttachments(new Set(['something-else']));
        expect(await loadPendingAttachments('orphan')).toBeNull();
    });
});

describe('sendPendingItem', () => {
    const claudeNew = { flavor: 'claude', attachmentKinds: ['image/png', 'image/jpeg', 'application/pdf', '*/*'] };
    const pdf = { name: 'spec.pdf', mimeType: 'application/pdf' };
    const image = { name: 'a.png', mimeType: 'image/png' };

    it('text only goes straight through', async () => {
        const send = vi.fn(async () => 'receipt');
        await expect(sendPendingItem({ metadata: null, send, say: vi.fn() }, 'l1', undefined)).resolves.toBe('receipt');
        expect(send).toHaveBeenCalledWith();
    });

    it('sends the held files with the text (Claude, and Codex that advertises attachmentKinds)', async () => {
        const a = png('a');
        holdPendingAttachments('l2', [a]);
        for (const metadata of [claudeNew, { flavor: 'codex', attachmentKinds: claudeNew.attachmentKinds }, { flavor: 'claude' }]) {
            const send = vi.fn(async () => 'receipt');
            await sendPendingItem({ metadata, send, say: vi.fn() }, 'l2', [image]);
            expect(send).toHaveBeenCalledWith([a]);
        }
    });

    it('an agent that takes no such files: nothing is sent, the reason is said', async () => {
        holdPendingAttachments('l3', [png('a')]);
        const cases: Array<[unknown, Array<{ name: string; mimeType: string }>]> = [
            [{ flavor: 'codex' }, [image]], // an older Codex wrapper advertises nothing
            [{ flavor: 'gemini', attachmentKinds: [] }, [image]],
            [{ flavor: 'claude' }, [pdf]], // an old Claude wrapper: images only
        ];
        for (const [metadata, files] of cases) {
            const send = vi.fn();
            const say = vi.fn();
            await expect(sendPendingItem({ metadata: metadata as never, send, say }, 'l3', files)).rejects.toMatchObject({ kind: 'unsupported' });
            expect(send).not.toHaveBeenCalled();
            expect(say).toHaveBeenCalledExactlyOnceWith('unsupported');
        }
    });

    it('files that were not kept (reload without a stored copy) are never silently skipped', async () => {
        const send = vi.fn();
        const say = vi.fn();
        await expect(sendPendingItem({ metadata: claudeNew, send, say }, 'never-held', [image])).rejects.toBeInstanceOf(AttachmentSendError);
        expect(send).not.toHaveBeenCalled();
        expect(say).toHaveBeenCalledWith('lost');
    });

    it('a failed upload is said and rethrown (the store returns text + files; sending again retries)', async () => {
        holdPendingAttachments('l4', [png('a')]);
        const say = vi.fn();
        const send = vi.fn(async () => { throw new AttachmentSendError('upload-failed'); });
        await expect(sendPendingItem({ metadata: claudeNew, send, say }, 'l4', [image])).rejects.toMatchObject({ kind: 'upload-failed' });
        expect(say).toHaveBeenCalledWith('upload-failed');
        // Retry: still held, a second send works.
        const ok = vi.fn(async () => 'receipt');
        await expect(sendPendingItem({ metadata: claudeNew, send: ok, say }, 'l4', [image])).resolves.toBe('receipt');
    });
});
