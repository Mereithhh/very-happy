// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/sync/storage', () => ({
    storage: { getState: () => ({ localSettings: { filePreviewReceive: true }, sessions: { s1: { metadata: { machineId: 'm1' } } } }) },
}));
vi.mock('@/ui/Toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { handleFilePreviewPush } from './filePreviewPush';
import { onFsPreviewOpen, type FsPreviewRequest } from './filePreviewOpen';

const encryption = { getSessionEncryption: () => ({ decryptRaw: async () => '/repo/out.zip' }), getMachineEncryption: () => null } as never;

describe('B-562 file-preview-push intent', () => {
    let off: (() => void) | null = null;
    afterEach(() => { off?.(); off = null; });
    const receive = async (extra: Record<string, unknown>) => {
        const seen: FsPreviewRequest[] = [];
        off = onFsPreviewOpen(r => seen.push(r));
        await handleFilePreviewPush(encryption, { sourceType: 'session', sessionId: 's1', payload: 'cipher', enc: true, mode: 'file', ...extra });
        off(); off = null;
        return seen;
    };
    it('carries the download intent to the preview request', async () => {
        expect(await receive({ intent: 'download' })).toEqual([
            { sessionId: 's1', machineId: 'm1', path: '/repo/out.zip', mode: 'file', fromPush: true, intent: 'download' },
        ]);
    });
    it('opens a plain preview for absent or unknown intents (old server / future CLI)', async () => {
        for (const extra of [{}, { intent: 'future' }, { intent: 7 }]) {
            const [request] = await receive(extra);
            expect(request.path).toBe('/repo/out.zip');
            expect('intent' in request).toBe(false);
        }
    });
});
