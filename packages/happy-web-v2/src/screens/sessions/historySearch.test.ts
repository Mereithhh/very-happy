import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    findTrackedSessionId,
    historySearchSupported,
    parseHistorySearch,
    parseHistorySearchStatus,
    shouldPollHistorySearch,
    splitHighlights,
} from './historySearch';

const A = '11111111-2222-4333-8444-555555555555';
const B = '01a0637d-bfdd-7423-8da5-3eea15ca8dd7';

describe('historySearchSupported (B-549)', () => {
    it('trusts only a flag stamped by the current daemon run', () => {
        expect(historySearchSupported(undefined)).toBe(false);
        expect(historySearchSupported({ startedAt: 10 })).toBe(false); // old CLI: no flag
        expect(historySearchSupported({ startedAt: 10, historySearch: { rpcAvailable: true, detectedAt: 10 } })).toBe(true);
        // A downgraded daemon spreads the stale flag forward on connect.
        expect(historySearchSupported({ startedAt: 20, historySearch: { rpcAvailable: true, detectedAt: 10 } })).toBe(false);
        expect(historySearchSupported({ startedAt: 10, historySearch: { rpcAvailable: 'yes', detectedAt: 10 } })).toBe(false);
    });
});

describe('parseHistorySearch (B-549)', () => {
    it('keeps well-formed hits as import-ready entries and drops the rest', () => {
        const out = parseHistorySearch({
            type: 'success',
            truncated: true,
            status: { state: 'ready', filesTotal: 3, filesDone: 3, sessions: 2, textChars: 9, maxTextChars: 100, evicted: 1, lastIndexedAt: 5 },
            results: [
                { agent: 'claude', id: A.toUpperCase(), title: 'Relay', firstPrompt: 'why relay', cwd: '/w', startedAt: 1, updatedAt: 2, sizeBytes: 3, entrypoint: 'cli', gitBranch: 'main', matchCount: 2,
                  snippets: [{ role: 'user', text: 'the relay timeout', at: 4, ranges: [[4, 9], [10, 17]] }, { role: 'system', text: 'x', ranges: [] }, { role: 'assistant', text: 'ok', ranges: [[0, 99], [-1, 1], [1, 1]] }] },
                { agent: 'codex', id: B, firstPrompt: 'codex prompt', summary: 'Codex name', cwd: '/c', originator: 'codex-tui', matchCount: 1, snippets: 'nope' },
                { agent: 'claude', id: A, title: 'duplicate', firstPrompt: 'x', cwd: '/w' },
                { agent: 'gemini', id: A, firstPrompt: 'x', cwd: '/w' },
                { agent: 'claude', id: 'not-a-uuid', firstPrompt: 'x', cwd: '/w' },
                { agent: 'claude', id: A.replace('5555', '7777'), firstPrompt: 'x' }, // no cwd
                null,
            ],
        });
        expect(out.truncated).toBe(true);
        expect(out.status).toEqual({ state: 'ready', filesTotal: 3, filesDone: 3, sessions: 2, textChars: 9, maxTextChars: 100, evicted: 1, lastIndexedAt: 5 });
        expect(out.hits.map((h) => h.key)).toEqual([`claude:${A}`, `codex:${B}`]);
        expect(out.hits[0].entry).toEqual({ id: A, agent: 'claude', claudeSessionId: A, cwd: '/w', firstPrompt: 'why relay', startedAt: 1, updatedAt: 2, sizeBytes: 3, entrypoint: 'cli', gitBranch: 'main' });
        expect(out.hits[0].snippets).toEqual([
            { role: 'user', text: 'the relay timeout', at: 4, ranges: [[4, 9], [10, 17]] },
            { role: 'assistant', text: 'ok', ranges: [] },
        ]);
        expect(out.hits[1]).toMatchObject({ title: 'Codex name', entry: { agent: 'codex', codexThreadId: B, summary: 'Codex name', originator: 'codex-tui' }, snippets: [] });
    });

    it('reads garbage or an unknown state as idle — never a poll loop on a guess', () => {
        expect(parseHistorySearch(null)).toEqual({ status: parseHistorySearchStatus(undefined), hits: [], truncated: false });
        expect(parseHistorySearchStatus({ state: 'warming-up' }).state).toBe('idle');
        expect(shouldPollHistorySearch(parseHistorySearchStatus({ state: 'indexing' }))).toBe(true);
        expect(shouldPollHistorySearch(parseHistorySearchStatus({ state: 'ready' }))).toBe(false);
        expect(shouldPollHistorySearch(parseHistorySearchStatus({ state: 'error', error: 'x' }))).toBe(false);
        // Review B-549: no poll while a clear is in progress.
        expect(shouldPollHistorySearch(parseHistorySearchStatus({ state: 'indexing' }), { clearing: true })).toBe(false);
    });
});

