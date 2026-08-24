import { mkdtemp, readFile, readdir, rm, utimes } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import {
    createUploadFileHandlers,
    MAX_USER_UPLOAD_BYTES,
    MAX_USER_UPLOAD_CHUNK_BYTES,
} from './uploadFileHandler';
import { encodeBase64, encrypt, getRandomBytes } from '../../api/encryption';

const homes: string[] = [];

async function makeHandlers(now?: () => number) {
    const home = await mkdtemp(join(tmpdir(), 'very-happy-upload-'));
    homes.push(home);
    return { home, ...createUploadFileHandlers(home, now, 'posix') };
}

afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('user upload handlers', () => {
    it('keeps a maximum chunk below the relay envelope cap after encryption', () => {
        const request = {
            action: 'append',
            uploadId: 'upload_envelope_test',
            offset: 0,
            content: Buffer.alloc(MAX_USER_UPLOAD_CHUNK_BYTES, 0x61).toString('base64'),
        } as const;
        const key = getRandomBytes(32);
        for (const variant of ['legacy', 'dataKey'] as const) {
            const params = encodeBase64(encrypt(key, variant, request));
            const wireBytes = Buffer.byteLength(JSON.stringify({ method: 'm'.repeat(128), params }));
            expect(wireBytes).toBeLessThan(256 * 1024);
        }
    });

    it('sanitizes the legacy destination and rejects oversized payloads', async () => {
        const { home, uploadFile } = await makeHandlers();
        const ok = await uploadFile({ name: '../../screen shot.png', subdir: '../terminal', content: Buffer.from('hello').toString('base64') });
        expect(ok).toMatchObject({ success: true, pathQuoteStyle: 'posix', size: 5 });
        expect(dirname(ok.path!)).toBe(join(home, 'uploads', '.._terminal'));
        expect(basename(ok.path!)).toMatch(/^screen_shot-[0-9a-f]{12}\.png$/);
        expect(await readFile(ok.path!, 'utf8')).toBe('hello');

        const dotDot = await uploadFile({ name: '..', subdir: '..', content: Buffer.from('contained').toString('base64') });
        expect(dotDot).toMatchObject({ success: true, size: 9 });
        expect(dirname(dotDot.path!)).toBe(join(home, 'uploads', 'misc'));
        expect(basename(dotDot.path!)).toMatch(/^file-[0-9a-f]{12}$/);
        expect(await readFile(dotDot.path!, 'utf8')).toBe('contained');
        expect(await readdir(join(home, 'uploads', 'misc'))).toEqual([basename(dotDot.path!)]);

        const tooLarge = Buffer.alloc(MAX_USER_UPLOAD_BYTES + 1).toString('base64');
        await expect(uploadFile({ name: 'large.bin', content: tooLarge })).resolves.toMatchObject({ success: false });
    });

    it('writes ordered chunks atomically and returns the final absolute path', async () => {
        const { home, uploadFileChunk } = await makeHandlers();
        const uploadId = 'upload_12345678';
        const bytes = Buffer.concat([Buffer.alloc(MAX_USER_UPLOAD_CHUNK_BYTES, 0x61), Buffer.from('tail')]);
        expect(await uploadFileChunk({ action: 'start', uploadId, name: 'paste image.png', subdir: 'terminal', totalSize: bytes.length })).toMatchObject({ success: true });

        const dir = join(home, 'uploads', 'terminal');
        expect(await readdir(dir)).toEqual([expect.stringMatching(/^\.paste_image\.png\..+\.part$/)]);
        expect(await uploadFileChunk({ action: 'append', uploadId, offset: 0, content: bytes.subarray(0, MAX_USER_UPLOAD_CHUNK_BYTES).toString('base64') })).toMatchObject({ success: true, size: MAX_USER_UPLOAD_CHUNK_BYTES });
        expect(await uploadFileChunk({ action: 'append', uploadId, offset: MAX_USER_UPLOAD_CHUNK_BYTES, content: bytes.subarray(MAX_USER_UPLOAD_CHUNK_BYTES).toString('base64') })).toMatchObject({ success: true, size: bytes.length });

        const done = await uploadFileChunk({ action: 'finish', uploadId });
        expect(done).toMatchObject({ success: true, size: bytes.length });
        expect(dirname(done.path!)).toBe(dir);
        expect(basename(done.path!)).toMatch(/^paste_image-[0-9a-f]{12}\.png$/);
        expect(await readFile(done.path!)).toEqual(bytes);
        expect(await readdir(dir)).toEqual([basename(done.path!)]);
    });

    it('rejects out-of-order, over-limit, and incomplete uploads', async () => {
        const { uploadFileChunk } = await makeHandlers();
        expect(await uploadFileChunk({ action: 'start', uploadId: 'short', name: 'x', totalSize: 1 })).toMatchObject({ success: false, error: 'Invalid upload id' });
        expect(await uploadFileChunk({ action: 'start', uploadId: 'upload_too_large', name: 'x', totalSize: MAX_USER_UPLOAD_BYTES + 1 })).toMatchObject({ success: false, error: expect.stringContaining('8 MB') });

        const uploadId = 'upload_order_test';
        expect(await uploadFileChunk({ action: 'start', uploadId, name: 'x', totalSize: 2 })).toMatchObject({ success: true });
        expect(await uploadFileChunk({ action: 'append', uploadId, offset: 1, content: Buffer.from('x').toString('base64') })).toMatchObject({ success: false, error: 'Upload chunk is out of order' });
        expect(await uploadFileChunk({ action: 'finish', uploadId })).toMatchObject({ success: false, error: 'Upload is incomplete' });
    });

    it('rejects non-canonical base64 and decoded chunks over the per-call limit', async () => {
        const { uploadFileChunk } = await makeHandlers();
        expect(await uploadFileChunk({ action: 'start', uploadId: 'upload_invalid_b64', name: 'x', totalSize: 1 })).toMatchObject({ success: true });
        expect(await uploadFileChunk({ action: 'append', uploadId: 'upload_invalid_b64', offset: 0, content: '!!!!' })).toMatchObject({ success: false, error: 'Invalid upload payload' });
        expect(await uploadFileChunk({ action: 'append', uploadId: 'upload_invalid_b64', offset: 0, content: 'YR==' })).toMatchObject({ success: false, error: 'Invalid upload payload' });

        expect(await uploadFileChunk({ action: 'start', uploadId: 'upload_large_chunk', name: 'y', totalSize: MAX_USER_UPLOAD_CHUNK_BYTES + 1 })).toMatchObject({ success: true });
        expect(await uploadFileChunk({
            action: 'append',
            uploadId: 'upload_large_chunk',
            offset: 0,
            content: Buffer.alloc(MAX_USER_UPLOAD_CHUNK_BYTES + 1).toString('base64'),
        })).toMatchObject({ success: false, error: 'Invalid upload payload' });
    });

    it('removes aborted and expired staging files', async () => {
        let clock = 1_000;
        const { home, uploadFileChunk } = await makeHandlers(() => clock);
        expect(await uploadFileChunk({ action: 'start', uploadId: 'upload_abort_1', name: 'a.png', totalSize: 1 })).toMatchObject({ success: true });
        expect(await uploadFileChunk({ action: 'abort', uploadId: 'upload_abort_1' })).toMatchObject({ success: true });
        expect(await uploadFileChunk({ action: 'abort', uploadId: 'upload_abort_1' })).toMatchObject({ success: true, size: 0 });
        expect(await readdir(join(home, 'uploads', 'misc'))).toEqual([]);

        expect(await uploadFileChunk({ action: 'start', uploadId: 'upload_expire_1', name: 'b.png', totalSize: 1 })).toMatchObject({ success: true });
        clock += 11 * 60 * 1000;
        expect(await uploadFileChunk({ action: 'start', uploadId: 'upload_expire_2', name: 'c.png', totalSize: 0 })).toMatchObject({ success: true });
        expect(await readdir(join(home, 'uploads', 'misc'))).toEqual([expect.stringContaining('upload_expire_2')]);
    });

    it('reclaims stale staging files left by a daemon restart', async () => {
        const { home, uploadFileChunk } = await makeHandlers();
        expect(await uploadFileChunk({ action: 'start', uploadId: 'upload_before_restart', name: 'old.png', totalSize: 1 })).toMatchObject({ success: true });
        const dir = join(home, 'uploads', 'misc');
        const [stale] = await readdir(dir);
        await utimes(join(dir, stale), new Date(0), new Date(0));

        const restarted = createUploadFileHandlers(home);
        expect(await restarted.uploadFileChunk({ action: 'start', uploadId: 'upload_after_restart', name: 'new.png', totalSize: 0 })).toMatchObject({ success: true });
        expect(await readdir(dir)).toEqual([expect.stringContaining('upload_after_restart')]);
    });

    it('serializes concurrent starts and appends around active/offset checks', async () => {
        const { uploadFileChunk } = await makeHandlers();
        const starts = await Promise.all(Array.from({ length: 9 }, (_, index) => uploadFileChunk({
            action: 'start' as const,
            uploadId: `upload_parallel_${index}`,
            name: `${index}.bin`,
            totalSize: 1,
        })));
        expect(starts.filter((result) => result.success)).toHaveLength(8);
        expect(starts.filter((result) => !result.success)).toEqual([
            expect.objectContaining({ error: 'Too many active uploads' }),
        ]);

        const firstId = 'upload_parallel_0';
        const chunk = Buffer.from('x').toString('base64');
        const appends = await Promise.all([
            uploadFileChunk({ action: 'append', uploadId: firstId, offset: 0, content: chunk }),
            uploadFileChunk({ action: 'append', uploadId: firstId, offset: 0, content: chunk }),
        ]);
        expect(appends.filter((result) => result.success)).toHaveLength(1);
        expect(appends.filter((result) => !result.success)).toEqual([
            expect.objectContaining({ error: 'Upload chunk is out of order' }),
        ]);
        await expect(uploadFileChunk({ action: 'finish', uploadId: firstId })).resolves.toMatchObject({ success: true, size: 1 });
    });
});
