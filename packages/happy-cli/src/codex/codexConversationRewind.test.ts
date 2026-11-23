import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import {
    fileCodexTurnStore,
    CodexRewindError,
    CodexTurnSourceMap,
    createCodexConversationRewind,
    findCodexRewindTurn,
    liveRewindTurn,
    persistCodexRewindRecord,
    type CodexRewindDeps,
} from './codexConversationRewind';
import type { ThreadTurn } from './codexAppServerTypes';

const user = (id: string, text: string) => ({ type: 'userMessage', id, content: [{ type: 'text', text }] }) as any;
const agent = (id: string) => ({ type: 'agentMessage', id, text: 'ok' }) as any;
const turn = (id: string, ...items: any[]): ThreadTurn => ({ id, items });

const THREAD: ThreadTurn[] = [
    turn('t1', user('u1', 'first prompt\n\nTitle instruction…'), agent('a1')),
    turn('t2', user('u2', 'second prompt'), agent('a2'), user('u2b', 'steered in')),
    turn('t3', user('u3', 'third prompt'), agent('a3')),
];

function deps(over: Partial<CodexRewindDeps> = {}) {
    const calls: string[] = [];
    const d: CodexRewindDeps = {
        threadId: () => 'thread-1',
        isBusy: () => false,
        stopTurn: vi.fn(async () => { calls.push('stop'); }),
        waitIdle: vi.fn(async () => true),
        turnOfSource: () => null,
        readTurns: vi.fn(async () => THREAD),
        revert: vi.fn(async (turnId: string) => { calls.push(`revert:${turnId}`); }),
        dropTurnsFrom: vi.fn(),
        record: vi.fn(async () => { calls.push('record'); }),
        holdPrompts: () => { calls.push('hold'); return () => calls.push('release'); },
        now: () => 1000,
        ...over,
    };
    return { d, calls };
}

describe('B-961 findCodexRewindTurn (prompt → turn)', () => {
    it('maps a codexItemId to the turn it opens', () => {
        expect(findCodexRewindTurn(THREAD, { codexItemId: 'u2' })).toBe('t2');
    });
    it('refuses an item steered into a running turn (not the turn opening)', () => {
        expect(() => findCodexRewindTurn(THREAD, { codexItemId: 'u2b' })).toThrow(CodexRewindError);
    });
    it('falls back on the opening text; exact beats containing, the wrapper header does not hide it', () => {
        expect(findCodexRewindTurn(THREAD, { text: 'third prompt' })).toBe('t3');
        expect(findCodexRewindTurn(THREAD, { text: 'first   prompt' })).toBe('t1');
    });
    it('refuses a text that opens two turns instead of guessing', () => {
        const twice = [turn('a', user('x', 'continue')), turn('b', user('y', 'continue'))];
        expect(() => findCodexRewindTurn(twice, { text: 'continue' })).toThrow(/more than once/);
    });
    it('a prompt steered into a running turn (inside it, not its opening) is refused by text too', () => {
        expect(() => findCodexRewindTurn(THREAD, { text: 'steered in' })).toThrow(/running turn/);
    });
    it('a prompt no longer in the thread is not-found', () => {
        try { findCodexRewindTurn(THREAD, { text: 'never sent' }); throw new Error('no'); }
        catch (error) { expect((error as CodexRewindError).code).toBe('not-found'); }
    });
});

describe('B-961 liveRewindTurn / CodexTurnSourceMap', () => {
    it('records turn/start ids per batch; only a batch\'s first prompt opens its turn; a revert drops later turns', () => {
        const map = new CodexTurnSourceMap();
        map.started('t1', ['l1']);
        map.started('t2', ['l2', 'l3']);
        map.started('t3', ['l5']);
        expect(liveRewindTurn(map.of('l1'), 'l1')).toBe('t1');
        expect(liveRewindTurn(map.of('l2'), 'l2')).toBe('t2');
        expect(() => liveRewindTurn(map.of('l3'), 'l3')).toThrow(/running turn/);
        map.dropFrom('t2');
        expect(map.of('l2')).toBeNull();
        expect(map.of('l5')).toBeNull();
        expect(map.of('l1')?.turnId).toBe('t1');
    });
    it('unknown to the live map → null (thread fallback)', () => {
        expect(liveRewindTurn(null, 'x')).toBeNull();
    });
});

