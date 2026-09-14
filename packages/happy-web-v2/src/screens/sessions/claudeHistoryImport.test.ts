import { describe, expect, it } from 'vitest';
import {
    filterImportableHistory,
    orderSelectionForImport,
    pruneImportSelection,
    summarizeImportRun,
    toggleImportSelection,
    formatHistorySize,
    historyEntrypointLabel,
    historyEntryTitle,
    parseClaudeHistory,
    parseCodexHistory,
    codexSourceLabel,
    historySourceLabel,
    shortenCwd,
    trackedClaudeSessionIds,
    trackedCodexThreadIds,
    trackedHistoryIds,
    type ClaudeHistoryEntry,
} from './claudeHistoryImport';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function claude(id: string, rest: Omit<ClaudeHistoryEntry, 'id' | 'agent' | 'claudeSessionId'>): ClaudeHistoryEntry {
    return { id, agent: 'claude', claudeSessionId: id, ...rest };
}

describe('B-290 / B-464 history import helpers', () => {
    it('parses only well-formed rows from the RPC payload', () => {
        const rows = parseClaudeHistory({
            type: 'success',
            entries: [
                { claudeSessionId: A.toUpperCase(), cwd: '/w/app', firstPrompt: 'fix it', updatedAt: 10, startedAt: 5, sizeBytes: 100, entrypoint: 'cli', gitBranch: 'main' },
                { claudeSessionId: B, cwd: '/w/app', firstPrompt: '', summary: 'Titled', updatedAt: 20 },
                { claudeSessionId: 'nope', cwd: '/w/app', firstPrompt: 'x' },
                { claudeSessionId: C, cwd: '', firstPrompt: 'x' },
                { claudeSessionId: C, cwd: '/w', firstPrompt: '' },
                null,
                'junk',
            ],
        });
        expect(rows).toEqual([
            { id: A, agent: 'claude', claudeSessionId: A, cwd: '/w/app', firstPrompt: 'fix it', startedAt: 5, updatedAt: 10, sizeBytes: 100, entrypoint: 'cli', gitBranch: 'main' },
            { id: B, agent: 'claude', claudeSessionId: B, cwd: '/w/app', firstPrompt: 'Titled', summary: 'Titled', startedAt: 0, updatedAt: 20, sizeBytes: 0 },
        ]);
        expect(parseClaudeHistory(null)).toEqual([]);
        expect(parseClaudeHistory({ error: 'boom' })).toEqual([]);
    });

    it('collects tracked ids from own and imported-from metadata', () => {
        const ids = trackedClaudeSessionIds([
            { metadata: { claudeSessionId: A.toUpperCase() } } as any,
            { metadata: { claudeSessionId: B, importedFromClaudeSessionId: C } } as any,
            { metadata: { claudeSessionId: 'bad' } } as any,
            { metadata: null } as any,
        ]);
        expect(ids.sort()).toEqual([A, B, C].sort());
    });

    it('B-464 parses codex-list-history rows and tracks own thread + import origin', () => {
        const rows = parseCodexHistory({
            type: 'success',
            entries: [
                { codexThreadId: A.toUpperCase(), cwd: '/w/app', firstPrompt: 'fix it', updatedAt: 10, startedAt: 5, sizeBytes: 100, entrypoint: 'cli', originator: 'codex-tui', gitBranch: 'main', version: '0.154.0' },
                { codexThreadId: B, cwd: '/w/app', firstPrompt: '', summary: 'Named', updatedAt: 20 },
                { codexThreadId: 'nope', cwd: '/w/app', firstPrompt: 'x' },
                { claudeSessionId: C, cwd: '/w/app', firstPrompt: 'wrong shape' },
                null,
            ],
        });
        expect(rows).toEqual([
            { id: A, agent: 'codex', codexThreadId: A, cwd: '/w/app', firstPrompt: 'fix it', startedAt: 5, updatedAt: 10, sizeBytes: 100, entrypoint: 'cli', originator: 'codex-tui', gitBranch: 'main', version: '0.154.0' },
            { id: B, agent: 'codex', codexThreadId: B, cwd: '/w/app', firstPrompt: 'Named', summary: 'Named', startedAt: 0, updatedAt: 20, sizeBytes: 0 },
        ]);
        expect(parseCodexHistory({ error: 'boom' })).toEqual([]);

        const ids = trackedCodexThreadIds([
            { metadata: { codexThreadId: A.toUpperCase() } } as any,
            { metadata: { codexThreadId: B, importedFromCodexThreadId: C } } as any,
            { metadata: { claudeSessionId: A } } as any,
            { metadata: null } as any,
        ]);
        expect(ids.sort()).toEqual([A, B, C].sort());
        expect(trackedHistoryIds('codex', [{ metadata: { codexThreadId: A } } as any])).toEqual([A]);
        expect(trackedHistoryIds('claude', [{ metadata: { codexThreadId: A } } as any])).toEqual([]);

        expect(codexSourceLabel({ originator: 'codex-tui' })).toBe('codex CLI');
        expect(codexSourceLabel({ originator: 'codex_exec', entrypoint: 'exec' })).toBe('codex exec');
        expect(codexSourceLabel({ originator: 'Codex Desktop', entrypoint: 'vscode' })).toBe('Codex Desktop');
        expect(codexSourceLabel({ originator: 'my-tool' })).toBe('my-tool');
        expect(codexSourceLabel({ entrypoint: 'vscode' })).toBe('Codex app');
        expect(codexSourceLabel({ entrypoint: 'cli' })).toBe('codex CLI');
        expect(codexSourceLabel({})).toBeUndefined();
        expect(historySourceLabel(rows[0])).toBe('codex CLI');
        expect(historySourceLabel(claude(A, { cwd: '/w', firstPrompt: 'p', startedAt: 0, updatedAt: 0, sizeBytes: 0, entrypoint: 'remote_mobile' }))).toBe('claude.ai');
    });

    it('hides tracked conversations, searches, and sorts newest first', () => {
        const entries = [
            claude(A, { cwd: '/w/app', firstPrompt: 'fix login', startedAt: 0, updatedAt: 1, sizeBytes: 1 }),
            claude(B, { cwd: '/w/docs', firstPrompt: 'write docs', summary: 'Docs pass', startedAt: 0, updatedAt: 3, sizeBytes: 1, gitBranch: 'feat/x' }),
            claude(C, { cwd: '/w/app', firstPrompt: 'tracked', startedAt: 0, updatedAt: 2, sizeBytes: 1 }),
        ];
        expect(filterImportableHistory(entries, [C.toUpperCase()]).map((e) => e.claudeSessionId)).toEqual([B, A]);
        expect(filterImportableHistory(entries, [], 'DOCS').map((e) => e.claudeSessionId)).toEqual([B]);
        expect(filterImportableHistory(entries, [], 'feat/').map((e) => e.claudeSessionId)).toEqual([B]);
        expect(filterImportableHistory(entries, [], '/w/app').map((e) => e.claudeSessionId)).toEqual([C, A]);
        expect(filterImportableHistory(entries, [], 'zzz')).toEqual([]);
    });

    it('formats row title, cwd, entrypoint and size', () => {
        expect(historyEntryTitle({ summary: 'S', firstPrompt: 'p' })).toBe('S');
        expect(historyEntryTitle({ firstPrompt: 'p' })).toBe('p');
        expect(shortenCwd('/Users/me/code/app', '/Users/me/')).toBe('~/code/app');
        expect(shortenCwd('/Users/me', '/Users/me')).toBe('~');
        expect(shortenCwd('/srv/app', '/Users/me')).toBe('/srv/app');
        expect(shortenCwd('/srv/app', undefined)).toBe('/srv/app');
        expect(historyEntrypointLabel('cli')).toBe('claude CLI');
        expect(historyEntrypointLabel('sdk-cli')).toBe('SDK');
        expect(historyEntrypointLabel('remote_mobile')).toBe('claude.ai');
        expect(historyEntrypointLabel('desktop')).toBe('desktop');
        expect(historyEntrypointLabel(undefined)).toBeUndefined();
        expect(formatHistorySize(0)).toBe('0 KB');
        expect(formatHistorySize(500)).toBe('1 KB');
        expect(formatHistorySize(12 * 1024)).toBe('12 KB');
        expect(formatHistorySize(3.4 * 1024 * 1024)).toBe('3.4 MB');
    });

    it('B-294 selection helpers: toggle, prune to what is visible, import in list order', () => {
        expect(toggleImportSelection([], A)).toEqual([A]);
        expect(toggleImportSelection([A, B], A)).toEqual([B]);

        const visible = [
            claude(B, { cwd: '/w', firstPrompt: 'b', startedAt: 0, updatedAt: 2, sizeBytes: 1 }),
            claude(A, { cwd: '/w', firstPrompt: 'a', startedAt: 0, updatedAt: 1, sizeBytes: 1 }),
        ];
        expect(pruneImportSelection([A, C, B], visible).sort()).toEqual([A, B].sort());
        // same array identity semantics matter for the effect that prunes: order follows the list
        expect(orderSelectionForImport([A, B], visible).map((e) => e.id)).toEqual([B, A]);
        expect(orderSelectionForImport([C], visible)).toEqual([]);
    });

    it('B-294 summarizes a run and only offers a target session when exactly one imported', () => {
        expect(summarizeImportRun(new Map())).toEqual({ total: 0, done: 0, failed: 0 });
        expect(summarizeImportRun(new Map([
            [A, { kind: 'done', sessionId: 's1' }],
            [B, { kind: 'failed', message: 'boom' }],
        ]))).toEqual({ total: 2, done: 1, failed: 1, singleSessionId: 's1' });
        expect(summarizeImportRun(new Map([
            [A, { kind: 'done', sessionId: 's1' }],
            [B, { kind: 'done', sessionId: 's2' }],
        ]))).toEqual({ total: 2, done: 2, failed: 0 });
        // a run still in flight is not settled
        expect(summarizeImportRun(new Map([
            [A, { kind: 'running' }],
            [B, { kind: 'queued' }],
        ]))).toEqual({ total: 2, done: 0, failed: 0 });
    });
});
