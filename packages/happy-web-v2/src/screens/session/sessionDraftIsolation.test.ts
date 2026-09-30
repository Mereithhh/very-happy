import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const detail = readFileSync(new URL('./SessionDetailScreen.tsx', import.meta.url), 'utf8');
const input = readFileSync(new URL('./AgentInput.tsx', import.meta.url), 'utf8');

describe('session composer draft isolation', () => {
    it('remounts the composer when the route switches sessions', () => {
        // B-516: keyed by the pending alias — the only id change without a
        // remount is a pending id -> its own real id (behaviour: pendingSessions.test.ts).
        expect(detail).toContain('key={composerKey(id, pendingSessions.aliasOf)}');
        expect(detail).toContain('sessionId={id}');
    });

    it('flushes a sub-debounce draft when that composer unmounts', () => {
        expect(input).toContain('updateSessionDraft(sessionId, draftRef.current || null)');
    });
});
