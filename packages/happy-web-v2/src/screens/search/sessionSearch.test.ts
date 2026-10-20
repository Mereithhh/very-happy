import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import type { HistorySearchHit } from '@/screens/sessions/historySearch';
import {
    buildSnippet,
    daemonAgentFor,
    EMPTY_FILTERS,
    importableAllowed,
    machinesInScope,
    matchRanges,
    matchSessionSearchChord,
    mergeContentHits,
    parseSessionSearchQuery,
    passesFilters,
    searchLocalSessions,
    sessionSearchQueryIsEmpty,
    summarizeCoverage,
    type SessionSearchDoc,
} from './sessionSearch';
import { findJumpMessage, promptForMessage, snippetNeedle } from './chatJump';

const doc = (id: string, over: Partial<SessionSearchDoc> = {}): SessionSearchDoc => ({
    sessionId: id, title: `title ${id}`, subtitle: 'dev-sg · claude · ~/code/app', extra: '', tags: [], updatedAt: 1000, archived: false, ...over,
});
const user = (id: string, text: string, createdAt = 1): Message => ({ kind: 'user-text', id, localId: null, createdAt, text });
const agent = (id: string, text: string, createdAt = 1): Message => ({ kind: 'agent-text', id, localId: null, createdAt, text });
const hit = (id: string, over: Partial<HistorySearchHit> = {}): HistorySearchHit => ({
    key: `claude:${id}`,
    entry: { agent: 'claude', id, claudeSessionId: id, cwd: '/home/u/app', firstPrompt: 'p', startedAt: 0, updatedAt: 500, sizeBytes: 1 },
    title: `hist ${id}`, matchCount: 1,
    snippets: [{ role: 'assistant', text: '…the redis cache was flushed…', ranges: [[4, 9]] }],
    ...over,
});

describe('query + ranges', () => {
    it('lower-cases, dedups and splits #tags off', () => {
        const q = parseSessionSearchQuery('  Redis redis #ops cache ');
        expect(q.terms).toEqual(['redis', 'cache']);
        expect(q.tagQuery.tags).toEqual(['ops']);
        expect(q.text).toBe('redis cache');
        expect(sessionSearchQueryIsEmpty(parseSessionSearchQuery('  '))).toBe(true);
        expect(sessionSearchQueryIsEmpty(parseSessionSearchQuery('#'))).toBe(false);
    });
    it('merges overlapping term ranges', () => {
        expect(matchRanges('Redis-redisx', ['redis', 'isx'])).toEqual([[0, 5], [6, 12]]);
    });
    it('windows a snippet around the first match and rebases ranges', () => {
        const long = `${'a '.repeat(200)}needle ${'b '.repeat(200)}`;
        const sn = buildSnippet(long, ['needle'], 60)!;
        expect(sn.text.startsWith('…')).toBe(true);
        expect(sn.text.endsWith('…')).toBe(true);
        const [a, b] = sn.ranges[0];
        expect(sn.text.slice(a, b)).toBe('needle');
        expect(buildSnippet('nothing here', ['needle'])).toBeNull();
    });
});

describe('searchLocalSessions (sources 1 + 3)', () => {
    it('matches when every term occurs across title and cached messages', () => {
        const docs = [doc('a', { title: 'Fix redis' }), doc('b', { title: 'Other' })];
        const cached = new Map([['a', [user('m1', 'the cache layer'), agent('m2', 'done')]], ['b', [user('m3', 'cache only')]]]);
        const rows = searchLocalSessions(docs, cached, parseSessionSearchQuery('redis cache'));
        expect(rows.map((r) => r.sessionId)).toEqual(['a']);
        expect(rows[0].titleRanges).toEqual([[4, 9]]);
        expect(rows[0].snippets).toHaveLength(1);
        expect(rows[0].snippets[0]).toMatchObject({ source: 'cache', role: 'user', messageId: 'm1' });
    });
    it('caps snippets at 3, newest first, and skips thinking', () => {
        const msgs: Message[] = [1, 2, 3, 4].map((n) => agent(`m${n}`, `foo ${n}`, n));
        msgs.push({ kind: 'agent-text', id: 'think', localId: null, createdAt: 9, text: 'foo thinking', isThinking: true });
        const rows = searchLocalSessions([doc('a')], new Map([['a', msgs]]), parseSessionSearchQuery('foo'));
        expect(rows[0].snippets.map((s) => s.messageId)).toEqual(['m4', 'm3', 'm2']);
    });
    it('applies the #tag filter and searches tags / extra words', () => {
        const docs = [doc('a', { tags: ['ops'], extra: 'Payments' }), doc('b', { extra: 'Payments' })];
        expect(searchLocalSessions(docs, new Map(), parseSessionSearchQuery('#ops')).map((r) => r.sessionId)).toEqual(['a']);
        expect(searchLocalSessions(docs, new Map(), parseSessionSearchQuery('payments')).map((r) => r.sessionId)).toEqual(['a', 'b']);
    });
    it('searches sub-agent children and tool commands', () => {
        const tool: Message = {
            kind: 'tool-call', id: 't1', localId: null, createdAt: 1,
            tool: { name: 'Bash', state: 'completed', input: { command: 'kubectl rollout' }, createdAt: 1, startedAt: 1, completedAt: 1, description: null },
            children: [agent('c1', 'nested zebra')],
        };
        const rows = searchLocalSessions([doc('a')], new Map([['a', [tool]]]), parseSessionSearchQuery('zebra'));
        expect(rows[0].snippets[0].messageId).toBe('c1');
        expect(searchLocalSessions([doc('a')], new Map([['a', [tool]]]), parseSessionSearchQuery('kubectl'))[0].snippets[0].role).toBe('tool');
    });
});

