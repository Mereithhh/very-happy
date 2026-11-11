/**
 * B-929: `strictAttachments` — a pending session's first message carries ALL
 * its files or nothing: no alert, no text-only fallback, nothing queued or
 * shown before the throw (the caller hands text + files back). Drives the real
 * Sync + storage.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

const modal = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { alert: modal.alert, confirm: vi.fn() } }));

let sync: typeof import('./sync').sync;
let storage: typeof import('./storage').storage;
let AttachmentSendError: typeof import('./attachmentCapabilities').AttachmentSendError;

const SID = 'b929-session';
const file = { id: 'f1', uri: 'blob:x/1', width: 4, height: 3, size: 10, name: 'a.png', mimeType: 'image/png' };

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ sync } = await import('./sync'));
    ({ storage } = await import('./storage'));
    ({ AttachmentSendError } = await import('./attachmentCapabilities'));
});

function session(metadata: Record<string, unknown>) {
    storage.setState((state) => ({
        sessions: { ...state.sessions, [SID]: { id: SID, presence: 'online', thinking: false, active: true, metadata: { path: '/tmp/x', host: 'h', ...metadata }, agentState: null } as never },
    }));
}

beforeEach(() => {
    modal.alert.mockReset();
    (sync as unknown as { encryption: unknown }).encryption = {
        getSessionEncryption: (id: string) => (id === SID ? { encryptRawRecord: async () => 'cipher' } : null),
        getSessionBlobKey: () => null, // every upload fails
    };
});
afterEach(() => { storage.getState().deleteSession?.(SID); vi.restoreAllMocks(); });

const shown = () => storage.getState().sessionMessages[SID]?.messages ?? [];

describe('B-929 strict attachments', () => {
    it('a session that takes no files: throws `unsupported`, no alert, nothing shown', async () => {
        session({ flavor: 'gemini', attachmentKinds: [] });
        await expect(sync.sendMessage(SID, 'look', { attachments: [file], strictAttachments: true })).rejects.toMatchObject({ kind: 'unsupported' });
        expect(modal.alert).not.toHaveBeenCalled();
        expect(shown()).toHaveLength(0);
    });

    it('a failed upload: throws `upload-failed` even with text (never text alone), no alert, nothing shown', async () => {
        session({ flavor: 'claude' });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const error = await sync.sendMessage(SID, 'look', { attachments: [file], strictAttachments: true }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AttachmentSendError);
        expect((error as InstanceType<typeof AttachmentSendError>).kind).toBe('upload-failed');
        expect(modal.alert).not.toHaveBeenCalled();
        expect(shown()).toHaveLength(0);
    });

    it('without the flag the composer behaviour is unchanged (alert, text still goes)', async () => {
        session({ flavor: 'claude' });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { apiSocket } = await import('./apiSocket');
        vi.spyOn(apiSocket, 'request').mockImplementation(async (_path, init) => {
            const body = JSON.parse(String(init?.body)) as { messages: Array<{ localId: string }> };
            return new Response(JSON.stringify({ messages: body.messages.map((m, i) => ({ id: `srv-${m.localId}`, seq: 10 + i, localId: m.localId, createdAt: 1, updatedAt: 1 })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
        await expect(sync.sendMessage(SID, 'look', { attachments: [file] })).resolves.toBeTypeOf('string');
        expect(modal.alert).toHaveBeenCalledOnce();
    });
});
