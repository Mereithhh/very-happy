import { describe, expect, it } from 'vitest';
import { spawnedSessionIdOf } from './spawnedSessionId';

// B-353: assistantTools.ts session_spawn result text → link chip target.
describe('spawnedSessionIdOf', () => {
    it('reads the id from the web url, then the "Spawned session" prose, then the input sessionId', () => {
        expect(spawnedSessionIdOf('Spawned session cmtabc123456 in /w and sent the first prompt. https://veryhappy.dev/session/cmtabc123456')).toBe('cmtabc123456');
        expect(spawnedSessionIdOf('Spawned session cmtabc123456 in /w, but sending the first prompt failed (x).')).toBe('cmtabc123456');
        expect(spawnedSessionIdOf('Message delivered to session', 'cmtxyz987654')).toBe('cmtxyz987654');
        expect(spawnedSessionIdOf('Invalid sessionId', 'short')).toBeNull();
        expect(spawnedSessionIdOf('', undefined)).toBeNull();
    });
});
