import { describe, expect, it } from 'vitest';
import { draftDirectorySuggestions, draftProjectHint, resolveHomePath } from './draftTarget';

describe('B-801 draft target helpers', () => {
    it('resolves ~ with the machine home dir, leaves anything else alone', () => {
        expect(resolveHomePath('~/code/x', '/home/me/')).toBe('/home/me/code/x');
        expect(resolveHomePath('~', '/home/me')).toBe('/home/me');
        expect(resolveHomePath('/abs', '/home/me')).toBe('/abs');
        expect(resolveHomePath('~/x', undefined)).toBe('~/x');
    });
    it('suggests this machine\'s recent folders first, then presets, without repeats', () => {
        const recents = [{ machineId: 'm2', path: '/b' }, { machineId: 'm1', path: '/a' }, { machineId: 'm1', path: '/c' }];
        expect(draftDirectorySuggestions('m1', recents, [{ path: '/c' }, { path: '/d' }])).toEqual(['/a', '/c', '/d']);
    });
    it('says where the session lands: joined project, a folder project it will not join, or none', () => {
        expect(draftProjectHint({ name: 'Pay' }, null, true)).toBe('将加入项目「Pay」。');
        expect(draftProjectHint(undefined, { name: 'Web' }, true)).toContain('不会自动加入');
        expect(draftProjectHint(undefined, null, false)).toBe('Not in any project.');
    });
});
