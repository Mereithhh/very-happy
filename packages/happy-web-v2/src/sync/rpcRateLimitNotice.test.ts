import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    show: vi.fn(),
    listener: undefined as undefined | ((event: any) => void),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: { rpcGate: { setOnLimited: (fn: any) => { state.listener = fn; } } },
}));
vi.mock('@/ui/Toast', () => ({ toast: { show: state.show } }));
vi.mock('@/text', () => ({ t: (key: string, params: any) => `${key}:${JSON.stringify(params)}` }));

describe('installRpcRateLimitNotice (T-014)', () => {
    beforeEach(() => { state.show.mockReset(); state.listener = undefined; });

    it('turns one closed window into one info toast with the wait in whole seconds', async () => {
        const { installRpcRateLimitNotice } = await import('./rpcRateLimitNotice');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        installRpcRateLimitNotice();
        expect(state.listener).toBeTypeOf('function');
        state.listener!({ route: 'relay:m1', waitMs: 4_400, attempt: 1, serverError: 'RPC account rate limit reached' });
        expect(state.show).toHaveBeenCalledTimes(1);
        expect(state.show).toHaveBeenCalledWith('rpc.rateLimited:{"seconds":4}', 'info');
        // Sub-second hints still say at least 1s — "0s" would read as nothing happened.
        state.listener!({ route: 'control', waitMs: 300, attempt: 1, serverError: 'RPC rate limit reached' });
        expect(state.show).toHaveBeenLastCalledWith('rpc.rateLimited:{"seconds":1}', 'info');
        expect(warn).toHaveBeenCalledTimes(2);
        warn.mockRestore();
    });

    it('sync.ts installs it right after the socket is initialised', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const source = readFileSync(join(__dirname, 'sync.ts'), 'utf8');
        const init = source.indexOf('apiSocket.initialize({ endpoint: API_ENDPOINT, token: credentials.token }, encryption);');
        const install = source.indexOf('installRpcRateLimitNotice();');
        expect(init).toBeGreaterThan(-1);
        expect(install).toBeGreaterThan(init);
        // apiSocket must not import the UI/text layer itself (node tests import it).
        const socket = readFileSync(join(__dirname, 'apiSocket.ts'), 'utf8');
        expect(socket).not.toMatch(/from '@\/(ui|text)/);
    });
});
