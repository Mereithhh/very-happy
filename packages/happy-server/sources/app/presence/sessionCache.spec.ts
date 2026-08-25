import { describe, expect, it } from 'vitest';
import { sessionActivityUpdateWhere } from './sessionCache';

describe('session activity archive boundary', () => {
    it('makes every delayed heartbeat write conditional on no archive tombstone', () => {
        expect(sessionActivityUpdateWhere('session-1')).toEqual({
            id: 'session-1',
            archivedAt: null,
        });
    });
});
