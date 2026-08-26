import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: state.io }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { currentState: 'active' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'test' } } }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: vi.fn() } }));
vi.mock('./storage', () => ({
    storage: { getState: () => ({ localSettings: { verboseLogging: false }, sessions: {} }) },
}));

function fakeSocket(autoConnect = false) {
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const socket: any = {
        connected: autoConnect,
        recovered: false,
        id: autoConnect ? 'old' : 'candidate',
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
            handlers.set(event, [...(handlers.get(event) ?? []), handler]);
            return socket;
        }),
        once: vi.fn((event: string, handler: (...args: any[]) => void) => {
            if (event === 'connect') queueMicrotask(() => { socket.connected = true; handler(); });
            return socket;
        }),
        onAny: vi.fn(),
        emit: vi.fn(),
        connect: vi.fn(() => {
            socket.connected = true;
            return socket;
        }),
        disconnect: vi.fn(() => { socket.connected = false; }),
        trigger(event: string, data?: unknown) {
            for (const handler of handlers.get(event) ?? []) handler(data);
        },
    };
    return socket;
}

describe('ApiSocket release handover', () => {
    beforeEach(() => {
        vi.resetModules();
        state.io.mockReset();
    });

    it('connects the fixed candidate slot and resyncs before closing the old socket', async () => {
        const oldSocket = fakeSocket(true);
        const candidate = fakeSocket(false);
        state.io.mockReturnValueOnce(oldSocket).mockReturnValueOnce(candidate);
        const { apiSocket } = await import('./apiSocket');
        const resync = vi.fn(async () => undefined);
        apiSocket.onReconnected(resync);
        apiSocket.initialize({ endpoint: 'https://control.test', token: 'token' }, {} as any);

        oldSocket.trigger('server-draining', {
            epoch: 'release-1234',
            fromRelease: 'a'.repeat(40),
            toRelease: 'b'.repeat(40),
            candidateSlot: 'green',
            deadline: Date.now() + 30_000,
            mode: 'make-before-break',
        });

        await vi.waitFor(() => expect(oldSocket.disconnect).toHaveBeenCalledTimes(1));
        expect(state.io).toHaveBeenNthCalledWith(2, 'https://control.test', expect.objectContaining({
            query: { vh_slot: 'green' },
            forceNew: true,
            auth: expect.objectContaining({ handoverEpoch: 'release-1234' }),
        }));
        expect(resync).toHaveBeenCalled();
        expect(candidate.connect).toHaveBeenCalledTimes(1);
        expect(candidate.emit).toHaveBeenCalledWith('release-handover-result', expect.objectContaining({ result: 'success' }));
        expect(resync.mock.invocationCallOrder[0]).toBeLessThan(oldSocket.disconnect.mock.invocationCallOrder[0]);
        apiSocket.disconnect();
    });
});
