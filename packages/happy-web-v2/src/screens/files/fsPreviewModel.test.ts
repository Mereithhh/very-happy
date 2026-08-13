import { describe, it, expect } from 'vitest';
import {
    FS_PREVIEW_CHUNK_BYTES,
    FS_PREVIEW_MAX_BYTES,
    assembleFsFile,
    base64ToBytes,
    concatBytes,
    previewKindOf,
    previewMimeOf,
    type FsChunk,
    type FsChunkFailure,
} from './fsPreviewModel';

const b64 = (bytes: number[] | Uint8Array) => btoa(String.fromCharCode(...bytes));

describe('previewKindOf / previewMimeOf', () => {
    it('classifies by extension, case-insensitive', () => {
        expect(previewKindOf('/a/photo.PNG')).toBe('image');
        expect(previewKindOf('/a/anim.gif')).toBe('image');
        expect(previewKindOf('/a/vec.svg')).toBe('image');
        expect(previewKindOf('/a/README.md')).toBe('markdown');
        expect(previewKindOf('/a/notes.markdown')).toBe('markdown');
        expect(previewKindOf('/a/paper.pdf')).toBe('pdf');
        expect(previewKindOf('/a/main.ts')).toBe('text');
        expect(previewKindOf('/a/Makefile')).toBe('text');
    });

    it('only looks at the basename (dots in directories do not confuse it)', () => {
        expect(previewKindOf('/a/v1.2/binary')).toBe('text');
        expect(previewKindOf('/a.pdf/notes.md')).toBe('markdown');
    });

    it('maps kinds to render MIME', () => {
        expect(previewMimeOf('/a/paper.pdf')).toBe('application/pdf');
        expect(previewMimeOf('/a/photo.png')).toBe('image/png');
        expect(previewMimeOf('/a/vec.svg')).toBe('image/svg+xml');
        expect(previewMimeOf('/a/main.ts')).toBe('text/plain');
    });
});

describe('base64ToBytes / concatBytes', () => {
    it('round-trips bytes', () => {
        const src = [0, 1, 2, 250, 255];
        expect([...base64ToBytes(b64(src))]).toEqual(src);
        expect([...base64ToBytes('')]).toEqual([]);
    });

    it('concatenates in order', () => {
        const out = concatBytes([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])]);
        expect([...out]).toEqual([1, 2, 3]);
    });
});

/** Fake daemon serving `data` in `chunk`-sized windows; `echoOffset:false`
 *  simulates an old daemon (always serves from 0, no offset echo). */
function fakeReader(data: Uint8Array, chunk: number, { echoOffset = true } = {}) {
    const calls: number[] = [];
    const read = async (offset: number): Promise<FsChunk> => {
        calls.push(offset);
        const from = echoOffset ? offset : 0;
        const bytes = data.subarray(from, from + chunk);
        return {
            ok: true,
            size: data.length,
            truncated: from + bytes.length < data.length,
            content: b64(bytes),
            ...(echoOffset ? { offset } : {}),
        };
    };
    return { read, calls };
}

describe('assembleFsFile', () => {
    it('assembles a single-window file without needing the offset echo', async () => {
        const data = new Uint8Array([9, 8, 7]);
        const { read, calls } = fakeReader(data, 10, { echoOffset: false });
        const res = await assembleFsFile(read);
        expect(res).toMatchObject({ ok: true, size: 3 });
        if (res.ok) expect([...res.bytes]).toEqual([9, 8, 7]);
        expect(calls).toEqual([0]);
    });

    it('assembles a multi-window file in order with progress', async () => {
        const data = new Uint8Array(2500).map((_, i) => i % 251);
        const { read, calls } = fakeReader(data, 1000);
        const progress: number[] = [];
        const res = await assembleFsFile(read, { onProgress: (loaded) => progress.push(loaded) });
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.bytes.length).toBe(2500);
            expect([...res.bytes]).toEqual([...data]);
        }
        expect(calls).toEqual([0, 1000, 2000]);
        expect(progress).toEqual([1000, 2000, 2500]);
    });

    it('rejects oversized files after ONE round-trip', async () => {
        const { read, calls } = fakeReader(new Uint8Array(5000), 1000);
        const res = await assembleFsFile(read, { maxBytes: 4000 });
        expect(res).toEqual({ ok: false, code: 'too-large', size: 5000 });
        expect(calls).toEqual([0]);
    });

    it('detects an old daemon (truncated, no offset echo) as needs-upgrade', async () => {
        const { read, calls } = fakeReader(new Uint8Array(2500), 1000, { echoOffset: false });
        const res = await assembleFsFile(read);
        expect(res).toEqual({ ok: false, code: 'needs-upgrade', size: 2500 });
        expect(calls).toEqual([0]);
    });

    it('fails inconsistent when the size changes mid-assembly', async () => {
        let call = 0;
        const read = async (offset: number): Promise<FsChunk> => {
            call++;
            return { ok: true, size: call === 1 ? 2000 : 3000, truncated: true, content: b64(new Uint8Array(1000)), offset };
        };
        const res = await assembleFsFile(read);
        expect(res).toEqual({ ok: false, code: 'inconsistent' });
    });

    it('refuses to spin on truncated-but-empty responses', async () => {
        const read = async (offset: number): Promise<FsChunk> => (
            { ok: true, size: 2000, truncated: true, content: '', offset }
        );
        const res = await assembleFsFile(read);
        expect(res).toEqual({ ok: false, code: 'inconsistent' });
    });

    it('propagates chunk failures', async () => {
        const failure: FsChunkFailure = { ok: false, code: 'permission-denied', error: 'permission-denied' };
        const res = await assembleFsFile(async () => failure);
        expect(res).toEqual({ ok: false, code: 'chunk-failed', failure });
    });

    it('exports sane guardrail constants', () => {
        expect(FS_PREVIEW_CHUNK_BYTES).toBe(512 * 1024);
        expect(FS_PREVIEW_MAX_BYTES).toBeGreaterThan(FS_PREVIEW_CHUNK_BYTES);
    });
});
