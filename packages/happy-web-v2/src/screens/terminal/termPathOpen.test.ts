import { describe, expect, it, vi } from 'vitest';
vi.mock('@/sync/fsOps', () => ({ machineFsRead: vi.fn() }));
vi.mock('@/sync/filePreviewOpen', () => ({ openFsPreview: vi.fn() }));
import { openVerifiedFile } from './termPathOpen';
import type { FsReadResult } from '@/sync/fsOps';

const ok: FsReadResult = { ok: true, path: '/r/a.ts', size: 3, binary: false, truncated: true, content: 'Y', offset: 0 };
const fail = (code: Extract<FsReadResult, { ok: false }>['code']): FsReadResult => ({ ok: false, code, error: code });

describe('openVerifiedFile (B-574①)', () => {
    it('opens through openFsPreview after a 1-byte existence read', async () => {
        const read = vi.fn(async () => ok);
        const open = vi.fn();
        expect(await openVerifiedFile({ machineId: 'm', path: '/r/a.ts' }, { read, open })).toBe('opened');
        expect(read).toHaveBeenCalledWith('m', '/r/a.ts', { maxBytes: 1 });
        expect(open).toHaveBeenCalledWith({ sessionId: undefined, machineId: 'm', path: '/r/a.ts', mode: 'file' });
    });
    it('missing file / directory: no preview, outcome for a light hint', async () => {
        const open = vi.fn();
        expect(await openVerifiedFile({ machineId: 'm', path: '/x' }, { read: async () => fail('not-found'), open })).toBe('missing');
        expect(await openVerifiedFile({ machineId: 'm', path: '/x' }, { read: async () => fail('not-a-file'), open })).toBe('directory');
        expect(open).not.toHaveBeenCalled();
    });
    it('old daemon / timeout still opens (the viewer explains the failure)', async () => {
        for (const code of ['unsupported', 'timeout', 'unknown', 'permission-denied'] as const) {
            const open = vi.fn();
            expect(await openVerifiedFile({ machineId: 'm', path: '/x' }, { read: async () => fail(code), open })).toBe('opened');
            expect(open).toHaveBeenCalledOnce();
        }
    });
});
