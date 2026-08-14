/**
 * thinking helpers tests — B-101: collapsed-state preview + live auto-expand
 * heuristic must stay pure and predictable.
 */
import { describe, expect, it } from 'vitest';
import { isLiveThinking, stripThinkingWrapper, thinkingPreview } from './thinking';

describe('thinkingPreview', () => {
    it('returns the first non-empty line', () => {
        expect(thinkingPreview('\n\n  first real line\nsecond')).toBe('first real line');
    });

    it('truncates long lines to ~maxLen with an ellipsis', () => {
        const line = 'x'.repeat(100);
        const out = thinkingPreview(line, 60);
        expect(out).toHaveLength(60);
        expect(out!.endsWith('…')).toBe(true);
    });

    it('keeps short lines untouched', () => {
        expect(thinkingPreview('short')).toBe('short');
    });

    it('returns null for empty / whitespace-only text', () => {
        expect(thinkingPreview('')).toBeNull();
        expect(thinkingPreview('  \n \n')).toBeNull();
    });
});

describe('isLiveThinking', () => {
    const base = { sessionThinking: true, thinkingDurationMs: undefined, createdAt: 1_000_000, now: 1_010_000 };

    it('live: session thinking + no next message + recent', () => {
        expect(isLiveThinking(base)).toBe(true);
    });

    it('not live once the session stops thinking', () => {
        expect(isLiveThinking({ ...base, sessionThinking: false })).toBe(false);
    });

    it('not live when a duration exists (a next message followed)', () => {
        expect(isLiveThinking({ ...base, thinkingDurationMs: 4200 })).toBe(false);
    });

    it('not live for stale messages (batched-history createdAt ties)', () => {
        expect(isLiveThinking({ ...base, now: base.createdAt + 300_000 })).toBe(false);
    });
});

describe('stripThinkingWrapper (regression)', () => {
    it('removes the reducer *…* wrapper only', () => {
        expect(stripThinkingWrapper('*inner **bold** text*')).toBe('inner **bold** text');
        expect(stripThinkingWrapper('plain')).toBe('plain');
    });
});
