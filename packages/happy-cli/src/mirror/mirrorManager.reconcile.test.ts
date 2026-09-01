/**
 * Unit tests for the design-v3 reconciler — the signature-independent tick that
 * self-heals mirror bindings against observed pane truth:
 *   - pane back to a shell            → end an active binding
 *   - claude-confident + ended-in-map → reactivate IN PLACE (reuse the client)
 *   - claude-confident + absent       → adopt from the newest persisted record
 *   - not claude-confident / undefined → NEVER touch (B-107 input-gate safety)
 *   - reactivateSession() === false   → retried on a later tick (F4)
 *   - within the post-end hysteresis   → do not re-adopt a footer flicker
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encodeBase64 } from '@/api/encryption';
import type { TerminalListItem } from '@/terminal/webTerminal';
import type { PersistedSession } from '@/persistence';

// ── module mocks ────────────────────────────────────────────────────────────
const readPersistedSessions = vi.fn((): Record<string, PersistedSession> => ({}));
const persistSession = vi.fn();
vi.mock('@/persistence', () => ({
    readPersistedSessions: () => readPersistedSessions(),
    persistSession: (id: string, session: unknown) => persistSession(id, session),
}));

const scannerAddFile = vi.fn();
const scannerCleanup = vi.fn(async () => {});
vi.mock('./mirrorScanner', () => ({
    createMirrorScanner: () => ({ addFile: scannerAddFile, cleanup: scannerCleanup }),
}));

import { createMirrorManager, TERMINAL_MIRROR_FLAVOR } from './mirrorManager';

// ── fakes ───────────────────────────────────────────────────────────────────
function makeClient() {
    return {
        skipExistingMessages: vi.fn(),
        updateMetadata: vi.fn(),
        closeClaudeSessionTurn: vi.fn(),
        sendClaudeSessionMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        flush: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
    };
}

function makeApi(overrides: Record<string, unknown> = {}) {
    const clients: ReturnType<typeof makeClient>[] = [];
    const sessionSyncClient = vi.fn(() => {
        const c = makeClient();
        clients.push(c);
        return c;
    });
    const api = {
        getOrCreateSession: vi.fn(async (opts: { metadata: unknown }) => ({
            id: 'srv-' + Math.random().toString(36).slice(2),
            seq: 0,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'dataKey' as const,
            metadata: opts.metadata,
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
        })),
        sessionSyncClient,
        reactivateSession: vi.fn(async () => true),
        deactivateSession: vi.fn(async () => {}),
        ...overrides,
    };
    return { api, sessionSyncClient, clients };
}

const MID = 'machine-1';
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function item(id: string, agentState: TerminalListItem['agentState'], claudeConfident: boolean): TerminalListItem {
    return { id, title: id, agentState, claudeConfident } as TerminalListItem;
}

function persistedRecord(terminalId: string, claudeSessionId: string, savedAt: number): PersistedSession {
    return {
        encryptionKey: encodeBase64(new Uint8Array(32)),
        encryptionVariant: 'dataKey',
        seq: 0,
        metadataVersion: 0,
        agentStateVersion: 0,
        savedAt,
        metadata: {
            path: '/tmp/proj',
            machineId: MID,
            flavor: TERMINAL_MIRROR_FLAVOR,
            terminalId,
            claudeSessionId,
        } as PersistedSession['metadata'],
    };
}

async function seedActive(mgr: ReturnType<typeof createMirrorManager>, terminalId: string, claudeSessionId: string) {
    mgr.handleHookPayload({
        hook_event_name: 'SessionStart',
        session_id: claudeSessionId,
        terminalId,
        cwd: '/tmp/proj',
        transcript_path: `/tmp/proj/${claudeSessionId}.jsonl`,
        source: 'startup',
    });
    await flush();
}

async function endViaHook(mgr: ReturnType<typeof createMirrorManager>, terminalId: string, claudeSessionId: string) {
    mgr.handleHookPayload({ hook_event_name: 'SessionEnd', session_id: claudeSessionId, terminalId });
    await flush();
}

describe('mirrorManager.reconcile', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
        readPersistedSessions.mockReturnValue({});
        scannerAddFile.mockClear();
    });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('adopts a claude-confident terminal absent from the map, from the NEWEST persisted record (+reactivate)', async () => {
        const { api, sessionSyncClient } = makeApi();
        const mgr = createMirrorManager({ api: api as never, machineId: MID });
        // two mirror records for the same terminal → newest must win (F6)
        readPersistedSessions.mockReturnValue({
            old: persistedRecord('t1', 'claude-old', 1000),
            new: persistedRecord('t1', 'claude-new', 5000),
        });

        mgr.reconcile([item('t1', 'idle', true)]);
        await flush();

        expect(sessionSyncClient).toHaveBeenCalledTimes(1);
        expect(api.reactivateSession).toHaveBeenCalledTimes(1);
        expect(mgr.resolveMirrorSessionId('t1')).toBeDefined();
        expect(mgr.isMirrorInputAllowed('t1')).toBe(true);
        // adopted the newest record's claude session file
        expect(scannerAddFile).toHaveBeenCalledWith(expect.stringContaining('claude-new.jsonl'), 'backfill-tail');
    });

    it('reactivates an ended-in-map binding IN PLACE — reusing the same client, never minting a second (F2)', async () => {
        const { api, sessionSyncClient } = makeApi();
        const mgr = createMirrorManager({ api: api as never, machineId: MID });
        await seedActive(mgr, 't1', 'claude-1');
        expect(sessionSyncClient).toHaveBeenCalledTimes(1); // create
        await endViaHook(mgr, 't1', 'claude-1');
        expect(mgr.isMirrorInputAllowed('t1')).toBe(false);

        // cross the post-end hysteresis window, then observe claude alive again
        vi.setSystemTime(Date.now() + 25_000);
        scannerAddFile.mockClear();
        mgr.reconcile([item('t1', 'working', true)]);
        await flush();

        expect(mgr.isMirrorInputAllowed('t1')).toBe(true);
        expect(sessionSyncClient).toHaveBeenCalledTimes(1); // NO second client
        expect(scannerAddFile).toHaveBeenCalledWith(expect.stringContaining('claude-1.jsonl'), 'backfill-tail');
    });

    it('does NOT re-adopt within the post-end hysteresis window (footer flicker)', async () => {
        const { api, sessionSyncClient } = makeApi();
        const mgr = createMirrorManager({ api: api as never, machineId: MID });
        await seedActive(mgr, 't1', 'claude-1');
        await endViaHook(mgr, 't1', 'claude-1');
        api.reactivateSession.mockClear();

        // only ~2s later — claude footer still lingering in the pane tail
        vi.setSystemTime(Date.now() + 2_000);
        mgr.reconcile([item('t1', 'idle', true)]);
        await flush();

        expect(mgr.isMirrorInputAllowed('t1')).toBe(false);
        expect(api.reactivateSession).not.toHaveBeenCalled();
        expect(sessionSyncClient).toHaveBeenCalledTimes(1);
    });

    it('never touches a terminal that is NOT claude-confident, even if agentState looks active (B-107)', async () => {
        const { api, sessionSyncClient } = makeApi();
        const mgr = createMirrorManager({ api: api as never, machineId: MID });
        readPersistedSessions.mockReturnValue({ new: persistedRecord('t1', 'claude-1', 5000) });

        // a bare `node` classifies as 'idle' but is NOT claude-confident
        mgr.reconcile([item('t1', 'idle', false)]);
        // vim/htop probe → agentState undefined
        mgr.reconcile([item('t2', undefined, false)]);
        await flush();

        expect(sessionSyncClient).not.toHaveBeenCalled();
        expect(api.reactivateSession).not.toHaveBeenCalled();
        expect(mgr.isMirrorInputAllowed('t1')).toBe(false);
    });

    it('retries the unarchive on a later tick when reactivateSession returns false (F4)', async () => {
        const reactivateSession = vi.fn(async () => false);
        const { api } = makeApi({ reactivateSession });
        const mgr = createMirrorManager({ api: api as never, machineId: MID });
        readPersistedSessions.mockReturnValue({ new: persistedRecord('t1', 'claude-1', 5000) });

        mgr.reconcile([item('t1', 'idle', true)]); // adopt, reactivate → false
        await flush();
        expect(reactivateSession).toHaveBeenCalledTimes(1);
        expect(mgr.isMirrorInputAllowed('t1')).toBe(true); // active, but needsReactivate

        reactivateSession.mockResolvedValue(true);
        vi.setSystemTime(Date.now() + 25_000);
        mgr.reconcile([item('t1', 'idle', true)]); // active+needsReactivate → retry
        await flush();
        expect(reactivateSession).toHaveBeenCalledTimes(2);
    });

    it('ends an active binding when its pane returns to a shell', async () => {
        const { api } = makeApi();
        const mgr = createMirrorManager({ api: api as never, machineId: MID });
        await seedActive(mgr, 't1', 'claude-1');
        expect(mgr.isMirrorInputAllowed('t1')).toBe(true);

        mgr.reconcile([item('t1', 'shell', false)]);
        await flush();

        expect(mgr.isMirrorInputAllowed('t1')).toBe(false);
        expect(api.deactivateSession).toHaveBeenCalled();
        // resolveMirrorSessionId still returns it (ended, kept in map)
        expect(mgr.resolveMirrorSessionId('t1')).toBeDefined();
    });
});
