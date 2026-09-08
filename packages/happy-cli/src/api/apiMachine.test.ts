import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiMachineClient, CLI_AVAILABILITY_RECHECK_MS } from './apiMachine';
import type { Machine } from './types';
import { detectCLIAvailability } from '@/utils/detectCLI';
import { detectResumeSupport } from '@/resume/localHappyAgentAuth';

const {
    mockIo,
    mockShouldReconnect
} = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockShouldReconnect: vi.fn(() => true)
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'http://127.0.0.1:3005',
        currentCliVersion: 'test'
    }
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn()
}));

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketConnectAndWait = vi.fn(async () => undefined);
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
        registerHandler = vi.fn();
        unregisterHandler = vi.fn();
        hasHandler = vi.fn(() => false);
    }
}));

vi.mock('@/utils/detectCLI', async () => ({
    ...(await vi.importActual('@/utils/detectCLI')),
    detectCLIAvailability: vi.fn(() => ({
        claude: false,
        codex: false,
        gemini: false,
        openclaw: false
    }))
}));

vi.mock('@/resume/localHappyAgentAuth', () => ({
    detectResumeSupport: vi.fn(() => ({
        rpcAvailable: false,
        requiresSameMachine: false,
        requiresHappyAgentAuth: false,
        happyAgentAuthenticated: false
    }))
}));

vi.mock('@/utils/lidState', () => ({
    shouldReconnect: mockShouldReconnect
}));

type SocketHandler = (...args: any[]) => void;
type SocketHandlers = Record<string, SocketHandler[]>;

function makeMachine(): Machine {
    return {
        id: 'test-machine-id',
        metadata: {
            host: 'localhost',
            platform: 'darwin',
            happyCliVersion: 'test',
            homeDir: '/home/user',
            happyHomeDir: '/home/user/.happy',
            happyLibDir: '/home/user/.happy/lib'
        },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy'
    };
}

