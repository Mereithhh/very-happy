import { describe, expect, it } from 'vitest';
import { buildSnippet, matchRanges, MAX_QUERY_TERMS, parseQuery, searchRecords } from './query';
import type { FileRecord } from './store';
import type { IndexedMessage } from './extract';

function rec(over: Partial<FileRecord> & { msgs?: IndexedMessage[] }): FileRecord {
    const msgs = over.msgs ?? [];
    return {
        path: over.path ?? `/p/${over.id ?? 'a'}.jsonl`,
        agent: over.agent ?? 'claude',
        id: over.id ?? 'a',
        ino: 1, size: over.size ?? 100, mtimeMs: over.mtimeMs ?? 1, offset: 100,
        meta: { cwd: '/work/app', firstPrompt: 'first prompt', ...(over.meta ?? {}) },
        msgs,
        chars: msgs.reduce((n, m) => n + m.x.length, 0),
        ...(over.evicted ? { evicted: true } : {}),
    };
}

describe('parseQuery (B-549)', () => {
    it('normalises whitespace, dedupes words, caps terms, escapes regex syntax', () => {
        expect(parseQuery('   ')).toBeNull();
        expect(parseQuery(42)).toBeNull();
        const q = parseQuery('  a.b   (c)  A.B ')!;
        expect(q.raw).toBe('a.b (c) A.B');
        expect(q.terms.map((t) => t.source)).toEqual(['a\\.b', '\\(c\\)']);
        expect(q.terms[0].test('xAxB')).toBe(false);
        expect(q.terms[0].test('A.B')).toBe(true);
        expect(parseQuery(Array.from({ length: 20 }, (_, i) => `w${i}`).join(' '))!.terms).toHaveLength(MAX_QUERY_TERMS);
        expect(parseQuery('single')!.phrase).toBeNull();
    });
});

describe('snippets (B-549)', () => {
    it('windows around the first hit with ellipses and highlight ranges on the final text', () => {
        const text = `${'lead '.repeat(40)}the RELAY timeout\n\nwas fixed ${'tail '.repeat(60)}`;
        const s = buildSnippet(text, parseQuery('relay timeout')!.terms);
        expect(s.text.startsWith('…')).toBe(true);
        expect(s.text.endsWith('…')).toBe(true);
        expect(s.text).not.toContain('\n');
        const marked = s.ranges.map(([a, b]) => s.text.slice(a, b));
        expect(marked).toEqual(['RELAY', 'timeout']);
    });

    it('merges overlapping ranges and handles CJK', () => {
        expect(matchRanges('超时超时问题', parseQuery('超时 时超')!.terms)).toEqual([[0, 4]]);
    });
});

describe('searchRecords (B-549)', () => {
    const records = [
        rec({ id: 'old', mtimeMs: 1, msgs: [{ r: 'u', x: 'relay timeout again' }, { r: 'a', t: 5, x: 'the relay was slow' }] }),
        rec({ id: 'new', mtimeMs: 9, msgs: [{ r: 'u', x: 'timeout in the daemon' }, { r: 'a', x: 'relay restarted' }] }),
        rec({ id: 'other', mtimeMs: 5, msgs: [{ r: 'u', x: 'unrelated' }] }),
        rec({ id: 'cx', agent: 'codex', mtimeMs: 7, meta: { cwd: '/work/codex', firstPrompt: 'codex', originator: 'codex-tui' }, msgs: [{ r: 'u', x: 'relay timeout in codex' }] }),
        rec({ id: 'skip', mtimeMs: 10, meta: { cwd: '/x', skip: 'one-shot' }, msgs: [{ r: 'u', x: 'relay timeout' }] }),
    ];

    it('requires every word, ranks whole-phrase sessions first, then newest', () => {
        const out = searchRecords(records, parseQuery('relay timeout')!);
        expect(out.results.map((r) => r.id)).toEqual(['cx', 'old', 'new']);
        expect(out.total).toBe(3);
        const old = out.results.find((r) => r.id === 'old')!;
        expect(old).toMatchObject({ agent: 'claude', cwd: '/work/app', matchCount: 2, title: 'first prompt' });
        expect(old.snippets.map((s) => [s.role, s.text])).toEqual([['user', 'relay timeout again'], ['assistant', 'the relay was slow']]);
        expect(old.snippets[1].at).toBe(5);
    });

    it('filters by agent, honours limit/truncated, matches title and cwd, dedupes one id across files', () => {
        expect(searchRecords(records, parseQuery('relay timeout')!, { agent: 'codex' }).results.map((r) => r.id)).toEqual(['cx']);
        const limited = searchRecords(records, parseQuery('relay')!, { limit: 1 });
        expect(limited.results).toHaveLength(1);
        expect(limited.truncated).toBe(true);
        expect(searchRecords(records, parseQuery('/work/codex')!).results.map((r) => r.id)).toEqual(['cx']);

        const dup = [
            rec({ id: 'same', path: '/a/same.jsonl', mtimeMs: 1, msgs: [{ r: 'u', x: 'needle old' }] }),
            rec({ id: 'same', path: '/b/same.jsonl', mtimeMs: 2, meta: { cwd: '/b', firstPrompt: 'newer' }, msgs: [{ r: 'u', x: 'needle new' }] }),
            rec({ id: 'ev', evicted: true, meta: { cwd: '/x', firstPrompt: 'needle in title' } }),
        ];
        const out = searchRecords(dup, parseQuery('needle')!);
        expect(out.results.map((r) => [r.id, r.cwd])).toEqual([['same', '/b'], ['ev', '/x']]);
        expect(out.results[1].snippets).toEqual([]);
    });
});
