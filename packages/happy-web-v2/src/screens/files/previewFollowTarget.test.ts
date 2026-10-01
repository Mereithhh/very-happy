import { describe, expect, it } from 'vitest';
import { previewFollowTarget } from './previewPinTarget';

const known = (id: string) => id === 's1';
const push = { sessionId: 's1', machineId: 'm', path: '/a.md', mode: 'file' as const, fromPush: true };

describe('B-526 a pushed preview follows its session', () => {
    it('navigates to the source session from anywhere else', () => {
        expect(previewFollowTarget(push, '/session/s2', known)).toBe('/session/s1');
        expect(previewFollowTarget(push, '/board', known)).toBe('/session/s1');
    });
    it('stays when already there, when the user opened it, or when the session is unknown', () => {
        expect(previewFollowTarget(push, '/session/s1', known)).toBeNull();
        expect(previewFollowTarget({ ...push, fromPush: false }, '/board', known)).toBeNull();
        expect(previewFollowTarget({ ...push, sessionId: 'gone' }, '/board', known)).toBeNull();
        expect(previewFollowTarget({ ...push, sessionId: undefined }, '/board', known)).toBeNull();
    });
});
