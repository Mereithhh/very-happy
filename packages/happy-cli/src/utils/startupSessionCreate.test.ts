import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionForStartup, SessionStartupError } from './startupSessionCreate';
import { connectionState } from './serverConnectionErrors';
import type { Session } from '@/api/types';

const session = { id: 's1' } as Session;
const noSleep = async () => {};

describe('B-689 daemon-spawned session create', () => {
    beforeEach(() => connectionState.reset());
    it('a terminal start keeps one attempt and its offline mode (null)', async () => {
        const create = vi.fn().mockResolvedValue(null);
        await expect(createSessionForStartup(create, { startedBy: 'terminal', sleep: noSleep })).resolves.toBeNull();
        expect(create).toHaveBeenCalledTimes(1);
    });
    it('a daemon spawn retries a transient failure (10-21: ECONNRESET under load)', async () => {
        const create = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(session);
        const sleeps: number[] = [];
        await expect(createSessionForStartup(create, { startedBy: 'daemon', sleep: async (ms) => { sleeps.push(ms); } })).resolves.toBe(session);
        expect(sleeps).toEqual([500, 1_000]);
    });
    it('a daemon spawn never returns null: it fails with the cause instead of going offline', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        connectionState.fail({ operation: 'Session creation', errorCode: 'ECONNRESET' });
        const create = vi.fn().mockResolvedValue(null);
        const error = await createSessionForStartup(create, { startedBy: 'daemon', sleep: noSleep }).catch((e) => e);
        expect(error).toBeInstanceOf(SessionStartupError);
        expect(error.message).toBe('Could not create the session on the server after 5 attempts: ECONNRESET - connection reset by server');
        expect(create).toHaveBeenCalledTimes(5);
    });
});
