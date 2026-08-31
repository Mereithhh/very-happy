import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * apiSocket.checkLiveness — the resume-time probe (spec 2026-08-web-resume-sync §B).
 * socket.io is mocked; the real socket.io semantics the probe relies on are
 * pinned by socketIoResume.integration.test.ts.
 */

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
    const socket: any = {
        connected: true,
        recovered: false,
        on: vi.fn(),
        onAny: vi.fn(),
        emit: vi.fn(),
        emitWithAck: state.centralAck,
        timeout: vi.fn(() => ({ emitWithAck: state.centralAck })),
        disconnect: vi.fn(() => { socket.connected = false; }),
        connect: vi.fn(() => { socket.connected = true; }),
    };
    return socket;
}

function relaySocket() {
    const socket: any = {
        connected: false,
        on: vi.fn(),
        onAny: vi.fn(),
        emit: vi.fn(),
        close: vi.fn(() => { socket.connected = false; }),
        disconnect: vi.fn(() => { socket.connected = false; }),
        timeout: vi.fn(() => ({ emitWithAck: (...args: any[]) => state.relayAck(socket, ...args) })),
        once: vi.fn((event: string, handler: (...args: any[]) => void) => {
            if (event === 'connect') queueMicrotask(() => {
                socket.connected = true;
                handler();
            });
        }),
    };
    return socket;
}

