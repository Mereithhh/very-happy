import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEB_DOWNLOAD_MAX_BYTES, checkDownloadTarget, downloadTargetVerdict, statDownloadTarget } from './downloadTarget';

describe('B-562 download target verdict', () => {
    it('refuses missing paths, directories and non-regular files without pushing', () => {
        expect(downloadTargetVerdict('/x', { kind: 'missing' }).error).toContain('does not exist');
        const dir = downloadTargetVerdict('/out', { kind: 'directory' });
        expect(dir.error).toContain('zip -r');
        expect(dir.note).toBeNull();
        expect(downloadTargetVerdict('/dev/x', { kind: 'other' }).error).toContain('not a regular file');
    });
    it('accepts files and only adds a note above the web download limit', () => {
        expect(downloadTargetVerdict('/a.zip', { kind: 'file', size: WEB_DOWNLOAD_MAX_BYTES })).toEqual({ error: null, note: null });
        const big = downloadTargetVerdict('/a.zip', { kind: 'file', size: WEB_DOWNLOAD_MAX_BYTES + 1 });
        expect(big.error).toBeNull();
        expect(big.note).toContain('50 MiB');
        expect(big.note).toContain('zip -s');
    });
});

describe('B-562 statDownloadTarget', () => {
    let dir: string;
    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'vh-dl-'));
        await writeFile(join(dir, 'a.bin'), Buffer.alloc(3));
        await mkdir(join(dir, 'sub'));
    });
    afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
    it('classifies real filesystem entries', async () => {
        expect(await statDownloadTarget(join(dir, 'a.bin'))).toEqual({ kind: 'file', size: 3 });
        expect(await statDownloadTarget(join(dir, 'sub'))).toEqual({ kind: 'directory' });
        expect(await statDownloadTarget(join(dir, 'nope'))).toEqual({ kind: 'missing' });
        expect((await checkDownloadTarget(join(dir, 'sub'))).error).toContain('directory');
    });
});
