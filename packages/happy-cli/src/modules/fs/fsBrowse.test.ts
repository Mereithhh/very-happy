/**
 * Tests for the file-browser RPC internals: the pure helpers (fsBrowse.ts)
 * and the fs-backed fsList/fsRead cores (fsRpc.ts) against a tmp fixture.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    FS_READ_MAX_BYTES,
    clampReadLimit,
    compareFsEntries,
    entryTypeOf,
    isBinaryContent,
    normalizeFsPath,
} from './fsBrowse';
import { fsList, fsRead } from './fsRpc';

const HOME = '/home/tester';

describe('normalizeFsPath', () => {
    it('expands ~ to the home directory', () => {
        expect(normalizeFsPath('~', HOME)).toBe(HOME);
        expect(normalizeFsPath('~/code/repo', HOME)).toBe('/home/tester/code/repo');
    });

    it('keeps absolute paths and normalizes . / .. segments', () => {
        expect(normalizeFsPath('/a/b/../c/./d', HOME)).toBe('/a/c/d');
        expect(normalizeFsPath('/a/b/', HOME)).toBe('/a/b');
    });

    it('resolves relative paths against home (foolproofing)', () => {
        expect(normalizeFsPath('code/repo', HOME)).toBe('/home/tester/code/repo');
    });

    it('rejects empty / non-string / NUL input', () => {
        expect(() => normalizeFsPath('', HOME)).toThrow('invalid-path');
        expect(() => normalizeFsPath('   ', HOME)).toThrow('invalid-path');
        expect(() => normalizeFsPath(undefined, HOME)).toThrow('invalid-path');
        expect(() => normalizeFsPath(42 as unknown as string, HOME)).toThrow('invalid-path');
        expect(() => normalizeFsPath('/a/\0b', HOME)).toThrow('invalid-path');
    });

    it('does not treat ~user or mid-string ~ as home', () => {
        expect(normalizeFsPath('~other/x', HOME)).toBe('/home/tester/~other/x');
        expect(normalizeFsPath('/a/~/b', HOME)).toBe('/a/~/b');
    });
});

describe('isBinaryContent', () => {
    it('detects NUL within the sniff window', () => {
        expect(isBinaryContent(new Uint8Array([104, 105, 0, 33]))).toBe(true);
    });

    it('treats plain text (incl. UTF-8) as text', () => {
        expect(isBinaryContent(new TextEncoder().encode('hello 世界\n'))).toBe(false);
        expect(isBinaryContent(new Uint8Array(0))).toBe(false);
    });

    it('ignores NUL beyond the 8KB sniff window', () => {
        const bytes = new Uint8Array(9000).fill(97);
        bytes[8500] = 0;
        expect(isBinaryContent(bytes)).toBe(false);
        const inWindow = new Uint8Array(9000).fill(97);
        inWindow[8191] = 0;
        expect(isBinaryContent(inWindow)).toBe(true);
    });
});

describe('compareFsEntries', () => {
    it('sorts directories first, then by name; symlinks sort with files', () => {
        const rows = [
            { name: 'b.txt', type: 'file' as const },
            { name: 'link', type: 'symlink' as const },
            { name: 'zdir', type: 'dir' as const },
            { name: 'adir', type: 'dir' as const },
            { name: 'a.txt', type: 'file' as const },
        ];
        expect([...rows].sort(compareFsEntries).map((r) => r.name)).toEqual([
            'adir', 'zdir', 'a.txt', 'b.txt', 'link',
        ]);
    });
});

describe('clampReadLimit', () => {
    it('defaults and clamps to FS_READ_MAX_BYTES', () => {
        expect(clampReadLimit(undefined)).toBe(FS_READ_MAX_BYTES);
        expect(clampReadLimit(-5)).toBe(FS_READ_MAX_BYTES);
        expect(clampReadLimit(Number.NaN)).toBe(FS_READ_MAX_BYTES);
        expect(clampReadLimit(10 * 1024 * 1024)).toBe(FS_READ_MAX_BYTES);
        expect(clampReadLimit(1024)).toBe(1024);
        expect(clampReadLimit(1024.9)).toBe(1024);
    });
});

describe('entryTypeOf', () => {
    it('maps symlink > dir > file', () => {
        expect(entryTypeOf({ isSymbolicLink: () => true, isDirectory: () => false })).toBe('symlink');
        expect(entryTypeOf({ isSymbolicLink: () => false, isDirectory: () => true })).toBe('dir');
        expect(entryTypeOf({ isSymbolicLink: () => false, isDirectory: () => false })).toBe('file');
    });
});

describe('fsList / fsRead (tmp fixture)', () => {
    let root: string;

    beforeAll(() => {
        root = join(tmpdir(), `fs-rpc-test-${Date.now()}`);
        mkdirSync(join(root, 'sub'), { recursive: true });
        writeFileSync(join(root, 'hello.txt'), 'hello world\n');
        writeFileSync(join(root, '.hidden'), 'secret\n');
        writeFileSync(join(root, 'blob.bin'), Buffer.from([1, 2, 0, 4, 5]));
        writeFileSync(join(root, 'big.txt'), 'x'.repeat(4096));
        symlinkSync(join(root, 'hello.txt'), join(root, 'lnk'));
        return () => rmSync(root, { recursive: true, force: true });
    });

    it('lists a directory: normalized path, dirs first, hidden included, symlink typed', async () => {
        const res = await fsList(root);
        expect(res.path).toBe(root);
        expect(res.truncated).toBe(false);
        expect(res.entries.map((e) => e.name)).toEqual(['sub', '.hidden', 'big.txt', 'blob.bin', 'hello.txt', 'lnk']);
        const byName = Object.fromEntries(res.entries.map((e) => [e.name, e]));
        expect(byName['sub'].type).toBe('dir');
        expect(byName['lnk'].type).toBe('symlink');
        expect(byName['hello.txt'].type).toBe('file');
        expect(byName['hello.txt'].size).toBe(12);
        expect(typeof byName['hello.txt'].mtimeMs).toBe('number');
    });

    it('fs-list errors: not-found / not-a-directory', async () => {
        await expect(fsList(join(root, 'nope'))).rejects.toThrow('not-found');
        await expect(fsList(join(root, 'hello.txt'))).rejects.toThrow('not-a-directory');
    });

    it('reads a text file fully (base64) with truncated=false', async () => {
        const res = await fsRead(join(root, 'hello.txt'));
        expect(res.binary).toBe(false);
        expect(res.truncated).toBe(false);
        expect(res.size).toBe(12);
        expect(Buffer.from(res.content!, 'base64').toString('utf8')).toBe('hello world\n');
    });

    it('caps reads at maxBytes and reports truncated + full size', async () => {
        const res = await fsRead(join(root, 'big.txt'), { maxBytes: 1000 });
        expect(res.truncated).toBe(true);
        expect(res.size).toBe(4096);
        expect(Buffer.from(res.content!, 'base64').length).toBe(1000);
    });

    it('reports binary files without content', async () => {
        const res = await fsRead(join(root, 'blob.bin'));
        expect(res.binary).toBe(true);
        expect(res.size).toBe(5);
        expect(res.content).toBeUndefined();
    });

    it('returns binary content when allowBinary (image preview path)', async () => {
        const res = await fsRead(join(root, 'blob.bin'), { allowBinary: true });
        expect(res.binary).toBe(true);
        expect(res.truncated).toBe(false);
        expect(Buffer.from(res.content!, 'base64')).toEqual(Buffer.from([1, 2, 0, 4, 5]));
    });

    it('follows symlinks on read', async () => {
        const res = await fsRead(join(root, 'lnk'));
        expect(Buffer.from(res.content!, 'base64').toString('utf8')).toBe('hello world\n');
    });

    it('fs-read errors: not-found / not-a-file (directory)', async () => {
        await expect(fsRead(join(root, 'nope'))).rejects.toThrow('not-found');
        await expect(fsRead(join(root, 'sub'))).rejects.toThrow('not-a-file');
    });
});
