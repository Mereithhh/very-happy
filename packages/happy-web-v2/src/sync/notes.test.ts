import { describe, expect, it } from 'vitest';
import { noteDisplayTitle,
    NOTE_CONTENT_MAX_CHARS,
    NOTE_KV_PREFIX,
    deriveNoteTitle,
    newNoteId,
    nextActiveTab,
    noteIdFromKvKey,
    noteKvKey,
    parseNoteRecord,
    pickNoteWinner,
    pruneNoteTabs,
    sortNotes,
    type NoteRecord,
} from './notes';

function note(partial: Partial<NoteRecord> & { id: string }): NoteRecord {
    return { content: '', boundTo: null, createdAt: 1, updatedAt: 1, ...partial };
}

describe('note KV keys', () => {
    it('round-trips id ↔ key', () => {
        expect(noteIdFromKvKey(noteKvKey('abc123'))).toBe('abc123');
    });

    it('rejects foreign keys and the bare prefix', () => {
        expect(noteIdFromKvKey('vh.notif-seen.v1')).toBeNull();
        expect(noteIdFromKvKey(NOTE_KV_PREFIX)).toBeNull();
    });
});

describe('parseNoteRecord', () => {
    it('accepts a full record with a binding', () => {
        const parsed = parseNoteRecord({
            id: 'n1',
            content: 'hello',
            boundTo: { kind: 'terminal', id: 't1', machineId: 'm1', title: 'mac' },
            createdAt: 10,
            updatedAt: 20,
        });
        expect(parsed).toEqual({
            id: 'n1',
            content: 'hello',
            boundTo: { kind: 'terminal', id: 't1', machineId: 'm1', title: 'mac' },
            createdAt: 10,
            updatedAt: 20,
        });
    });

    it('rejects malformed records', () => {
        expect(parseNoteRecord(null)).toBeNull();
        expect(parseNoteRecord({ id: '', content: 'x', createdAt: 1, updatedAt: 1 })).toBeNull();
        expect(parseNoteRecord({ id: 'a', content: 5, createdAt: 1, updatedAt: 1 })).toBeNull();
        expect(parseNoteRecord({ id: 'a', content: 'x', createdAt: NaN, updatedAt: 1 })).toBeNull();
    });

    it('drops an invalid binding instead of the whole record', () => {
        const parsed = parseNoteRecord({ id: 'a', content: 'x', boundTo: { kind: 'nope' }, createdAt: 1, updatedAt: 1 });
        expect(parsed?.boundTo).toBeNull();
    });

    it('clamps oversized content defensively', () => {
        const parsed = parseNoteRecord({ id: 'a', content: 'x'.repeat(NOTE_CONTENT_MAX_CHARS + 100), createdAt: 1, updatedAt: 1 });
        expect(parsed?.content.length).toBe(NOTE_CONTENT_MAX_CHARS);
    });
});

describe('pickNoteWinner (LWW)', () => {
    it('newer updatedAt wins', () => {
        const a = note({ id: 'n', content: 'old', updatedAt: 1 });
        const b = note({ id: 'n', content: 'new', updatedAt: 2 });
        expect(pickNoteWinner(a, b).content).toBe('new');
        expect(pickNoteWinner(b, a).content).toBe('new');
    });

    it('remote wins ties (convergence to server)', () => {
        const local = note({ id: 'n', content: 'local', updatedAt: 5 });
        const remote = note({ id: 'n', content: 'remote', updatedAt: 5 });
        expect(pickNoteWinner(local, remote).content).toBe('remote');
    });
});

describe('deriveNoteTitle', () => {
    it('takes the first non-empty line', () => {
        expect(deriveNoteTitle('\n\n  refactor the parser\nmore')).toBe('refactor the parser');
    });

    it('strips markdown heading/list prefixes', () => {
        expect(deriveNoteTitle('## Plan for tomorrow')).toBe('Plan for tomorrow');
        expect(deriveNoteTitle('- first item')).toBe('first item');
    });

    it('clips long titles with an ellipsis', () => {
        const title = deriveNoteTitle('x'.repeat(100));
        expect(title.length).toBe(32);
        expect(title.endsWith('…')).toBe(true);
    });

    it('returns empty for whitespace-only content', () => {
        expect(deriveNoteTitle('  \n \n')).toBe('');
    });
});

describe('sortNotes', () => {
    it('orders by updatedAt desc, id as tiebreak, without mutating input', () => {
        const input = [note({ id: 'b', updatedAt: 1 }), note({ id: 'a', updatedAt: 1 }), note({ id: 'c', updatedAt: 9 })];
        const sorted = sortNotes(input);
        expect(sorted.map((n) => n.id)).toEqual(['c', 'a', 'b']);
        expect(input[0].id).toBe('b');
    });
});

describe('tabs helpers', () => {
    it('pruneNoteTabs drops dead ids and keeps order', () => {
        expect(pruneNoteTabs(['a', 'b', 'c'], new Set(['c', 'a']))).toEqual(['a', 'c']);
    });

    it('nextActiveTab prefers the left neighbor', () => {
        expect(nextActiveTab(['a', 'b', 'c'], 'b')).toBe('a');
        expect(nextActiveTab(['a', 'b', 'c'], 'a')).toBe('b');
        expect(nextActiveTab(['a'], 'a')).toBeNull();
        expect(nextActiveTab(['a', 'b'], 'zz')).toBe('b');
    });
});

describe('newNoteId', () => {
    it('produces 12 hex chars, unique across calls', () => {
        const a = newNoteId();
        const b = newNoteId();
        expect(a).toMatch(/^[0-9a-f]{12}$/);
        expect(a).not.toBe(b);
    });
});

describe('note meta fields (B-118/119)', () => {
    const base = { id: 'n1', content: 'first line\nrest', createdAt: 1, updatedAt: 2 };

    it('parseNoteRecord keeps title/tags/archived and clamps them', () => {
        const r = parseNoteRecord({ ...base, title: 'My Prompt', tags: ['a', '', 'b'.repeat(50)], archived: true })!;
        expect(r.title).toBe('My Prompt');
        expect(r.tags).toEqual(['a', 'b'.repeat(24)]);
        expect(r.archived).toBe(true);
    });

    it('parseNoteRecord omits absent/invalid meta (old-writer records unchanged)', () => {
        const r = parseNoteRecord(base)!;
        expect(r.title).toBeUndefined();
        expect(r.tags).toBeUndefined();
        expect(r.archived).toBeUndefined();
        const junk = parseNoteRecord({ ...base, title: '   ', tags: 'nope', archived: 'yes' })!;
        expect(junk.title).toBeUndefined();
        expect(junk.tags).toBeUndefined();
        expect(junk.archived).toBeUndefined();
    });

    it('noteDisplayTitle: explicit title wins, else first content line', () => {
        expect(noteDisplayTitle({ title: 'Short name', content: 'long first line' })).toBe('Short name');
        expect(noteDisplayTitle({ content: '# heading line\nbody' })).toBe('heading line');
        expect(noteDisplayTitle({ title: 'x'.repeat(60), content: 'y' })).toBe('x'.repeat(31) + '…');
    });
});
