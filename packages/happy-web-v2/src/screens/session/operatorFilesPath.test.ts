import { describe, expect, it } from 'vitest';
import { isWithin, joinWithin, parentWithin } from './operatorFilesPath';

describe('B-867 operator file panel stays inside the session folder', () => {
    const root = '/home/a/proj';
    it('joins single segments only', () => {
        expect(joinWithin(root, root, 'src')).toBe('/home/a/proj/src');
        expect(joinWithin(root, '/home/a/proj/src', 'x.ts')).toBe('/home/a/proj/src/x.ts');
        expect(joinWithin(root, root, '..')).toBeNull();
        expect(joinWithin(root, root, 'a/b')).toBeNull();
        expect(joinWithin(root, root, '')).toBeNull();
    });
    it('never climbs above the root', () => {
        expect(parentWithin(root, root)).toBeNull();
        expect(parentWithin(root, '/home/a/proj/src')).toBe('/home/a/proj');
        expect(parentWithin(root, '/home/a/proj/src/deep')).toBe('/home/a/proj/src');
        expect(parentWithin(root, '/etc')).toBeNull();
    });
    it('a sibling with the same prefix is outside', () => {
        expect(isWithin(root, '/home/a/project2')).toBe(false);
        expect(isWithin(root, '/home/a/proj/../x')).toBe(false);
    });
    it('handles Windows roots', () => {
        expect(joinWithin('C:\\w\\p', 'C:\\w\\p', 'src')).toBe('C:\\w\\p\\src');
        expect(parentWithin('C:\\w\\p', 'C:\\w\\p\\src')).toBe('C:\\w\\p');
    });
});