describe('B-961 createCodexConversationRewind', () => {
    it('delete: live map turn → thread/revert before it, record before the ack, prompts held throughout', async () => {
        const { d, calls } = deps({ turnOfSource: (id) => id === 'l2' ? { turnId: 't2', sourceIds: ['l2'] } : null });
        const result = await createCodexConversationRewind(d)({ action: 'delete', sourceId: 'l2', text: 'second prompt', requestId: 'req-1' });
        // thread/revert also drops every later turn: the ack tells the web to hide them too.
        expect(result).toEqual({ ok: true, action: 'delete', freshConversation: false, dropsLater: true });
        expect(calls).toEqual(['hold', 'revert:t2', 'record', 'release']);
        expect(d.readTurns).not.toHaveBeenCalled();
        expect(d.dropTurnsFrom).toHaveBeenCalledWith('t2');
        expect(d.record).toHaveBeenCalledWith({ requestId: 'req-1', action: 'delete', sourceClaudeSessionId: 'thread-1', claudeSessionId: 'thread-1', at: 1000, state: 'applied', sourceId: 'l2' });
    });
    it('edit / retry after a wrapper restart: the thread text finds the turn', async () => {
        const { d, calls } = deps();
        const result = await createCodexConversationRewind(d)({ action: 'edit', sourceId: 'unknown', text: 'third prompt', requestId: 'req-2' });
        expect(result.ok).toBe(true);
        expect(calls).toContain('revert:t3');
    });
    it('a running turn (or an active goal) is stopped first — the Stop path pauses the goal', async () => {
        let busy = true;
        const { d, calls } = deps({ isBusy: () => busy, stopTurn: vi.fn(async () => { calls.push('stop'); busy = false; }) });
        await createCodexConversationRewind(d)({ action: 'delete', codexItemId: 'u1' });
        expect(calls.slice(0, 3)).toEqual(['hold', 'stop', 'revert:t1']);
    });
    it('a turn that does not stop is refused, nothing reverted', async () => {
        const { d } = deps({ isBusy: () => true, waitIdle: async () => false });
        const result = await createCodexConversationRewind(d)({ action: 'delete', codexItemId: 'u1' });
        expect(result).toMatchObject({ ok: false, code: 'running' });
        expect(d.revert).not.toHaveBeenCalled();
    });
    it('Codex without thread/revert → codex-outdated (the web says: update Codex)', async () => {
        const { d } = deps({ revert: async () => { throw new Error('Method not found'); } });
        const result = await createCodexConversationRewind(d)({ action: 'delete', codexItemId: 'u1', requestId: 'r' });
        expect(result).toMatchObject({ ok: false, code: 'codex-outdated' });
        expect(d.record).not.toHaveBeenCalled();
    });
    it('a turn already gone → not-found; invalid input and a second request in flight are refused', async () => {
        const gone = deps({ revert: async () => { throw new Error('turn not found: t1'); } });
        expect(await createCodexConversationRewind(gone.d)({ action: 'delete', codexItemId: 'u1' })).toMatchObject({ code: 'not-found' });
        const { d } = deps();
        expect(await createCodexConversationRewind(d)({ action: 'rename', text: 'x' })).toMatchObject({ code: 'invalid' });
        let finish!: () => void;
        const slow = deps({ revert: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) });
        const run = createCodexConversationRewind(slow.d);
        const first = run({ action: 'delete', codexItemId: 'u1' });
        await vi.waitFor(() => expect(slow.d.revert).toHaveBeenCalled());
        expect(await run({ action: 'delete', codexItemId: 'u1' })).toMatchObject({ code: 'busy' });
        finish();
        expect((await first).ok).toBe(true);
    });
    it('no thread yet → no-conversation', async () => {
        const { d } = deps({ threadId: () => null });
        expect(await createCodexConversationRewind(d)({ action: 'delete', codexItemId: 'u1' })).toMatchObject({ code: 'no-conversation' });
    });
});

describe('B-961 persistCodexRewindRecord', () => {
    it('replaces an older record and resolves once the session holds the new one', async () => {
        let metadata: any = { rewind: { requestId: 'old', state: 'applied' } };
        const client = { getMetadata: () => metadata, updateMetadata: (handler: (m: any) => any) => { metadata = handler(metadata); } };
        await persistCodexRewindRecord(client, { requestId: 'new', action: 'delete', sourceClaudeSessionId: 't', claudeSessionId: 't', at: 1, state: 'applied' }, { timeoutMs: 50, pollMs: 5 });
        expect(metadata.rewind.requestId).toBe('new');
    });
});

