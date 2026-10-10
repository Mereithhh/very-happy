import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REWIND_CONFIRM_MS, type LogRecord, type RewindRecord } from './rewindReconcile';
import { persistRewindRecord, RewindReconciler, type RewindReconcilerDeps } from './rewindReconciler';

const tombstone = (seq: number, requestId?: string, fromSeq = 1): LogRecord => ({
    seq,
    localId: `drop-${seq}`,
    body: { role: 'session', content: { type: 'session', data: { id: 'e', time: 0, role: 'user', ev: { t: 'transcript-drop', fromSeq, reason: 'edit', ...(requestId ? { requestId } : {}) } } } },
});
const user = (seq: number, localId: string): LogRecord => ({ seq, localId, body: { role: 'user', content: { type: 'text', text: localId } } });
const prompt = (uuid: string, sessionId: string) => JSON.stringify({ type: 'user', uuid, sessionId, message: { role: 'user', content: uuid } });

function harness(options: { record?: unknown; log?: LogRecord[]; files?: Record<string, string[]>; current?: string | null; deps?: Partial<RewindReconcilerDeps> } = {}) {
    const overrides = options;
    const state = {
        current: (overrides.current === undefined ? 'copy' : overrides.current) as string | null,
        record: overrides.record as unknown,
        log: overrides.log ?? [],
        written: [] as RewindRecord[],
        switched: [] as string[],
    };
    const deps: RewindReconcilerDeps = {
        now: () => Date.now(),
        readRecord: () => state.record,
        writeRecord: vi.fn(async (record: RewindRecord) => { state.written.push(record); state.record = record; }),
        readLog: vi.fn(async () => state.log),
        currentClaudeSessionId: () => state.current,
        readTranscript: async (id) => overrides.files?.[id] ?? null,
        switchConversation: vi.fn(async (id: string | null) => { state.switched.push(String(id)); state.current = id; }),
        log: () => {},
        ...options.deps,
    };
    return { state, deps, reconciler: new RewindReconciler(deps) };
}

const begin = (r: RewindReconciler, requestId = 'req-1') =>
    r.begin({ requestId, action: 'edit', sourceClaudeSessionId: 'src', claudeSessionId: 'copy', at: Date.now() });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.useRealTimers(); });