describe('findTrackedSessionId (B-549)', () => {
    const s = (id: string, updatedAt: number, metadata: Record<string, unknown>) => ({ id, updatedAt, metadata: metadata as any });
    it('prefers the session whose own conversation it is, newest first, then an import of it', () => {
        const sessions = [
            s('imp', 9, { importedFromClaudeSessionId: A }),
            s('own-old', 1, { claudeSessionId: A.toUpperCase() }),
            s('own-new', 5, { claudeSessionId: A }),
            s('cx', 3, { codexThreadId: B }),
            s('none', 3, { claudeSessionId: B }),
            { id: 'nometa', updatedAt: 1, metadata: null },
        ];
        expect(findTrackedSessionId('claude', A, sessions)).toBe('own-new');
        expect(findTrackedSessionId('claude', A, sessions.filter((x) => !x.id.startsWith('own')))).toBe('imp');
        expect(findTrackedSessionId('codex', B, sessions)).toBe('cx');
        expect(findTrackedSessionId('codex', A, sessions)).toBeUndefined();
    });
});

describe('splitHighlights (B-549)', () => {
    it('splits into plain and marked runs', () => {
        expect(splitHighlights('the relay timeout', [[4, 9], [10, 17]])).toEqual([
            { text: 'the ', hit: false }, { text: 'relay', hit: true }, { text: ' ', hit: false }, { text: 'timeout', hit: true },
        ]);
        expect(splitHighlights('abc', [])).toEqual([{ text: 'abc', hit: false }]);
    });
});

describe('history search wiring (B-549)', () => {
    const read = (p: string) => readFileSync(join(__dirname, p), 'utf-8');
    it('the dialog gates search on the capability and shows the upgrade hint otherwise', () => {
        const modal = read('ImportHistoryModal.tsx');
        expect(modal).toContain('const searchSupported = !!machine && historySearchSupported(daemonState);');
        expect(modal).toMatch(/!searchSupported \? \(\s*<div className="ns-hint">\{t\('historySearch\.needsCli'\)\}<\/div>/);
    });
    it('the panel sends nothing and stops polling while the index is being cleared (review B-549)', () => {
        const panel = read('HistorySearchPanel.tsx').replace(/\/\/.*$/gm, '');
        const search = panel.slice(panel.indexOf('useEffect(() => {'), panel.indexOf('}, [machineId, agent, trimmed, pollTick, clearing]);'));
        const firstStatement = search.split('\n').slice(1).map((l) => l.trim()).find(Boolean);
        expect(firstStatement).toBe('if (clearing) return;');
        expect(panel).toContain('shouldPollHistorySearch(status, { clearing })');
        const clear = panel.slice(panel.indexOf('async function clearIndex()'));
        expect(clear.indexOf("setQuery('');")).toBeGreaterThan(clear.indexOf("machineHistorySearch(machineId, { op: 'clear' })"));
        expect(clear.indexOf('setClearing(true);')).toBeLessThan(clear.indexOf("machineHistorySearch(machineId, { op: 'clear' })"));
    });

    it('the RPC wrapper checks `{ error }` before reading the payload (iron rule 17)', () => {
        const ops = readFileSync(join(__dirname, '../../sync/ops.ts'), 'utf-8');
        const fn = ops.slice(ops.indexOf('export async function machineHistorySearch'));
        const body = fn.slice(0, fn.indexOf('\n}\n'));
        const guard = body.indexOf("if (typeof error === 'string' && error) return { ok: false, message: error };");
        const payload = body.indexOf('return { ok: true, ...parseHistorySearch(result) };');
        expect(guard).toBeGreaterThan(-1);
        expect(payload).toBeGreaterThan(guard);
        expect(body).toContain("'history-search'");
    });
});
