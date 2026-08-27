import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const detail = readFileSync(new URL('./SessionDetailScreen.tsx', import.meta.url), 'utf8');
const input = readFileSync(new URL('./AgentInput.tsx', import.meta.url), 'utf8');

describe('session composer draft isolation', () => {
    it('remounts the composer when the route switches sessions', () => {
        expect(detail).toContain('<AgentInput key={id} sessionId={id} />');
    });

    it('flushes a sub-debounce draft when that composer unmounts', () => {
        expect(input).toContain('updateSessionDraft(sessionId, draftRef.current || null)');
    });
});
