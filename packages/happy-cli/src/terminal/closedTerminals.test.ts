import { describe, it, expect } from 'vitest';
import {
    appendClosedTerminal,
    pruneClosedAgainstLive,
    sanitizeClosedTerminals,
    CLOSED_TERMINALS_MAX,
    type ClosedTerminalRecord,
} from './closedTerminals';

const rec = (id: string, closedAt: number, extra?: Partial<ClosedTerminalRecord>): ClosedTerminalRecord => ({
    id,
    closedAt,
    ...extra,
});

describe('appendClosedTerminal', () => {
    it('prepends the newest record (newest-first order)', () => {
        const out = appendClosedTerminal([rec('a', 100)], rec('b', 200));
        expect(out.map((r) => r.id)).toEqual(['b', 'a']);
    });

    it('keeps the list ordered by closedAt even when an older record is appended late', () => {
        const out = appendClosedTerminal([rec('a', 300)], rec('b', 100));
        expect(out.map((r) => r.id)).toEqual(['a', 'b']);
    });

    it('dedupes by id — the new record replaces the old one', () => {
        const out = appendClosedTerminal(
            [rec('a', 100, { title: 'old' }), rec('b', 50)],
            rec('a', 200, { title: 'new', cwd: '/tmp' }),
        );
        expect(out).toHaveLength(2);
        expect(out[0]).toEqual({ id: 'a', closedAt: 200, title: 'new', cwd: '/tmp' });
    });

    it('caps at the max, dropping the OLDEST records', () => {
        let list: ClosedTerminalRecord[] = [];
        for (let i = 1; i <= CLOSED_TERMINALS_MAX + 5; i++) {
            list = appendClosedTerminal(list, rec(`t${i}`, i * 10));
        }
        expect(list).toHaveLength(CLOSED_TERMINALS_MAX);
        // Newest survives at the head, the 5 oldest are gone.
        expect(list[0].id).toBe(`t${CLOSED_TERMINALS_MAX + 5}`);
        expect(list.some((r) => r.id === 't5')).toBe(false);
        expect(list.some((r) => r.id === 't6')).toBe(true);
    });

    it('carries title and cwd through', () => {
        const out = appendClosedTerminal([], rec('a', 1, { title: 'build', cwd: '/repo' }));
        expect(out[0].title).toBe('build');
        expect(out[0].cwd).toBe('/repo');
    });
});

describe('pruneClosedAgainstLive', () => {
    it('drops records whose id is live again', () => {
        const list = [rec('a', 200), rec('b', 100)];
        const out = pruneClosedAgainstLive(list, new Set(['a']));
        expect(out.map((r) => r.id)).toEqual(['b']);
    });

    it('returns the SAME reference when nothing is pruned', () => {
        const list = [rec('a', 200)];
        expect(pruneClosedAgainstLive(list, new Set(['x']))).toBe(list);
        expect(pruneClosedAgainstLive(list, new Set())).toBe(list);
    });
});

describe('sanitizeClosedTerminals', () => {
    it('returns [] for non-arrays', () => {
        expect(sanitizeClosedTerminals(undefined)).toEqual([]);
        expect(sanitizeClosedTerminals(null)).toEqual([]);
        expect(sanitizeClosedTerminals({ id: 'a' })).toEqual([]);
        expect(sanitizeClosedTerminals('nope')).toEqual([]);
    });

    it('drops malformed items and keeps valid ones', () => {
        const out = sanitizeClosedTerminals([
            null,
            42,
            { id: '', closedAt: 1 },
            { id: 'ok', closedAt: 5, title: 'x', cwd: '/y' },
            { id: 'no-closedAt' },
            { id: 'bad-title', closedAt: 3, title: 7 },
        ]);
        expect(out.map((r) => r.id)).toEqual(['ok', 'bad-title']);
        expect(out[1].title).toBeUndefined();
    });

    it('dedupes by id (first occurrence wins) and sorts newest-first', () => {
        const out = sanitizeClosedTerminals([
            { id: 'a', closedAt: 100 },
            { id: 'b', closedAt: 300 },
            { id: 'a', closedAt: 999 },
        ]);
        expect(out.map((r) => r.id)).toEqual(['b', 'a']);
        expect(out[1].closedAt).toBe(100);
    });

    it('caps at the max', () => {
        const raw = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, closedAt: i }));
        expect(sanitizeClosedTerminals(raw)).toHaveLength(CLOSED_TERMINALS_MAX);
    });
});
