import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    io: vi.fn(),
    relayAck: vi.fn(),
    centralAck: vi.fn(),
}));

vi.mock('socket.io-client', () => ({ io: state.io }));
vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    AppState: { currentState: 'active' },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'test' } } }));
vi.mock('@/auth/tokenStorage', () => ({
    TokenStorage: { getCredentials: vi.fn(async () => ({ token: 'account-token' })) },
}));
vi.mock('./storage', () => ({
    storage: {
        getState: () => ({
            localSettings: { verboseLogging: false },
            sessions: { s1: { metadata: { machineId: 'm1' } } },
        }),
    },
}));

function centralSocket() {
    return {
        connected: true,
        on: vi.fn(),
        onAny: vi.fn(),
        emit: vi.fn(),
        emitWithAck: state.centralAck,
        timeout: vi.fn(() => ({ emitWithAck: state.centralAck })),
        disconnect: vi.fn(),
    };
}

function relaySocket() {
    const socket: any = {
        connected: false,
        on: vi.fn(),
        onAny: vi.fn(),
        close: vi.fn(() => { socket.connected = false; }),
        disconnect: vi.fn(() => { socket.connected = false; }),
        timeout: vi.fn(() => ({ emitWithAck: state.relayAck })),
        once: vi.fn((event: string, handler: (...args: any[]) => void) => {
            if (event === 'connect') queueMicrotask(() => {
                socket.connected = true;
                handler();
            });
        }),
    };
    return socket;
}

describe('ApiSocket regional session fast lane', () => {
    beforeEach(() => {
        vi.resetModules();
        state.io.mockReset();
        state.relayAck.mockReset();
        state.centralAck.mockReset();
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                assignment: {
                    relayId: 'sin',
                    url: 'https://relay.test',
                    region: 'Singapore',
                    token: 'relay-token',
                    expiresAt: Date.now() + 60_000,
                },
            }),
        })));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    async function load() {
        const control = centralSocket();
        const relay = relaySocket();
        state.io.mockReturnValueOnce(control).mockReturnValueOnce(relay);
        state.relayAck.mockImplementation(async (event: string) => {
            if (event === 'relay-ping') return { serverAt: Date.now() };
            if (event === 'session-message-deliver') {
                return { ok: true, messages: [{ id: 'stored', seq: 1, localId: 'l1', createdAt: 1, updatedAt: 1 }] };
            }
            if (event === 'session-rpc-call') return { ok: true, result: 'cipher-result' };
            return { ok: false };
        });
        const { apiSocket } = await import('./apiSocket');
        apiSocket.initialize({ endpoint: 'https://control.test', token: 'account-token' }, {
            getSessionEncryption: () => ({
                encryptRaw: vi.fn(async () => 'cipher-params'),
                decryptRaw: vi.fn(async (value) => `plain:${value}`),
            }),
        } as any);
        return { apiSocket, control, relay };
    }

    it('delivers structured input via relay and returns authoritative persistence metadata', async () => {
        const { apiSocket, control } = await load();
        const result = await apiSocket.deliverSessionMessages('m1', 's1', [{ localId: 'l1', content: 'cipher-body' }]);
        expect(result).toMatchObject({ ok: true, messages: [{ id: 'stored', seq: 1, localId: 'l1' }] });
        expect(state.relayAck).toHaveBeenCalledWith('session-message-deliver', {
            sessionId: 's1', messages: [{ localId: 'l1', content: 'cipher-body' }],
        });
        expect(control.emitWithAck).not.toHaveBeenCalled();
        apiSocket.disconnect();
    });

    it('routes session RPC through relay without replaying it over control', async () => {
        const { apiSocket, control } = await load();
        await expect(apiSocket.sessionRPC('s1', 'abort', {})).resolves.toBe('plain:cipher-result');
        expect(state.relayAck).toHaveBeenCalledWith('session-rpc-call', {
            sessionId: 's1', method: 's1:abort', params: 'cipher-params',
        });
        expect(control.emitWithAck).not.toHaveBeenCalled();
        apiSocket.disconnect();
    });

    it('falls back on the next send when no session runner acknowledges', async () => {
        const { apiSocket } = await load();
        state.relayAck.mockImplementation(async (event: string) => {
            if (event === 'relay-ping') return { serverAt: Date.now() };
            return { ok: false, error: 'Session unavailable' };
        });
        await expect(apiSocket.deliverSessionMessages('m1', 's1', [{ localId: 'l1', content: 'cipher' }]))
            .resolves.toBeNull();
        const callsAfterFailure = state.relayAck.mock.calls.length;
        await expect(apiSocket.deliverSessionMessages('m1', 's1', [{ localId: 'l2', content: 'cipher' }]))
            .resolves.toBeNull();
        expect(state.relayAck).toHaveBeenCalledTimes(callsAfterFailure);
        apiSocket.disconnect();
    });

    it('does not replay a session RPC over control when the relay ack is lost', async () => {
        const { apiSocket, control } = await load();
        state.relayAck.mockImplementation(async (event: string) => {
            if (event === 'relay-ping') return { serverAt: Date.now() };
            throw new Error('operation has timed out');
        });
        await expect(apiSocket.sessionRPC('s1', 'abort', {})).rejects.toThrow('timed out');
        expect(control.emitWithAck).not.toHaveBeenCalled();
        apiSocket.disconnect();
    });

    it('uses central RPC when relay proves that an old runner is unavailable', async () => {
        const { apiSocket } = await load();
        state.relayAck.mockImplementation(async (event: string) => {
            if (event === 'relay-ping') return { serverAt: Date.now() };
            return { ok: false, error: 'Session unavailable' };
        });
        state.centralAck.mockResolvedValueOnce({ ok: true, result: 'central-cipher' });
        await expect(apiSocket.sessionRPC('s1', 'abort', {})).resolves.toBe('plain:central-cipher');
        expect(state.centralAck).toHaveBeenCalledWith('rpc-call', {
            method: 's1:abort', params: 'cipher-params',
        });
        apiSocket.disconnect();
    });
});