describe('ApiMachineClient socket reconnection', () => {
    let socketHandlers: SocketHandlers;
    let mockSocket: any;

    const emitSocketEvent = (event: string, ...args: any[]) => {
        const handlers = socketHandlers[event] || [];
        handlers.forEach((handler) => handler(...args));
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockShouldReconnect.mockReturnValue(true);
        socketHandlers = {};
        mockSocket = {
            connected: false,
            connect: vi.fn(),
            on: vi.fn((event: string, handler: SocketHandler) => {
                if (!socketHandlers[event]) {
                    socketHandlers[event] = [];
                }
                socketHandlers[event].push(handler);
            }),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            close: vi.fn(),
            io: {
                on: vi.fn()
            }
        };

        mockIo.mockReturnValue(mockSocket);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('retries after initial socket connection error', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        expect(mockIo).toHaveBeenCalledWith('ws://127.0.0.1:3005', expect.objectContaining({
            reconnection: false
        }));
        expect(mockSocket.connect).not.toHaveBeenCalled();

        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));

        await vi.advanceTimersByTimeAsync(1000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(3000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(2);

        client.shutdown();
    });

    it('forwards a durable server archive command to local process termination', () => {
        const stopSession = vi.fn(() => true);
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession,
            requestShutdown: vi.fn(),
        });
        client.connect();

        emitSocketEvent('session-archive', { sessionId: 'session-1' });

        expect(stopSession).toHaveBeenCalledWith('session-1');
        client.shutdown();
    });

    it('reconciles archived tracked sessions after missed realtime delivery', async () => {
        const stopSession = vi.fn(() => true);
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ archivedSessionIds: ['session-2'] }),
        } as Response);
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession,
            listTrackedSessionIds: () => ['session-1', 'session-2'],
            requestShutdown: vi.fn(),
        });

        await (client as any).reconcileArchivedSessions();

        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:3005/v1/sessions/archive-status',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ sessionIds: ['session-1', 'session-2'] }),
            }),
        );
        expect(stopSession).toHaveBeenCalledWith('session-2');
    });

    // T-013 (CPU audit): the keep-alive used to call detectCLIAvailability()
    // — six blocking `sh -c command -v` forks — on EVERY 20s tick. A 10s
    // cpu sample of the production daemon showed those forks as the largest
    // non-idle bucket on the main thread. The heartbeat itself must stay at
    // 20s (server presence); only the probe is throttled.
    it('keeps the 20s machine-alive heartbeat but re-probes CLI availability only every CLI_AVAILABILITY_RECHECK_MS', async () => {
        vi.useFakeTimers();
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as Response);
        const probe = vi.mocked(detectCLIAvailability);
        const resumeProbe = vi.mocked(detectResumeSupport);
        probe.mockClear();
        resumeProbe.mockClear();

        const client = new ApiMachineClient('fake-token', makeMachine());
        mockSocket.connected = true;
        (client as any).socket = mockSocket;
        (client as any).startKeepAlive();

        // First tick probes (nothing advertised yet) and heartbeats.
        await vi.advanceTimersByTimeAsync(20_000);
        expect(mockSocket.emit).toHaveBeenCalledWith('machine-alive', expect.objectContaining({ machineId: 'test-machine-id' }));
        expect(probe).toHaveBeenCalledTimes(1);
        expect(resumeProbe).toHaveBeenCalledTimes(1);

        // The next 4 minutes of ticks heartbeat without forking a probe.
        await vi.advanceTimersByTimeAsync(4 * 60_000);
        const alive = mockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'machine-alive').length;
        expect(alive).toBe(13);
        expect(probe).toHaveBeenCalledTimes(1);
        expect(resumeProbe).toHaveBeenCalledTimes(1);

        // Once the window elapses the probe runs again.
        await vi.advanceTimersByTimeAsync(CLI_AVAILABILITY_RECHECK_MS - 4 * 60_000);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(resumeProbe).toHaveBeenCalledTimes(2);

        // Over an hour: 180 heartbeats, but only 12 probes (was 180).
        await vi.advanceTimersByTimeAsync(60 * 60_000 - CLI_AVAILABILITY_RECHECK_MS - 20_000);
        const aliveHour = mockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'machine-alive').length;
        expect(aliveHour).toBe(180);
        expect(probe).toHaveBeenCalledTimes(12);

        client.shutdown();
    });

    it('hands terminal command ownership to the candidate without double-consuming input', async () => {
        const makeHandoverSocket = () => {
            const handlers: SocketHandlers = {};
            const socket: any = {
                connected: true,
                on: vi.fn((event: string, handler: SocketHandler) => {
                    (handlers[event] ||= []).push(handler);
                    return socket;
                }),
                once: vi.fn((event: string, handler: SocketHandler) => {
                    const onceHandler = (...args: any[]) => {
                        handlers[event] = (handlers[event] || []).filter((item) => item !== onceHandler);
                        handler(...args);
                    };
                    (handlers[event] ||= []).push(onceHandler);
                    return socket;
                }),
                listeners: vi.fn((event: string) => handlers[event] || []),
                removeAllListeners: vi.fn((event: string) => {
                    delete handlers[event];
                    return socket;
                }),
                connect: vi.fn(() => {
                    for (const handler of [...(handlers.connect || [])]) handler();
                    return socket;
                }),
                emit: vi.fn(),
                emitWithAck: vi.fn(),
                close: vi.fn(),
                io: { on: vi.fn() },
                handlers,
            };
            return socket;
        };
        const previous = makeHandoverSocket();
        const candidate = makeHandoverSocket();
        mockIo.mockReturnValueOnce(previous).mockReturnValueOnce(candidate);

        const client = new ApiMachineClient('fake-token', makeMachine());
        (client as any).activateControlSocket = vi.fn();
        const write = vi.spyOn((client as any).webTerminal, 'write');
        client.connect();

        const notice = {
            candidateSlot: 'green',
            epoch: '0000000002',
            fromRelease: 'a'.repeat(40),
            toRelease: 'b'.repeat(40),
            deadline: Date.now() + 10_000,
            mode: 'make-before-break',
        };
        for (const handler of [...previous.handlers['server-draining']]) handler(notice);
        await (client as any).handoverInFlight;

        expect(candidate.handlers['rpc-request']).toHaveLength(1);
        expect(previous.handlers['terminal-input']).toBeUndefined();
        expect(candidate.handlers['terminal-input']).toHaveLength(1);
        for (const handler of previous.handlers['terminal-input'] || []) handler({ terminalId: 't1', data: 'x' });
        for (const handler of candidate.handlers['terminal-input'] || []) handler({ terminalId: 't1', data: 'x' });
        expect(write).toHaveBeenCalledTimes(1);
        expect(previous.close).toHaveBeenCalledTimes(1);
    });
});