describe('ApiSocket resume liveness', () => {
    beforeEach(() => {
        vi.resetModules();
        state.io.mockReset();
        state.relayAck.mockReset();
        state.centralAck.mockReset();
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                assignment: {
                    relayId: 'sin', url: 'https://relay.test', region: 'Singapore',
                    token: 'relay-token', expiresAt: Date.now() + 60_000,
                },
            }),
        })));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    async function load(relays: any[] = []) {
        const control = centralSocket();
        let chain = state.io.mockReturnValueOnce(control);
        for (const relay of relays) chain = chain.mockReturnValueOnce(relay);
        state.relayAck.mockImplementation(async (_socket: any, event: string) => {
            if (event === 'relay-ping') return { serverAt: Date.now() };
            if (event === 'rpc-call') return { ok: true, result: 'cipher-result' };
            return { ok: false };
        });
        state.centralAck.mockImplementation(async (event: string) => {
            if (event === 'ping') return {};
            if (event === 'rpc-call') return { ok: true, result: 'central-result' };
            return { ok: false };
        });
        const { apiSocket } = await import('./apiSocket');
        apiSocket.initialize({ endpoint: 'https://control.test', token: 'account-token' }, {
            getMachineEncryption: () => ({
                encryptRaw: vi.fn(async () => 'cipher-params'),
                decryptRaw: vi.fn(async (value: string) => `plain:${value}`),
            }),
            getSessionEncryption: () => ({
                encryptRaw: vi.fn(async () => 'cipher-params'),
                decryptRaw: vi.fn(async (value: string) => `plain:${value}`),
            }),
        } as any);
        return { apiSocket, control };
    }

    it('emits app-state first, then probes with a payload-less ping; an ack means alive and nothing is reconnected', async () => {
        const { apiSocket, control } = await load();
        await expect(apiSocket.checkLiveness()).resolves.toBe('alive');
        expect(control.emit).toHaveBeenCalledWith('app-state', { state: expect.any(String) });
        expect(state.centralAck).toHaveBeenCalledWith('ping'); // exactly one arg: the server handler's first param is the ack callback
        expect(control.disconnect).not.toHaveBeenCalled();
        expect(control.connect).not.toHaveBeenCalled();
        apiSocket.disconnect();
    });

    it('skips the probe when the app-state emit already closed the engine (ping expired → manager reconnecting)', async () => {
        const { apiSocket, control } = await load();
        control.emit.mockImplementation(() => { queueMicrotask(() => { control.connected = false; }); });
        await expect(apiSocket.checkLiveness()).resolves.toBe('skipped');
        expect(state.centralAck).not.toHaveBeenCalledWith('ping');
        expect(control.disconnect).not.toHaveBeenCalled();
        apiSocket.disconnect();
    });

    it('forces exactly one disconnect+connect when the ping gets no ack and the socket still claims to be connected', async () => {
        const { apiSocket, control } = await load();
        state.centralAck.mockImplementation(async (event: string) => {
            if (event === 'ping') throw new Error('operation has timed out');
            return { ok: false };
        });
        const [a, b] = await Promise.all([apiSocket.checkLiveness(), apiSocket.checkLiveness()]);
        expect(a).toBe('reconnected');
        expect(b).toBe('reconnected'); // concurrent callers share the run
        expect(control.disconnect).toHaveBeenCalledTimes(1);
        expect(control.connect).toHaveBeenCalledTimes(1);
        expect(control.disconnect.mock.invocationCallOrder[0]).toBeLessThan(control.connect.mock.invocationCallOrder[0]);
        apiSocket.disconnect();
    });

    it('never reconnects when the ack was rejected because the socket dropped meanwhile (queued close → _clearAcks)', async () => {
        const { apiSocket, control } = await load();
        state.centralAck.mockImplementation(async (event: string) => {
            if (event === 'ping') {
                control.connected = false; // manager is already reconnecting on its own
                throw new Error('socket has been disconnected');
            }
            return { ok: false };
        });
        await expect(apiSocket.checkLiveness()).resolves.toBe('skipped');
        expect(control.disconnect).not.toHaveBeenCalled();
        expect(control.connect).not.toHaveBeenCalled();
        apiSocket.disconnect();
    });

    it('rebuilds a connected relay that stops answering relay-ping: unmap → clear cooldown → connecting → close → new socket', async () => {
        const relay1 = relaySocket();
        const relay2 = relaySocket();
        const { apiSocket } = await load([relay1, relay2]);
        const statuses: string[] = [];
        apiSocket.onMachineRelayStatus((machineId, status) => { if (machineId === 'm1') statuses.push(status.state); });
        // Establish relay1 through a normal RPC.
        await expect(apiSocket.machineRPC('m1', 'noop', {})).resolves.toBe('plain:cipher-result');
        expect(apiSocket.getMachineRelayStatus('m1').state).toBe('connected');
        statuses.length = 0;
        // relay1 now answers nothing; relay2 (the rebuild) answers normally.
        state.relayAck.mockImplementation(async (socket: any, event: string) => {
            if (socket === relay1 && event === 'relay-ping') throw new Error('operation has timed out');
            if (event === 'relay-ping') return { serverAt: Date.now() };
            return { ok: true, result: 'cipher-result' };
        });
        await apiSocket.checkLiveness();
        expect(relay1.close).toHaveBeenCalledTimes(1);
        // `connecting` must be published by the rebuild itself: relay1's own
        // disconnect handler is skipped (unmapped first) and would otherwise
        // leave the chip on a stale `connected`.
        expect(statuses[0]).toBe('connecting');
        await vi.waitFor(() => expect(apiSocket.getMachineRelayStatus('m1').state).toBe('connected'));
        expect(state.io).toHaveBeenCalledTimes(3); // control + relay1 + relay2 — no 30s cooldown in the way
        // Subsequent RPCs ride relay2, not relay1 and not control.
        await apiSocket.machineRPC('m1', 'noop', {});
        expect(state.relayAck).toHaveBeenCalledWith(relay2, 'rpc-call', expect.anything());
        apiSocket.disconnect();
    });

    it('does not rebuild the same relay twice per resume when even the fresh socket ignores relay-ping (30s cooldown caps the loop)', async () => {
        const relay1 = relaySocket();
        const relay2 = relaySocket();
        const { apiSocket } = await load([relay1, relay2]);
        await apiSocket.machineRPC('m1', 'noop', {});
        state.relayAck.mockImplementation(async (_socket: any, event: string) => {
            if (event === 'relay-ping') throw new Error('operation has timed out');
            return { ok: true, result: 'cipher-result' };
        });
        await apiSocket.checkLiveness();
        await vi.waitFor(() => expect(relay2.close).toHaveBeenCalledTimes(1));
        expect(apiSocket.getMachineRelayStatus('m1').state).toBe('fallback');
        expect(state.io).toHaveBeenCalledTimes(3);
        // Cooldown armed: the next RPC goes over control instead of opening relay3.
        await apiSocket.machineRPC('m1', 'noop', {});
        expect(state.io).toHaveBeenCalledTimes(3);
        expect(state.centralAck).toHaveBeenCalledWith('rpc-call', expect.anything());
        apiSocket.disconnect();
    });

    it('re-checks the relay right before emitting an RPC: a relay that died during encrypt is bypassed, not waited on', async () => {
        const relay1 = relaySocket();
        const { apiSocket } = await load([relay1]);
        await apiSocket.machineRPC('m1', 'noop', {});
        state.relayAck.mockClear();
        state.centralAck.mockClear();
        // Encryption for the next call drops the relay mid-flight (what a resume probe closing it looks like).
        const { apiSocket: same } = await import('./apiSocket');
        (same as any).encryption = {
            getMachineEncryption: () => ({
                encryptRaw: vi.fn(async () => { relay1.connected = false; return 'cipher-params'; }),
                decryptRaw: vi.fn(async (value: string) => `plain:${value}`),
            }),
        };
        await expect(apiSocket.machineRPC('m1', 'noop', {})).resolves.toBe('plain:central-result');
        expect(state.relayAck).not.toHaveBeenCalledWith(relay1, 'rpc-call', expect.anything());
        expect(state.centralAck).toHaveBeenCalledWith('rpc-call', expect.anything());
        apiSocket.disconnect();
    });

    it('fires onRecovered (not onReconnected) for a recovered connect', async () => {
        const { apiSocket, control } = await load();
        const reconnected = vi.fn();
        const recovered = vi.fn();
        apiSocket.onReconnected(reconnected);
        apiSocket.onRecovered(recovered);
        const connectHandler = control.on.mock.calls.find((c: any[]) => c[0] === 'connect')![1];
        control.recovered = true;
        connectHandler();
        expect(recovered).toHaveBeenCalledTimes(1);
        expect(reconnected).not.toHaveBeenCalled();
        control.recovered = false;
        connectHandler();
        expect(reconnected).toHaveBeenCalledTimes(1);
        expect(recovered).toHaveBeenCalledTimes(1);
        apiSocket.disconnect();
    });
});
