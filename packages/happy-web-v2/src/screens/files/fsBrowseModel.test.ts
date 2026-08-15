import { describe, it, expect } from 'vitest';
import type { FsEntry } from '@/sync/fsOps';
import {
    fsBreadcrumbs,
    formatFsSize,
    imageMimeOf,
    joinFsPath,
    parentFsPath,
    resolveFsSortMode,
    sortFsEntries,
    visibleFsEntries,
} from './fsBrowseModel';

const e = (name: string, type: FsEntry['type'] = 'file'): FsEntry => ({ name, type });

describe('sortFsEntries', () => {
    it('puts directories first, names sorted; symlinks sort with files', () => {
        const out = sortFsEntries([e('b'), e('link', 'symlink'), e('z', 'dir'), e('a', 'dir'), e('a')]);
        expect(out.map((x) => x.name)).toEqual(['a', 'z', 'a', 'b', 'link']);
    });

    it('does not mutate the input', () => {
        const input = [e('b'), e('a', 'dir')];
        sortFsEntries(input);
        expect(input.map((x) => x.name)).toEqual(['b', 'a']);
    });
});

describe('visibleFsEntries', () => {
    it('filters dotfiles unless showHidden', () => {
        const rows = [e('.git', 'dir'), e('src', 'dir'), e('.env')];
        expect(visibleFsEntries(rows, false).map((x) => x.name)).toEqual(['src']);
        expect(visibleFsEntries(rows, true)).toHaveLength(3);
    });
});

describe('parentFsPath / joinFsPath', () => {
    it('walks up correctly', () => {
        expect(parentFsPath('/a/b')).toBe('/a');
        expect(parentFsPath('/a')).toBe('/');
        expect(parentFsPath('/')).toBeNull();
        expect(parentFsPath('/a/b/')).toBe('/a');
    });

    it('joins without double slashes', () => {
        expect(joinFsPath('/a', 'b')).toBe('/a/b');
        expect(joinFsPath('/', 'b')).toBe('/b');
    });
});

describe('fsBreadcrumbs', () => {
    it('builds root-to-leaf crumbs', () => {
        expect(fsBreadcrumbs('/a/b')).toEqual([
            { label: '/', path: '/' },
            { label: 'a', path: '/a' },
            { label: 'b', path: '/a/b' },
        ]);
        expect(fsBreadcrumbs('/')).toEqual([{ label: '/', path: '/' }]);
    });

    it('keeps a non-absolute path (pre-normalization ~) as one crumb', () => {
        expect(fsBreadcrumbs('~')).toEqual([{ label: '~', path: '~' }]);
    });
});

describe('formatFsSize', () => {
    it('formats across magnitudes', () => {
        expect(formatFsSize(0)).toBe('0 B');
        expect(formatFsSize(512)).toBe('512 B');
        expect(formatFsSize(2048)).toBe('2.0 KB');
        expect(formatFsSize(5 * 1024 * 1024)).toBe('5.0 MB');
        expect(formatFsSize(undefined)).toBe('');
    });
});

describe('imageMimeOf', () => {
    it('maps known image extensions and rejects the rest', () => {
        expect(imageMimeOf('shot.PNG')).toBe('image/png');
        expect(imageMimeOf('photo.jpeg')).toBe('image/jpeg');
        expect(imageMimeOf('doc.txt')).toBeNull();
        expect(imageMimeOf('Makefile')).toBeNull();
    });
});

describe('sortFsEntries mtime mode (B-110)', () => {
    const e = (name: string, type: 'file' | 'dir', mtimeMs?: number) => ({ name, type, mtimeMs }) as any;

    it('keeps directories first, newest first within each group', () => {
        const out = sortFsEntries([
            e('old.txt', 'file', 1000),
            e('new.txt', 'file', 3000),
            e('zdir', 'dir', 500),
            e('adir', 'dir', 2000),
            e('mid.txt', 'file', 2000),
        ], 'mtime');
        expect(out.map((x) => x.name)).toEqual(['adir', 'zdir', 'new.txt', 'mid.txt', 'old.txt']);
    });

    it('entries without mtime sink to the bottom, ties fall back to name', () => {
        const out = sortFsEntries([
            e('b.txt', 'file'),
            e('a.txt', 'file'),
            e('c.txt', 'file', 100),
        ], 'mtime');
        expect(out.map((x) => x.name)).toEqual(['c.txt', 'a.txt', 'b.txt']);
    });

    it("default mode stays 'name' (existing call sites unchanged)", () => {
        const out = sortFsEntries([e('b.txt', 'file', 999), e('a.txt', 'file', 1)]);
        expect(out.map((x) => x.name)).toEqual(['a.txt', 'b.txt']);
    });
});

describe('resolveFsSortMode', () => {
    it('tolerates junk and defaults to mtime', () => {
        expect(resolveFsSortMode('name')).toBe('name');
        expect(resolveFsSortMode('mtime')).toBe('mtime');
        expect(resolveFsSortMode(undefined)).toBe('mtime');
        expect(resolveFsSortMode('junk')).toBe('mtime');
    });
});