describe('B-961 runCodex wiring', () => {
    const source = readFileSync(join(__dirname, 'runCodex.ts'), 'utf8');
    it('advertises codex-rewind-v1 and registers conversation-rewind on the Stop path', () => {
        expect(source).toContain('metadata.capabilities = [...metadata.capabilities, CODEX_REWIND_CAPABILITY];');
        expect(source).toContain("registerHandler('conversation-rewind', createCodexConversationRewind({");
        expect(source).toContain("stopTurn: () => handleAbort('user'),");
        expect(source).toContain('isBusy: () => turnActive || goalRunning(),');
    });
    it('a dequeued prompt waits for a rewind in flight; turn/start ids feed the live map', () => {
        expect(source).toContain('while (rewindHold) await rewindHold;');
        expect(source).toContain('heldInput.hold(batch.sourceIds);\n                turnSourceIds = batch.sourceIds;');
        expect(source).toContain('if (client.lastRequestedTurnId && client.lastRequestedTurnId !== requestedBefore) turnSources.started(client.lastRequestedTurnId, turnSourceIds);');
    });
});

describe('B-961 the map survives a wrapper restart and tells the web which prompts follow', () => {
    const fsx = { mkdirSync, readFileSync, renameSync, writeFileSync };
    it('persists per session; a new map (restarted wrapper) knows the turns and republishes followers', () => {
        const path = join(mkdtempSync(join(tmpdir(), 'b961-')), 'codex-turns', 's1.json');
        const published: string[][] = [];
        const first = new CodexTurnSourceMap(fileCodexTurnStore(path, fsx, dirname), (ids) => published.push(ids));
        first.started('t1', ['l1']);
        first.started('t2', ['l2', 'l3']);
        first.steered('t2', 'l4');
        expect(published.at(-1)).toEqual(['l3', 'l4']);
        const again: string[][] = [];
        const restarted = new CodexTurnSourceMap(fileCodexTurnStore(path, fsx, dirname), (ids) => again.push(ids));
        restarted.publish();
        expect(restarted.of('l2')?.turnId).toBe('t2');
        expect(again).toEqual([['l3', 'l4']]);
        restarted.dropFrom('t2');
        expect(new CodexTurnSourceMap(fileCodexTurnStore(path, fsx, dirname)).of('l2')).toBeNull();
        expect(again.at(-1)).toEqual([]);
    });
    it('a goal turn Codex opened itself: a steered prompt is a follower, never an opening', () => {
        const map = new CodexTurnSourceMap();
        map.steered('goal-turn', 'l9');
        expect(map.followers()).toEqual(['l9']);
        expect(() => liveRewindTurn(map.of('l9'), 'l9')).toThrow(/running turn/);
    });
    it('a missing or corrupt file starts empty', () => {
        const dir = mkdtempSync(join(tmpdir(), 'b961-'));
        writeFileSync(join(dir, 'bad.json'), '{nope');
        expect(fileCodexTurnStore(join(dir, 'bad.json'), fsx, dirname).load()).toEqual([]);
        expect(fileCodexTurnStore(join(dir, 'none.json'), fsx, dirname).load()).toEqual([]);
    });
    it('the rewind record names the prompt for the web reconcile', async () => {
        const { d } = deps({ turnOfSource: () => ({ turnId: 't2', sourceIds: ['l2'] }) });
        await createCodexConversationRewind(d)({ action: 'delete', sourceId: 'l2', requestId: 'r9' });
        expect(d.record).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'r9', sourceId: 'l2', state: 'applied' }));
    });
    it('runCodex loads the per-session file and steered prompts join the running turn', () => {
        const source = readFileSync(join(__dirname, 'runCodex.ts'), 'utf8');
        expect(source).toContain("fileCodexTurnStore(join(configuration.happyHomeDir, 'codex-turns', `${session.sessionId.replace(");
        expect(source).toContain('(ids) => session.updateMetadata((metadata) => ({ ...metadata, codexTurnFollowers: ids })),');
        expect(source).toContain('turnSources.steered(client.turnId, localKey);');
    });
});
