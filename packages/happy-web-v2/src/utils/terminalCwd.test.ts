import { describe, it, expect } from 'vitest';
import {
    expandHomePath,
    normalizeCwdInput,
    removePathPreset,
    upsertPathPreset,
    type PathPreset,
} from './terminalCwd';

describe('normalizeCwdInput', () => {
    it('trims surrounding whitespace', () => {
        expect(normalizeCwdInput('  ~/code/x  ')).toBe('~/code/x');
    });

    it('drops a trailing slash', () => {
        expect(normalizeCwdInput('~/code/x/')).toBe('~/code/x');
        expect(normalizeCwdInput('/srv/app///')).toBe('/srv/app');
    });

    it('keeps a bare root intact', () => {
        expect(normalizeCwdInput('/')).toBe('/');
    });

    it('collapses an all-whitespace input to empty (the create button gate)', () => {
        expect(normalizeCwdInput('   ')).toBe('');
    });
});

describe('expandHomePath', () => {
    const HOME = '/Users/demo';

    it('expands a bare tilde', () => {
        expect(expandHomePath('~', HOME)).toBe(HOME);
    });

    it('expands a tilde prefix', () => {
        expect(expandHomePath('~/code/very-happy', HOME)).toBe('/Users/demo/code/very-happy');
    });

    it('leaves absolute paths alone', () => {
        expect(expandHomePath('/srv/app', HOME)).toBe('/srv/app');
    });

    it('does not expand a tilde that is not a home reference', () => {
        // `~foo` is another user's home to a shell — we must not turn it into
        // "$HOME/foo"; leave it for the daemon to reject or resolve.
        expect(expandHomePath('~foo/bar', HOME)).toBe('~foo/bar');
    });

    it('tolerates a trailing slash on the reported home dir', () => {
        expect(expandHomePath('~/x', '/Users/demo/')).toBe('/Users/demo/x');
    });

    it('passes through untouched when the machine reports no home dir', () => {
        expect(expandHomePath('~/x', undefined)).toBe('~/x');
    });
});

describe('upsertPathPreset', () => {
    const list: PathPreset[] = [
        { id: 'a', path: '~/code/one' },
        { id: 'b', path: '~/code/two' },
    ];
    const id = () => 'new';

    it('appends a fresh path', () => {
        const res = upsertPathPreset(list, '~/code/three', null, id);
        expect(res).not.toBeNull();
        expect(res!.id).toBe('new');
        expect(res!.list.map((p) => p.path)).toEqual(['~/code/one', '~/code/two', '~/code/three']);
    });

    it('rewrites the preset being edited in place', () => {
        const res = upsertPathPreset(list, '~/code/renamed', 'a', id);
        expect(res!.id).toBe('a');
        expect(res!.list.map((p) => p.path)).toEqual(['~/code/renamed', '~/code/two']);
        expect(res!.list).toHaveLength(2);
    });

    it('normalizes before storing, so a trailing slash cannot create a twin', () => {
        expect(upsertPathPreset(list, '~/code/one/', null, id)).toBeNull();
    });

    it('refuses a duplicate path', () => {
        expect(upsertPathPreset(list, '~/code/two', null, id)).toBeNull();
    });

    it('refuses an empty path', () => {
        expect(upsertPathPreset(list, '   ', null, id)).toBeNull();
    });

    it('appends when the editing id no longer exists (preset deleted meanwhile)', () => {
        const res = upsertPathPreset(list, '~/code/four', 'gone', id);
        expect(res!.id).toBe('new');
        expect(res!.list).toHaveLength(3);
    });
});

describe('removePathPreset', () => {
    it('removes by id and leaves the rest ordered', () => {
        const list: PathPreset[] = [{ id: 'a', path: '1' }, { id: 'b', path: '2' }, { id: 'c', path: '3' }];
        expect(removePathPreset(list, 'b').map((p) => p.id)).toEqual(['a', 'c']);
    });

    it('is a no-op for an unknown id', () => {
        const list: PathPreset[] = [{ id: 'a', path: '1' }];
        expect(removePathPreset(list, 'zz')).toHaveLength(1);
    });
});
