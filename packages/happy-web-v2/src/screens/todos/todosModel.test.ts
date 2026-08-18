import { describe, it, expect } from 'vitest';
import type { TodoItem } from '@/sync/todoOps';
import {
    completionReducer,
    displayStatus,
    emptyCompletion,
    groupTodoItems,
    hasOmissions,
    isCompleting,
    isFlat,
    normalizeNewTitle,
    pickTodoMachine,
    priorityRank,
    sortTodoItems,
} from './todosModel';

const item = (over: Partial<TodoItem> & { id: string }): TodoItem => ({
    title: `todo ${over.id}`,
    status: 'open',
    ...over,
});

describe('priorityRank', () => {
    it('orders high < medium < low < none', () => {
        expect(priorityRank('high')).toBeLessThan(priorityRank('medium'));
        expect(priorityRank('medium')).toBeLessThan(priorityRank('low'));
        expect(priorityRank('low')).toBeLessThan(priorityRank('none'));
    });

    it('treats a missing or unknown priority as none', () => {
        expect(priorityRank(undefined)).toBe(priorityRank('none'));
        expect(priorityRank('urgent' as never)).toBe(priorityRank('none'));
    });
});

describe('sortTodoItems', () => {
    it('puts open before done', () => {
        const out = sortTodoItems([item({ id: 'a', status: 'done' }), item({ id: 'b', status: 'open' })]);
        expect(out.map((x) => x.id)).toEqual(['b', 'a']);
    });

    it('sorts by priority, then due date, then provider order', () => {
        const out = sortTodoItems([
            item({ id: 'low' }),
            item({ id: 'high', priority: 'high' }),
            item({ id: 'high-early', priority: 'high', due: '2026-01-01' }),
            item({ id: 'mid', priority: 'medium' }),
        ]);
        expect(out.map((x) => x.id)).toEqual(['high-early', 'high', 'mid', 'low']);
    });

    it('sorts items without a due date after dated ones of the same priority', () => {
        const out = sortTodoItems([item({ id: 'none' }), item({ id: 'dated', due: '2026-08-20' })]);
        expect(out.map((x) => x.id)).toEqual(['dated', 'none']);
    });

    it('is stable for equal items (a provider that already sorts is not reshuffled)', () => {
        const out = sortTodoItems([item({ id: '1' }), item({ id: '2' }), item({ id: '3' })]);
        expect(out.map((x) => x.id)).toEqual(['1', '2', '3']);
    });

    it('does not mutate the input', () => {
        const input = [item({ id: 'a', status: 'done' }), item({ id: 'b' })];
        sortTodoItems(input);
        expect(input.map((x) => x.id)).toEqual(['a', 'b']);
    });

    it('survives items missing every optional field', () => {
        const out = sortTodoItems([{ id: 'x', title: 'x' } as TodoItem, { id: 'y', title: 'y' } as TodoItem]);
        expect(out).toHaveLength(2);
    });
});

describe('groupTodoItems', () => {
    it('returns one headerless bucket when nothing is grouped', () => {
        const groups = groupTodoItems([item({ id: 'a' }), item({ id: 'b' })]);
        expect(groups).toHaveLength(1);
        expect(groups[0].key).toBeNull();
        expect(isFlat(groups)).toBe(true);
    });

    it('returns an empty ungrouped bucket for an empty list', () => {
        const groups = groupTodoItems([]);
        expect(groups).toEqual([{ key: null, items: [] }]);
    });

    it('buckets by group and keeps the ungrouped bucket last', () => {
        const groups = groupTodoItems([
            item({ id: 'loose' }),
            item({ id: 'w1', group: 'work' }),
            item({ id: 'h1', group: 'home' }),
            item({ id: 'w2', group: 'work' }),
        ]);
        expect(groups.map((g) => g.key)).toEqual(['work', 'home', null]);
        expect(groups[0].items.map((x) => x.id)).toEqual(['w1', 'w2']);
        expect(groups[2].items.map((x) => x.id)).toEqual(['loose']);
        expect(isFlat(groups)).toBe(false);
    });

    it('orders named groups by their most urgent item', () => {
        const groups = groupTodoItems([
            item({ id: 'later', group: 'someday' }),
            item({ id: 'now', group: 'today', priority: 'high' }),
        ]);
        expect(groups.map((g) => g.key)).toEqual(['today', 'someday']);
    });

    it('treats a blank group as ungrouped', () => {
        const groups = groupTodoItems([item({ id: 'a', group: '   ' })]);
        expect(groups.map((g) => g.key)).toEqual([null]);
    });

    it('omits the ungrouped bucket entirely when every item has a group', () => {
        const groups = groupTodoItems([item({ id: 'a', group: 'work' })]);
        expect(groups.map((g) => g.key)).toEqual(['work']);
    });
});