describe('RewindReconciler (B-544)', () => {
    it('records pending, and the live tombstone with the same requestId confirms it', async () => {
        const { state, reconciler } = harness();
        await begin(reconciler);
        expect(state.written.at(-1)).toMatchObject({ requestId: 'req-1', state: 'pending', sourceClaudeSessionId: 'src', claudeSessionId: 'copy' });
        const settled = reconciler.settled();
        reconciler.observe(tombstone(9, 'other').body);
        expect(reconciler.pendingRecord).not.toBeNull();
        reconciler.observe(tombstone(10, 'req-1').body);
        await settled;
        expect(reconciler.pendingRecord).toBeNull();
        expect(state.written.at(-1)).toMatchObject({ requestId: 'req-1', state: 'confirmed' });
        expect(state.switched).toEqual([]);
    });

    it('no tombstone within the window → switches back to the source and records reverted', async () => {
        const { state, deps, reconciler } = harness();
        await begin(reconciler);
        let settled = false;
        void reconciler.settled().then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(REWIND_CONFIRM_MS - 1);
        expect(settled).toBe(false); // prompts keep waiting
        expect(state.switched).toEqual([]);
        await vi.advanceTimersByTimeAsync(REWIND_CONFIRM_MS);
        expect(deps.readLog).toHaveBeenCalled(); // re-read the durable log before reverting
        expect(state.switched).toEqual(['src']);
        expect(state.written.at(-1)).toMatchObject({ requestId: 'req-1', state: 'reverted' });
        expect(settled).toBe(true);
    });

    it('a tombstone landing after the revert re-applies the rewind (log wins)', async () => {
        const { state, reconciler } = harness();
        await begin(reconciler);
        await vi.advanceTimersByTimeAsync(REWIND_CONFIRM_MS + 1);
        expect(state.switched).toEqual(['src']);
        reconciler.observe(tombstone(30, 'req-1').body);
        await vi.waitFor(() => expect(state.written.at(-1)).toMatchObject({ requestId: 'req-1', state: 'confirmed' }));
        expect(state.switched).toEqual(['src', 'copy']);
        // only once
        reconciler.observe(tombstone(31, 'req-1').body);
        expect(state.switched).toEqual(['src', 'copy']);
    });

    it('a tombstone landing WHILE the revert relaunches still ends on the rewound copy', async () => {
        let finishSwitch!: () => void;
        const { state, reconciler } = harness();
        state.current = 'copy';
        const switchConversation = vi.fn((id: string | null) => {
            state.switched.push(String(id));
            state.current = id;
            return id === 'src' ? new Promise<void>((resolve) => { finishSwitch = resolve; }) : Promise.resolve();
        });
        (reconciler as any).deps.switchConversation = switchConversation;
        await begin(reconciler);
        await vi.advanceTimersByTimeAsync(REWIND_CONFIRM_MS + 1);
        expect(state.switched).toEqual(['src']);
        reconciler.observe(tombstone(30, 'req-1').body); // mid-relaunch
        finishSwitch();
        await vi.waitFor(() => expect(state.switched).toEqual(['src', 'copy']));
        await vi.waitFor(() => expect(state.written.at(-1)).toMatchObject({ state: 'confirmed' }));
        expect(state.written.map((r) => r.state)).not.toContain('reverted');
    });

    it('a tombstone the live stream missed is found in the server log: confirm, never revert', async () => {
        const { state, reconciler } = harness({ log: [tombstone(12, 'req-1')] });
        await begin(reconciler);
        await vi.advanceTimersByTimeAsync(REWIND_CONFIRM_MS + 1);
        expect(state.switched).toEqual([]);
        expect(state.written.at(-1)).toMatchObject({ state: 'confirmed' });
    });

    it('cannot read the log → keeps waiting instead of reverting blind', async () => {
        const { state, reconciler } = harness({ deps: { readLog: vi.fn(async () => { throw new Error('offline'); }) } });
        await begin(reconciler);
        await vi.advanceTimersByTimeAsync(REWIND_CONFIRM_MS * 2);
        expect(state.switched).toEqual([]);
        expect(reconciler.pendingRecord).not.toBeNull();
    });

    it('settled() releases on abort so a relaunch is never blocked', async () => {
        const { reconciler } = harness();
        await begin(reconciler);
        const controller = new AbortController();
        const settled = reconciler.settled(controller.signal);
        controller.abort();
        await settled;
        expect(reconciler.pendingRecord).not.toBeNull();
    });

    it('settled() is immediate without a pending rewind (old web: no requestId, no record)', async () => {
        const { reconciler } = harness();
        await reconciler.settled();
        expect(reconciler.pendingRecord).toBeNull();
    });

    it('startup: a pending record whose tombstone is in the log is confirmed', async () => {
        const record = { requestId: 'req-1', action: 'edit', sourceClaudeSessionId: 'src', claudeSessionId: 'copy', at: Date.now() - 10 * 60_000, state: 'pending' };
        const { state, reconciler } = harness({ record, log: [user(1, 'a'), tombstone(5, 'req-1')] });
        await reconciler.startup();
        expect(state.switched).toEqual([]);
        expect(state.written.at(-1)).toMatchObject({ state: 'confirmed' });
    });

    it('startup: an expired pending record without a tombstone reverts', async () => {
        const record = { requestId: 'req-1', action: 'delete', sourceClaudeSessionId: 'src', claudeSessionId: 'copy', at: Date.now() - 10 * 60_000, state: 'pending' };
        const { state, reconciler } = harness({ record, log: [user(1, 'a')] });
        await reconciler.startup();
        expect(state.switched).toEqual(['src']);
        expect(state.written.at(-1)).toMatchObject({ state: 'reverted' });
    });

    it('startup: a pending record still inside its window keeps prompts waiting until the verdict', async () => {
        const record = { requestId: 'req-1', action: 'edit', sourceClaudeSessionId: 'src', claudeSessionId: 'copy', at: Date.now() - 1_000, state: 'pending' };
        const { state, reconciler } = harness({ record });
        await reconciler.startup();
        expect(reconciler.pendingRecord).not.toBeNull();
        await vi.advanceTimersByTimeAsync(REWIND_CONFIRM_MS);
        expect(state.switched).toEqual(['src']);
    });

    it('startup: a record reverted by an earlier process whose tombstone landed since is re-applied', async () => {
        const record = { requestId: 'req-1', action: 'edit', sourceClaudeSessionId: 'src', claudeSessionId: 'copy', at: Date.now() - 10 * 60_000, state: 'reverted' };
        const { state, reconciler } = harness({ record, current: 'src', log: [tombstone(7, 'req-1')] });
        await reconciler.startup();
        expect(state.switched).toEqual(['copy']);
        expect(state.written.at(-1)).toMatchObject({ state: 'confirmed' });
    });

    it('startup legacy split (no record): the incident shape switches back to the source file', async () => {
        const source = ['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => prompt(id, 'SRC'));
        const files = { SRC: source, COPY: source.slice(0, 3) };
        const log = ['t1', 't2', 't3', 't4', 't5', 't6'].map((id, i) => user(i + 1, id));
        const { state, reconciler } = harness({ current: 'COPY', files, log });
        await reconciler.startup();
        expect(state.switched).toEqual(['SRC']);
    });

    it('startup legacy: a confirmed rewind (tombstone hides the dropped prompts) is left alone', async () => {
        const source = ['t1', 't2', 't3'].map((id) => prompt(id, 'SRC'));
        const files = { SRC: source, COPY: [...source.slice(0, 1), prompt('t9', 'COPY')] };
        const log = [user(1, 't1'), user(2, 't2'), user(3, 't3'), tombstone(4, undefined, 2), user(5, 't9')];
        const { state, reconciler } = harness({ current: 'COPY', files, log });
        await reconciler.startup();
        expect(state.switched).toEqual([]);
    });

    it('a second rewind while the first is pending reverts all the way to the confirmed source', async () => {
        const { state, reconciler } = harness();
        await begin(reconciler, 'req-1');
        state.current = 'copy-2';
        await reconciler.begin({ requestId: 'req-2', action: 'edit', sourceClaudeSessionId: 'copy', claudeSessionId: 'copy-2', at: Date.now() });
        expect(state.written.at(-1)).toMatchObject({ requestId: 'req-2', sourceClaudeSessionId: 'src' });
        await vi.advanceTimersByTimeAsync(REWIND_CONFIRM_MS + 1);
        expect(state.switched).toEqual(['src']);
    });
});

describe('persistRewindRecord', () => {
    it('writes through updateMetadata and resolves once the server copy holds it', async () => {
        vi.useRealTimers();
        let metadata: any = { path: '/p' };
        const client = {
            updateMetadata: (handler: (m: any) => any) => { setTimeout(() => { metadata = handler(metadata); }, 5); },
            getMetadata: () => metadata,
        };
        const record: RewindRecord = { requestId: 'r', action: 'edit', sourceClaudeSessionId: 's', claudeSessionId: 'c', at: 1, state: 'pending' };
        await persistRewindRecord(client, record, { pollMs: 1 });
        expect(metadata).toEqual({ path: '/p', rewind: record });
    });

    it('a late state change never overwrites a newer rewind', async () => {
        vi.useRealTimers();
        const newer: RewindRecord = { requestId: 'new', action: 'edit', sourceClaudeSessionId: 's', claudeSessionId: 'c', at: 2, state: 'pending' };
        let metadata: any = { path: '/p', rewind: newer };
        const updateMetadata = vi.fn((handler: (m: any) => any) => { metadata = handler(metadata); });
        await persistRewindRecord({ updateMetadata, getMetadata: () => metadata }, { ...newer, requestId: 'old', state: 'reverted' }, { timeoutMs: 10, pollMs: 1 });
        expect(metadata.rewind).toBe(newer);
    });
});
