import { describe, expect, it } from 'vitest';
import { isMachineUnreachable, offlineRetryDelayMs, sharedPaneNotice } from './sharedTerminalConnection';

describe('B-943 shared terminal connection', () => {
    it('offline wins over connecting; nothing once live', () => {
        expect(sharedPaneNotice({ connecting: true, offline: false })).toBe('connecting');
        expect(sharedPaneNotice({ connecting: true, offline: true })).toBe('offline');
        expect(sharedPaneNotice({ connecting: false, offline: true })).toBe('offline');
        expect(sharedPaneNotice({ connecting: false, offline: false })).toBeNull();
    });
    it('only an unreachable machine is retried by itself', () => {
        expect(isMachineUnreachable('machine_offline')).toBe(true);
        for (const code of ['not_shared', 'terminal_gone', 'cli_upgrade_required', 'rate_limited', 'rpc_failed', 'server_too_old']) expect(isMachineUnreachable(code)).toBe(false);
    });
    it('retry gaps grow and are capped', () => {
        expect([0, 1, 2, 3, 4, 5, 50].map(offlineRetryDelayMs)).toEqual([2000, 5000, 10000, 20000, 30000, 30000, 30000]);
        expect(offlineRetryDelayMs(-3)).toBe(2000);
        expect(offlineRetryDelayMs(Number.NaN)).toBe(2000);
    });
});