describe('completionReducer', () => {
    it('flips an id optimistically and back on rollback', () => {
        let s = completionReducer(emptyCompletion, { type: 'begin', id: 'a' });
        expect(isCompleting(s, 'a')).toBe(true);
        s = completionReducer(s, { type: 'rollback', id: 'a' });
        expect(isCompleting(s, 'a')).toBe(false);
    });

    it('is idempotent for begin and for an unknown rollback', () => {
        const once = completionReducer(emptyCompletion, { type: 'begin', id: 'a' });
        expect(completionReducer(once, { type: 'begin', id: 'a' })).toBe(once);
        expect(completionReducer(once, { type: 'rollback', id: 'zzz' })).toBe(once);
    });

    it('clears every optimistic flag when a fresh list arrives (the provider is the truth)', () => {
        let s = completionReducer(emptyCompletion, { type: 'begin', id: 'a' });
        s = completionReducer(s, { type: 'begin', id: 'b' });
        s = completionReducer(s, { type: 'refreshed' });
        expect(s.pending).toEqual([]);
    });

    it('keeps identity when refreshing an already-empty state', () => {
        expect(completionReducer(emptyCompletion, { type: 'refreshed' })).toBe(emptyCompletion);
    });

    it('does not mutate the previous state', () => {
        const before = completionReducer(emptyCompletion, { type: 'begin', id: 'a' });
        completionReducer(before, { type: 'begin', id: 'b' });
        expect(before.pending).toEqual(['a']);
    });
});

describe('displayStatus', () => {
    it('greys a ticked item before the re-list confirms it', () => {
        const s = completionReducer(emptyCompletion, { type: 'begin', id: 'a' });
        expect(displayStatus(item({ id: 'a' }), s)).toBe('done');
        expect(displayStatus(item({ id: 'b' }), s)).toBe('open');
    });

    it('keeps a provider-reported done item done', () => {
        expect(displayStatus(item({ id: 'a', status: 'done' }), emptyCompletion)).toBe('done');
    });

    it('re-opens a rolled-back item (a failed complete must not look done)', () => {
        let s = completionReducer(emptyCompletion, { type: 'begin', id: 'a' });
        s = completionReducer(s, { type: 'rollback', id: 'a' });
        expect(displayStatus(item({ id: 'a' }), s)).toBe('open');
    });

    it('after a refresh, only the provider status counts', () => {
        let s = completionReducer(emptyCompletion, { type: 'begin', id: 'a' });
        s = completionReducer(s, { type: 'refreshed' });
        // provider still says open → the tick did NOT take, and the UI says so
        expect(displayStatus(item({ id: 'a', status: 'open' }), s)).toBe('open');
    });
});

describe('hasOmissions', () => {
    it('reports dropped entries and truncation, and nothing otherwise', () => {
        expect(hasOmissions(0, false)).toBe(false);
        expect(hasOmissions(3, false)).toBe(true);
        expect(hasOmissions(0, true)).toBe(true);
        expect(hasOmissions(Number.NaN, false)).toBe(false);
    });
});

describe('normalizeNewTitle', () => {
    it('trims and collapses whitespace', () => {
        expect(normalizeNewTitle('  write   the  report ')).toBe('write the report');
    });

    it('rejects blank drafts', () => {
        expect(normalizeNewTitle('')).toBeNull();
        expect(normalizeNewTitle('   \n\t ')).toBeNull();
    });

    it('leaves shell metacharacters alone (the RPC path is argv, never a shell)', () => {
        expect(normalizeNewTitle(`don't; rm -rf /`)).toBe(`don't; rm -rf /`);
    });
});

describe('pickTodoMachine', () => {
    const m = (id: string, active: boolean) => ({ id, active });

    it('returns null when there are no machines', () => {
        expect(pickTodoMachine([], null)).toBeNull();
        expect(pickTodoMachine([], 'gone')).toBeNull();
    });

    it('keeps the remembered machine while it still exists', () => {
        expect(pickTodoMachine([m('a', true), m('b', false)], 'b')).toBe('b');
    });

    it('falls back to the first online machine when the remembered one is gone', () => {
        expect(pickTodoMachine([m('a', false), m('b', true)], 'gone')).toBe('b');
    });

    it('falls back to the first machine when none is online', () => {
        expect(pickTodoMachine([m('a', false), m('b', false)], null)).toBe('a');
    });
});
