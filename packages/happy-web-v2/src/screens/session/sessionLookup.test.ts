import { describe, expect, it } from 'vitest';
import { sessionGate, shouldLookUpSession } from './sessionLookup';

describe('B-798 P1-8 session lookup', () => {
    const base = { dataReady: true, inStore: false, pending: false, lookup: 'idle' as const };

    it('asks the server once the list loaded and the id is still absent', () => {
        expect(shouldLookUpSession(base)).toBe(true);
    });

    it('waits for the list, skips ids it has, pending records and repeat lookups', () => {
        expect(shouldLookUpSession({ ...base, dataReady: false })).toBe(false);
        expect(shouldLookUpSession({ ...base, inStore: true })).toBe(false);
        expect(shouldLookUpSession({ ...base, pending: true })).toBe(false);
        expect(shouldLookUpSession({ ...base, lookup: 'checking' })).toBe(false);
        expect(shouldLookUpSession({ ...base, lookup: 'missing' })).toBe(false);
        expect(shouldLookUpSession({ ...base, lookup: 'failed' })).toBe(false);
    });

    it('ends the spinner only on the server answer', () => {
        expect(sessionGate({ dataReady: false, lookup: 'missing' })).toBe('loading');
        expect(sessionGate({ dataReady: true, lookup: 'idle' })).toBe('loading');
        expect(sessionGate({ dataReady: true, lookup: 'checking' })).toBe('loading');
        expect(sessionGate({ dataReady: true, lookup: 'missing' })).toBe('missing');
        expect(sessionGate({ dataReady: true, lookup: 'failed' })).toBe('failed');
    });
});
