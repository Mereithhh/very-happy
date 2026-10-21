import { describe, expect, it, vi } from 'vitest';

const debug = vi.hoisted(() => vi.fn());
vi.mock('@/ui/logger', () => ({ logger: { debug } }));
import { recordExitReason } from './exitReason';

describe('B-689 exit reason', () => {
    it('writes one [EXIT] line the daemon can parse back', async () => {
        recordExitReason(1, 'Could not create the session\n  on the server');
        expect(debug).toHaveBeenCalledWith('[EXIT] Exiting with code 1: Could not create the session on the server');
        const { extractStartupExitReason } = await import('@/daemon/startupExit');
        expect(extractStartupExitReason(`[15:00:00.000] ${debug.mock.calls[0][0]}`)).toBe('Could not create the session on the server');
    });
});