describe('ApiSocket machineRPC relay preflight', () => {
    beforeEach(() => {
        vi.resetModules();
        state.io.mockReset();
        state.relayAck.mockReset();
        state.centralAck.mockReset();
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                assignment: {
                    relayId: 'sin',
                    url: 'https://relay.test',
                    region: 'Singapore',
                    token: 'relay-token',
                    expiresAt: Date.now() + 60_000,
                },
            }),
        })));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    async function load() {
        const control = centralSocket();
        const relay = relaySocket();
        state.io.mockReturnValueOnce(control).mockReturnValueOnce(relay);
        const { apiSocket } = await import('./apiSocket');
        apiSocket.initialize({ endpoint: 'https://control.test', token: 'account-token' }, {
            getMachineEncryption: () => ({
                encryptRaw: vi.fn(async () => 'cipher-params'),
                decryptRaw: vi.fn(async (value) => `plain:${value}`),
            }),
        } as any);
        return { apiSocket, control, relay };
    }

    it('routes machine RPC over the relay when the preflight ping succeeds', async () => {
        const { apiSocket, control } = await load();
        state.relayAck.mockImplementation(async (event: string) => {
            if (event === 'relay-ping') return { serverAt: Date.now() };
            if (event === 'rpc-call') return { ok: true, result: 'relay-cipher' };
            return { ok: false };
        });
        await expect(apiSocket.machineRPC('m1', 'open-terminal', {})).resolves.toBe('plain:relay-cipher');
        expect(state.relayAck).toHaveBeenCalledWith('rpc-call', {
            method: 'm1:open-terminal', params: 'cipher-params',
        });
        expect(control.emitWithAck).not.toHaveBeenCalled();
        apiSocket.disconnect();
    });

    it('fails fast to central — never emitting the RPC on a relay whose preflight ping times out', async () => {
        const { apiSocket } = await load();
        // The relay socket is "connected" but the link is dead end-to-end: every
        // relay-ping (the connect-time one AND the machineRPC preflight) rejects.
        state.relayAck.mockImplementation(async (event: string) => {
            if (event === 'relay-ping') throw new Error('operation has timed out');
            return { ok: false };
        });
        state.centralAck.mockResolvedValueOnce({ ok: true, result: 'central-cipher' });
        await expect(apiSocket.machineRPC('m1', 'open-terminal', {})).resolves.toBe('plain:central-cipher');
        // The RPC went over central, and was NEVER emitted on the dead relay
        // (so it cannot park for the 60s ack timer).
        expect(state.centralAck).toHaveBeenCalledWith('rpc-call', {
            method: 'm1:open-terminal', params: 'cipher-params',
        });
        expect(state.relayAck).not.toHaveBeenCalledWith('rpc-call', expect.anything());
        apiSocket.disconnect();
    });
});
