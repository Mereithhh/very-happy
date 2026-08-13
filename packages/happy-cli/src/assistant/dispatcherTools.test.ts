import { describe, expect, it } from 'vitest';
import { ASSISTANT_DISALLOWED_TOOLS, withAssistantDenylist } from './dispatcherTools';

describe('withAssistantDenylist (B-063)', () => {
    it('passes normal sessions through untouched', () => {
        expect(withAssistantDenylist(undefined, false)).toBeUndefined();
        expect(withAssistantDenylist(['Bash'], false)).toEqual(['Bash']);
    });

    it('applies the full denylist to assistant sessions with no overrides', () => {
        expect(withAssistantDenylist(undefined, true)).toEqual([...ASSISTANT_DISALLOWED_TOOLS]);
    });

    it('merges extra denials but never lifts the base denylist', () => {
        const merged = withAssistantDenylist(['WebSearch'], true)!;
        expect(merged).toContain('WebSearch');
        for (const t of ASSISTANT_DISALLOWED_TOOLS) expect(merged).toContain(t);
        // an "override" repeating a base entry does not duplicate it
        expect(withAssistantDenylist(['Bash'], true)!.filter((t) => t === 'Bash')).toHaveLength(1);
    });
});
