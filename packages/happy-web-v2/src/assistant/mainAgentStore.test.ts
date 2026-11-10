import { describe, it, expect, vi, beforeEach } from 'vitest';

const kvGet = vi.fn();
const kvMutate = vi.fn();
vi.mock('@/sync/apiKv', () => ({ kvGet: (...a: unknown[]) => kvGet(...a), kvMutate: (...a: unknown[]) => kvMutate(...a) }));

import { decodeKvJson, encodeKvJson, MAIN_AGENT_CONFIG_KEY, MAIN_AGENT_POINTER_KEY } from './mainAgent';
import { loadMainAgentConfig, openMainAgent, refreshMainAgentPointer, saveMainAgentConfig, useMainAgentStore, writeMainAgentPointer } from './mainAgentStore';

const creds = { token: 't', secret: 's' } as never;

beforeEach(() => {
    kvGet.mockReset();
    kvMutate.mockReset();
    useMainAgentStore.getState().reset();
});

describe('mainAgentStore', () => {
    it('refresh reads the pointer key; a missing key = no pointer (legacy fallback)', async () => {
        kvGet.mockResolvedValueOnce(null);
        await refreshMainAgentPointer(creds);
        expect(kvGet).toHaveBeenCalledWith(creds, MAIN_AGENT_POINTER_KEY);
        expect(useMainAgentStore.getState()).toMatchObject({ pointerStatus: 'ready', pointer: null, pointerVersion: -1 });
    });

    it('a failed refresh keeps the last known pointer', async () => {
        kvGet.mockResolvedValueOnce({ key: MAIN_AGENT_POINTER_KEY, value: encodeKvJson({ machineId: 'm1', sessionId: 's1', generation: 2 }), version: 4 });
        await refreshMainAgentPointer(creds);
        kvGet.mockRejectedValueOnce(new Error('net'));
        await refreshMainAgentPointer(creds);
        expect(useMainAgentStore.getState()).toMatchObject({ pointerStatus: 'ready', pointer: { machineId: 'm1', sessionId: 's1' } });
    });

    it('writing the pointer: new machine, sessionId null, generation + 1; one retry after a conflict', async () => {
        kvMutate
            .mockResolvedValueOnce({ success: false, errors: [{ key: MAIN_AGENT_POINTER_KEY, error: 'version-mismatch', version: 7, value: encodeKvJson({ machineId: 'm1', sessionId: 's1', generation: 5 }) }] })
            .mockResolvedValueOnce({ success: true, results: [{ key: MAIN_AGENT_POINTER_KEY, version: 8 }] });
        expect(await writeMainAgentPointer(creds, 'm2')).toBe(true);
        const second = kvMutate.mock.calls[1][1][0];
        expect(second.version).toBe(7);
        expect(decodeKvJson(second.value)).toMatchObject({ v: 1, machineId: 'm2', sessionId: null, generation: 6 });
        expect(useMainAgentStore.getState()).toMatchObject({ pointerVersion: 8, pointer: { machineId: 'm2', sessionId: null } });
    });

    it('pointer: still conflicting after the re-read → give up (the next spawn writes it)', async () => {
        kvMutate.mockResolvedValue({ success: false, errors: [{ key: MAIN_AGENT_POINTER_KEY, error: 'version-mismatch', version: 9, value: null }] });
        expect(await writeMainAgentPointer(creds, 'm2')).toBe(false);
        expect(kvMutate).toHaveBeenCalledTimes(2);
    });

    it('saving config re-merges onto the newer blob on conflict, keeping unknown fields', async () => {
        kvGet.mockResolvedValueOnce({ key: MAIN_AGENT_CONFIG_KEY, value: encodeKvJson({ skillRoots: ['/a'], deniedTools: [] }), version: 1 });
        await loadMainAgentConfig(creds);
        kvMutate
            .mockResolvedValueOnce({ success: false, errors: [{ key: MAIN_AGENT_CONFIG_KEY, error: 'version-mismatch', version: 2, value: encodeKvJson({ skillRoots: ['/a'], quietHours: [22, 8] }) }] })
            .mockResolvedValueOnce({ success: true, results: [{ key: MAIN_AGENT_CONFIG_KEY, version: 3 }] });
        expect(await saveMainAgentConfig(creds, { skillRoots: ['~/skills'], deniedTools: ['*send*'] })).toBe(true);
        const second = kvMutate.mock.calls[1][1][0];
        expect(second.version).toBe(2);
        expect(decodeKvJson(second.value)).toMatchObject({ v: 1, skillRoots: ['~/skills'], deniedTools: ['*send*'], quietHours: [22, 8] });
        expect(useMainAgentStore.getState()).toMatchObject({ configVersion: 3, config: { skillRoots: ['~/skills'] } });
    });

    it('config: gives up after the one retry instead of looping', async () => {
        kvMutate.mockResolvedValue({ success: false, errors: [{ key: MAIN_AGENT_CONFIG_KEY, error: 'version-mismatch', version: 9, value: null }] });
        expect(await saveMainAgentConfig(creds, { skillRoots: [], deniedTools: [] })).toBe(false);
        expect(kvMutate).toHaveBeenCalledTimes(2);
    });

    it('openMainAgent hands a draft over exactly once', () => {
        openMainAgent({ text: 'hi', send: true });
        expect(useMainAgentStore.getState().drawerOpen).toBe(true);
        expect(useMainAgentStore.getState().takePendingDraft()).toEqual({ text: 'hi', send: true });
        expect(useMainAgentStore.getState().takePendingDraft()).toBeNull();
    });
});
