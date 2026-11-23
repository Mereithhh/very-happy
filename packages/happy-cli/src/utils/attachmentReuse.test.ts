import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachmentGoneMessage, ensureRewindAttachments, parseRewindAttachments, uniqueAttachmentsByRef } from './attachmentReuse';
import { lookupMachineAttachment, recordMachineAttachment, resetAttachmentRegistryForTests } from './attachmentRegistry';

const dirs: string[] = [];
async function home(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'vh-reuse-'));
    dirs.push(dir);
    return dir;
}
afterEach(async () => {
    resetAttachmentRegistryForTests();
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('parseRewindAttachments', () => {
    it('keeps refs, drops entries without one, caps the list and de-duplicates', () => {
        const parsed = parseRewindAttachments([
            { ref: 'r1', name: 'a.png', size: 3, mimeType: 'image/png' },
            { name: 'no-ref' },
            { ref: 'r1', name: 'again.png' },
            ...Array.from({ length: 30 }, (_, i) => ({ ref: `x${i}`, name: `f${i}` })),
        ]);
        expect(parsed[0]).toEqual({ ref: 'r1', name: 'a.png', size: 3, mimeType: 'image/png' });
        expect(parsed.filter((a) => a.ref === 'r1')).toHaveLength(1);
        expect(parsed.length).toBeLessThanOrEqual(20);
        expect(parseRewindAttachments(undefined)).toEqual([]);
        expect(parseRewindAttachments('nope')).toEqual([]);
    });
});

describe('ensureRewindAttachments', () => {
    it('reuses the staged copy and never downloads it again', async () => {
        const happyHomeDir = await home();
        const path = join(happyHomeDir, 'staged.png');
        await writeFile(path, new Uint8Array([1, 2, 3]));
        await recordMachineAttachment(happyHomeDir, 's1', 'r1', { path, name: 'a.png', mimeType: 'image/png', size: 3 });
        const download = vi.fn();
        const stage = vi.fn(async () => []);
        const result = await ensureRewindAttachments({ happyHomeDir, sessionId: 's1', download, stage }, [{ ref: 'r1', name: 'a.png' }]);
        expect(result).toMatchObject({ ok: true });
        expect(download).not.toHaveBeenCalled();
        expect(stage).toHaveBeenCalledWith([expect.objectContaining({ path, ref: 'r1', name: 'a.png' })]);
    });

    it('fetches a ref the machine lost and stages it', async () => {
        const happyHomeDir = await home();
        const download = vi.fn(async () => new Uint8Array([9]));
        const stage = vi.fn(async () => [{ path: '/p/x.png', name: 'x.png', mimeType: 'image/png', size: 1 }]);
        const result = await ensureRewindAttachments({ happyHomeDir, sessionId: 's1', download, stage }, [{ ref: 'r9', name: 'x.png' }]);
        expect(result).toMatchObject({ ok: true });
        expect(download).toHaveBeenCalledWith('r9');
        expect(stage).toHaveBeenCalledWith([expect.objectContaining({ data: expect.any(Uint8Array), ref: 'r9' })]);
    });

    it('refuses (naming the file) when neither the machine nor the server has it', async () => {
        const happyHomeDir = await home();
        const download = vi.fn(async () => null);
        const result = await ensureRewindAttachments({ happyHomeDir, sessionId: 's1', download, stage: vi.fn() }, [{ ref: 'gone', name: 'lost.png' }]);
        expect(result).toEqual({ ok: false, missing: ['lost.png'] });
        expect(attachmentGoneMessage(['lost.png'])).toContain('lost.png');
    });

    it('treats a recorded path whose file was deleted as gone, then tries the blob', async () => {
        const happyHomeDir = await home();
        await recordMachineAttachment(happyHomeDir, 's1', 'r1', { path: join(happyHomeDir, 'deleted.png'), name: 'a.png', mimeType: 'image/png', size: 3 });
        expect(await lookupMachineAttachment(happyHomeDir, 's1', 'r1')).toBeNull();
        const download = vi.fn(async () => null);
        expect(await ensureRewindAttachments({ happyHomeDir, sessionId: 's1', download, stage: vi.fn() }, [{ ref: 'r1', name: 'a.png' }]))
            .toEqual({ ok: false, missing: ['a.png'] });
        expect(download).toHaveBeenCalledWith('r1');
    });
});

describe('uniqueAttachmentsByRef (B-961c)', () => {
    it('one prompt carries a ref once; attachments without a ref are kept', () => {
        const file = (name: string, ref?: string) => ({ data: new Uint8Array(0), mimeType: 'image/png', name, ...(ref ? { ref } : {}) });
        expect(uniqueAttachmentsByRef([file('red.png', 'r1'), file('red.png', 'r1'), file('blue.png', 'r2'), file('x.png'), file('x.png')]).map((f) => f.name))
            .toEqual(['red.png', 'blue.png', 'x.png', 'x.png']);
    });
});
