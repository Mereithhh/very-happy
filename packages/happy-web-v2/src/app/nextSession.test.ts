import { describe, it, expect } from 'vitest';
import { pickNextSessionId } from './nextSession';
import type { Session } from '@/sync/storageTypes';

const s = (id: string, over: Partial<Session> = {}): Session => ({
    id,
    active: true,
    activeAt: 0,
    updatedAt: 0,
    metadata: null,
    ...over,
}) as unknown as Session;

describe('pickNextSessionId (B-111)', () => {
    it('picks the most recently active other session', () => {
        const out = pickNextSessionId([
            s('closed', { activeAt: 999 }),
            s('older', { activeAt: 100 }),
            s('newest', { activeAt: 300 }),
        ], 'closed');
        expect(out).toBe('newest');
    });

    it('never lands on archived or hidden sessions', () => {
        const out = pickNextSessionId([
            s('archived', { active: false, activeAt: 900 }),
            s('mirror', { activeAt: 800, metadata: { flavor: 'terminal-mirror' } as never }),
            s('assistant', { activeAt: 700, metadata: { variant: 'assistant' } as never }),
            s('plain', { activeAt: 10 }),
        ], 'closed');
        expect(out).toBe('plain');
    });

    it('returns null when nothing else is left (caller falls back to /)', () => {
        expect(pickNextSessionId([s('closed')], 'closed')).toBeNull();
        expect(pickNextSessionId([], 'closed')).toBeNull();
    });
});
