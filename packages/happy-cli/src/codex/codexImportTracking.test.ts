import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64, encrypt, getRandomBytes } from '@/api/encryption';
import type { PersistedSession } from '@/persistence';
import { resolveTrackedCodexThreadIds, serverCodexImportProbe, type CodexImportProbe, type CodexImportState } from './codexImportTracking';

const SOURCE_FAILED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE_RUNNING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SOURCE_DONE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FORK_DONE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OWN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SOURCE_RESTORED = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function record(metadata: Record<string, unknown>, key = encodeBase64(new Uint8Array(32))): PersistedSession {
    return { encryptionKey: key, encryptionVariant: 'legacy', seq: 0, metadataVersion: 0, agentStateVersion: 0, metadata: metadata as any, savedAt: 0 };
}

function probeFrom(states: Record<string, CodexImportState | Error>) {
    return vi.fn<CodexImportProbe>(async (sessionId) => {
        const state = states[sessionId];
        if (state instanceof Error) throw state;
        if (!state) throw new Error(`unexpected probe for ${sessionId}`);
        return state;
    });
}

describe('resolveTrackedCodexThreadIds (B-537)', () => {
    it('a failed import stops hiding its original; a running or successful one keeps it hidden', async () => {
        // sessions.json holds the BIRTH snapshot: every import record names its
        // original and none has the fork id — the server's view decides.
        const records = {
            failed: record({ flavor: 'codex', importedFromCodexThreadId: SOURCE_FAILED }),
            running: record({ flavor: 'codex', importedFromCodexThreadId: SOURCE_RUNNING }),
            done: record({ flavor: 'codex', importedFromCodexThreadId: SOURCE_DONE.toUpperCase() }),
            own: record({ flavor: 'codex', codexThreadId: OWN.toUpperCase() }),
            restored: record({ flavor: 'codex', codexThreadId: FORK_DONE, importedFromCodexThreadId: SOURCE_RESTORED }),
        };
        const probe = probeFrom({
            failed: { found: true, active: false, codexThreadId: null },
            running: { found: true, active: true, codexThreadId: null },
            done: { found: true, active: false, codexThreadId: FORK_DONE },
        });

        const ids = await resolveTrackedCodexThreadIds(records, probe, { settled: new Map() });

        expect(ids).not.toContain(SOURCE_FAILED);
        expect(ids.sort()).toEqual([SOURCE_RUNNING, SOURCE_DONE, FORK_DONE, OWN, SOURCE_RESTORED].sort());
        // A record that already has its own thread is settled locally.
        expect(probe.mock.calls.map(([sessionId]) => sessionId).sort()).toEqual(['done', 'failed', 'running']);
    });

    it('keeps hiding when the server cannot answer, and stops once the shell is deleted', async () => {
        const records = {
            offline: record({ importedFromCodexThreadId: SOURCE_FAILED }),
            deleted: record({ importedFromCodexThreadId: SOURCE_RUNNING }),
        };
        const probe = probeFrom({ offline: new Error('fetch failed'), deleted: { found: false } });
        expect(await resolveTrackedCodexThreadIds(records, probe, { settled: new Map() })).toEqual([SOURCE_FAILED]);
    });

    it('asks the server about a successful import only once', async () => {
        const settled = new Map<string, string>();
        const records = {
            done: record({ importedFromCodexThreadId: SOURCE_DONE }),
            failed: record({ importedFromCodexThreadId: SOURCE_FAILED }),
        };
        const probe = probeFrom({
            done: { found: true, active: false, codexThreadId: FORK_DONE },
            failed: { found: true, active: false, codexThreadId: null },
        });
        await resolveTrackedCodexThreadIds(records, probe, { settled });
        const again = await resolveTrackedCodexThreadIds(records, probe, { settled });
        expect(again).toContain(SOURCE_DONE);
        expect(again).toContain(FORK_DONE);
        expect(again).not.toContain(SOURCE_FAILED);
        // done: once; failed: every time (it is not final while it could still be running).
        expect(probe.mock.calls.map(([sessionId]) => sessionId).sort()).toEqual(['done', 'failed', 'failed']);
    });
});

describe('serverCodexImportProbe (B-537)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const key = getRandomBytes(32);
    const local = record({}, encodeBase64(key));

    function respond(status: number, body: unknown) {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    }

    it('reads active and the fork id from the decrypted server metadata', async () => {
        const fetchMock = respond(200, { session: { id: 's1', active: false, metadata: encodeBase64(encrypt(key, 'legacy', { codexThreadId: FORK_DONE.toUpperCase() })) } });
        expect(await serverCodexImportProbe('tok')('s1', local)).toEqual({ found: true, active: false, codexThreadId: FORK_DONE });
        expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/\/v1\/sessions\/s1$/);

        respond(200, { session: { id: 's1', active: true, metadata: encodeBase64(encrypt(key, 'legacy', { importedFromCodexThreadId: SOURCE_RUNNING })) } });
        expect(await serverCodexImportProbe('tok')('s1', local)).toEqual({ found: true, active: true, codexThreadId: null });
    });

    it('treats only the route\'s own 404 as deleted; anything unclear throws (caller keeps hiding)', async () => {
        respond(404, { error: 'Session not found' });
        expect(await serverCodexImportProbe('tok')('s1', local)).toEqual({ found: false });

        respond(404, { message: 'Route GET:/v1/sessions/s1 not found', error: 'Not Found', statusCode: 404 });
        await expect(serverCodexImportProbe('tok')('s1', local)).rejects.toThrow(/404/);

        respond(500, {});
        await expect(serverCodexImportProbe('tok')('s1', local)).rejects.toThrow(/500/);

        respond(200, { session: { id: 's1', active: false, metadata: encodeBase64(encrypt(getRandomBytes(32), 'legacy', { codexThreadId: FORK_DONE })) } });
        await expect(serverCodexImportProbe('tok')('s1', local)).rejects.toThrow(/undecryptable/);

        const fetchMock = respond(200, {});
        await expect(serverCodexImportProbe('tok')('s1', { ...local, encryptionKey: '' })).rejects.toThrow(/no local key/);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