describe('mergeContentHits (source 2)', () => {
    const q = parseSessionSearchQuery('redis');
    it('adds daemon snippets to a known session, deduplicated against cached ones', () => {
        const local = searchLocalSessions([doc('a')], new Map([['a', [agent('m1', 'the redis cache was flushed')]]]), q);
        const rows = mergeContentHits(local, [{ machineId: 'm', hit: hit('x'), sessionId: 'a', subtitle: '' },
            { machineId: 'm', hit: hit('y', { snippets: [{ role: 'user', text: 'redis again', ranges: [[0, 5]] }] }), sessionId: 'a', subtitle: '' }],
        new Map([['a', doc('a')]]), q, { includeImportable: true });
        expect(rows).toHaveLength(1);
        expect(rows[0].snippets.map((s) => s.source)).toEqual(['cache', 'content']);
    });
    it('creates the row for a session only the transcript matches, and skips filtered-out sessions', () => {
        const rows = mergeContentHits([], [{ machineId: 'm', hit: hit('x'), sessionId: 'a', subtitle: '' },
            { machineId: 'm', hit: hit('y'), sessionId: 'gone', subtitle: '' }], new Map([['a', doc('a')]]), q, { includeImportable: true });
        expect(rows.map((r) => r.sessionId)).toEqual(['a']);
        expect(rows[0].metaHit).toBe(false);
    });
    it('untracked hits become importable rows ranked last, unless disallowed', () => {
        const local = searchLocalSessions([doc('a', { title: 'redis', updatedAt: 1 })], new Map(), q);
        const rows = mergeContentHits(local, [{ machineId: 'm', hit: hit('x'), subtitle: 'dev-sg' }], new Map([['a', doc('a')]]), q, { includeImportable: true });
        expect(rows.map((r) => r.key)).toEqual(['s:a', 'i:m:claude:x']);
        expect(rows[1].importable?.machineId).toBe('m');
        expect(mergeContentHits(local, [{ machineId: 'm', hit: hit('x'), subtitle: '' }], new Map(), q, { includeImportable: false })).toHaveLength(1);
    });
});

describe('filters', () => {
    const base = { archived: false, waiting: false, agent: 'claude', machineId: 'm1', projectId: 'p1', updatedAt: 1000 };
    it('status / agent / machine / project / time', () => {
        expect(passesFilters(base, EMPTY_FILTERS, 1000)).toBe(true);
        expect(passesFilters(base, { ...EMPTY_FILTERS, status: 'archived' }, 1000)).toBe(false);
        expect(passesFilters({ ...base, archived: true }, { ...EMPTY_FILTERS, status: 'live' }, 1000)).toBe(false);
        expect(passesFilters(base, { ...EMPTY_FILTERS, status: 'waiting' }, 1000)).toBe(false);
        expect(passesFilters({ ...base, waiting: true }, { ...EMPTY_FILTERS, status: 'waiting' }, 1000)).toBe(true);
        expect(passesFilters(base, { ...EMPTY_FILTERS, agent: 'codex' }, 1000)).toBe(false);
        expect(passesFilters(base, { ...EMPTY_FILTERS, machineId: 'm2' }, 1000)).toBe(false);
        expect(passesFilters(base, { ...EMPTY_FILTERS, projectId: 'p2' }, 1000)).toBe(false);
        expect(passesFilters(base, { ...EMPTY_FILTERS, time: '1d' }, 1000 + 2 * 86_400_000)).toBe(false);
    });
    it('daemon agent: claude/codex pass through, other agents skip the content search', () => {
        expect(daemonAgentFor(EMPTY_FILTERS)).toBeUndefined();
        expect(daemonAgentFor({ ...EMPTY_FILTERS, agent: 'codex' })).toBe('codex');
        expect(daemonAgentFor({ ...EMPTY_FILTERS, agent: 'pi' })).toBeNull();
        expect(importableAllowed({ ...EMPTY_FILTERS, projectId: 'p' })).toBe(false);
        expect(importableAllowed({ ...EMPTY_FILTERS, status: 'archived' })).toBe(false);
    });
});

