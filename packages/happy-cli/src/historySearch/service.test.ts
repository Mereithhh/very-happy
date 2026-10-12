import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistorySearchService } from './service';
import type { HistoryRoots } from './indexer';
import { indexFilePath } from './store';

const claudeId = '11111111-2222-4333-8444-555555555555';
const j = (v: unknown) => JSON.stringify(v) + '\n';

describe('HistorySearchService (B-549)', () => {
    let root: string;
    let indexDir: string;
    let roots: HistoryRoots;
    let gate: Promise<void> | null;
    let openGate: () => void;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'vh-hs-service-'));
        indexDir = join(root, 'happy', 'history-search');
        roots = {
            claudeProjectsRoot: join(root, 'claude', 'projects'),
            codexSessionsRoot: join(root, 'codex', 'sessions'),
            codexIndexPath: join(root, 'codex', 'session_index.jsonl'),
        };
        const proj = join(roots.claudeProjectsRoot, '-work-app');
        await mkdir(proj, { recursive: true });
        await writeFile(join(proj, `${claudeId}.jsonl`),
            j({ type: 'user', cwd: '/work/app', message: { content: 'how does the relay handover work' } })
            + j({ type: 'assistant', message: { content: [{ type: 'text', text: 'It drains the old slot.' }] } }));
        gate = null;
    });
    afterEach(async () => { await rm(root, { recursive: true, force: true }); });

    function service(overrides: Partial<ConstructorParameters<typeof HistorySearchService>[0]> = {}) {
        return new HistorySearchService({
            indexDir,
            resolveRoots: async () => { if (gate) await gate; return roots; },
            ...overrides,
        });
    }

    it('answers the first search at once with an indexing status, then ready with results', async () => {
        gate = new Promise((resolve) => { openGate = resolve; });
        const s = service();
        const first = await s.handle({ query: 'handover' });
        expect(first.type).toBe('success');
        expect(first.status.state).toBe('indexing');
        expect(first.results).toEqual([]);

        openGate();
        await s.whenIdle();
        const second = await s.handle({ query: 'handover relay', limit: 5, agent: 'claude' });
        expect(second.status).toMatchObject({ state: 'ready', sessions: 1, filesTotal: 1, filesDone: 1, evicted: 0 });
        expect(second.results.map((r) => r.id)).toEqual([claudeId]);
        expect(second.results[0].snippets[0]).toMatchObject({ role: 'user', text: 'how does the relay handover work' });
        expect((await s.handle({ query: 'handover', agent: 'codex' })).results).toEqual([]);
        // The pass persisted the index (0600).
        expect((await stat(indexFilePath(indexDir))).size).toBeGreaterThan(0);
    });

    it('a new service (daemon restart) serves the persisted index before any refresh', async () => {
        const a = service();
        await a.handle({ query: 'x' });
        await a.whenIdle();

        gate = new Promise(() => { /* refresh never completes */ });
        const b = service();
        const out = await b.handle({ query: 'drains' });
        expect(out.results.map((r) => r.id)).toEqual([claudeId]);
        expect(out.status.state).toBe('indexing');
        expect(out.status.lastIndexedAt).toBeTypeOf('number');
    });

    it('does not refresh again within the interval; status never triggers work', async () => {
        let calls = 0;
        const s = service({ resolveRoots: async () => { calls += 1; return roots; }, refreshIntervalMs: 60_000 });
        expect((await s.handle({ op: 'status' })).status.state).toBe('idle');
        expect(calls).toBe(0);
        await s.handle({ query: 'relay' });
        await s.whenIdle();
        await s.handle({ query: 'relay' });
        await s.whenIdle();
        expect(calls).toBe(1);
    });

    it('clear deletes the index and resets state; the next search rebuilds', async () => {
        const s = service();
        await s.handle({ query: 'relay' });
        await s.whenIdle();
        const cleared = await s.handle({ op: 'clear' });
        expect(cleared.status).toMatchObject({ state: 'idle', sessions: 0, textChars: 0 });
        await expect(stat(indexDir)).rejects.toThrow();
        const again = await s.handle({ query: 'relay' });
        expect(again.status.state).toBe('indexing');
        await s.whenIdle();
        expect((await s.handle({ query: 'relay' })).results).toHaveLength(1);
    });

    it('clear during a running pass cancels it without leaving an index behind', async () => {
        gate = new Promise((resolve) => { openGate = resolve; });
        const s = service();
        await s.handle({ query: 'relay' });
        const clearing = s.handle({ op: 'clear' });
        openGate();
        await clearing;
        await s.whenIdle();
        await expect(stat(indexDir)).rejects.toThrow();
        expect(s.status().state).toBe('idle');
    });

    it('reports a failed pass as error but keeps answering', async () => {
        const s = service({ resolveRoots: async () => { throw new Error('boom'); } });
        await s.handle({ query: 'relay' });
        await s.whenIdle();
        const out = await s.handle({ query: 'relay' });
        expect(out.status).toMatchObject({ state: 'error', error: 'boom' });
        expect(out.results).toEqual([]);
    });
});