describe('coverage', () => {
    it('offline / old CLI / failed / indexing make the content results incomplete', () => {
        const s = summarizeCoverage([
            { machineId: 'a', name: 'a', state: 'searched' },
            { machineId: 'b', name: 'b', state: 'offline' },
            { machineId: 'c', name: 'c', state: 'unsupported' },
        ]);
        expect(s.offline.map((m) => m.name)).toEqual(['b']);
        expect(s.unsupported.map((m) => m.name)).toEqual(['c']);
        expect(s.incomplete).toBe(true);
        expect(summarizeCoverage([{ machineId: 'a', name: 'a', state: 'searched' }, { machineId: 'p', name: 'p', state: 'pending' }]).incomplete).toBe(false);
    });
    it('an offline machine with no sessions is out of scope', () => {
        const ms = [{ id: 'on', active: true }, { id: 'dead', active: false }, { id: 'owner', active: false }];
        expect(machinesInScope(ms, new Set(['owner'])).map((m) => m.id)).toEqual(['on', 'owner']);
    });
});

describe('⌘⇧F chord', () => {
    const k = (o: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string }>) =>
        ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, code: 'KeyF', ...o });
    it('mac: ⌘⇧F, even inside a terminal (the terminal find is ⌘F)', () => {
        expect(matchSessionSearchChord(k({ metaKey: true }), true, true)).toBe(true);
        expect(matchSessionSearchChord(k({ metaKey: true, shiftKey: false }), true, false)).toBe(false);
        expect(matchSessionSearchChord(k({ ctrlKey: true }), true, false)).toBe(false);
    });
    it('elsewhere: Ctrl+Shift+F, but not inside a terminal (its own find)', () => {
        expect(matchSessionSearchChord(k({ ctrlKey: true }), false, false)).toBe(true);
        expect(matchSessionSearchChord(k({ ctrlKey: true }), false, true)).toBe(false);
        expect(matchSessionSearchChord(k({ ctrlKey: true, code: 'KeyG' }), false, false)).toBe(false);
    });
});

describe('jump target', () => {
    const chron: Message[] = [
        user('u1', 'first question', 10), agent('a1', 'talk about redis briefly', 11),
        user('u2', 'second', 20), agent('a2', 'the redis cache was flushed at noon', 21),
        {
            kind: 'tool-call', id: 't3', localId: null, createdAt: 30,
            tool: { name: 'Task', state: 'completed', input: {}, createdAt: 30, startedAt: 30, completedAt: 31, description: null },
            children: [agent('c3', 'zebra inside a sub-agent', 31)],
        },
    ];
    it('exact message id wins; a child resolves to its top-level row', () => {
        expect(findJumpMessage(chron, { terms: ['redis'], messageId: 'a1' })).toBe('a1');
        expect(findJumpMessage(chron, { terms: ['zebra'], messageId: 'c3' })).toBe('t3');
    });
    it('a daemon snippet locates its message by content, then by time', () => {
        expect(findJumpMessage(chron, { terms: ['redis'], snippet: '…the redis cache was flushed…' })).toBe('a2');
        expect(findJumpMessage(chron, { terms: ['redis'], snippet: '…unrelated wording redis…', at: 11 })).toBe('a1');
        expect(findJumpMessage(chron, { terms: ['nothing'] })).toBeNull();
    });
    it('needle drops ellipses / markdown and keeps the first term', () => {
        expect(snippetNeedle('…use **`redis`** cache…', ['redis'])).toContain('redis');
        expect(snippetNeedle('…use **`redis`** cache…', ['redis'])).not.toContain('*');
    });
    it('prompt of the turn', () => {
        expect(promptForMessage(chron, 'a2')).toBe('u2');
        expect(promptForMessage(chron, 'u1')).toBe('u1');
    });
});
