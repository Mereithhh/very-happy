import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockApiClientCreate,
    mockCreateSessionScanner,
    mockLoop,
    mockNotifyDaemonSessionStarted,
    mockReadSettings,
    mockStartHappyServer,
    mockStartHookServer,
    mockRegisterKillSessionHandler,
} = vi.hoisted(() => ({
    mockApiClientCreate: vi.fn(),
    mockCreateSessionScanner: vi.fn(),
    mockLoop: vi.fn(),
    mockNotifyDaemonSessionStarted: vi.fn(),
    mockReadSettings: vi.fn(),
    mockStartHappyServer: vi.fn(),
    mockStartHookServer: vi.fn(),
    mockRegisterKillSessionHandler: vi.fn(),
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: mockApiClientCreate,
    },
}));

vi.mock('@/persistence', () => ({
    readSettings: mockReadSettings,
}));

// B-272: the single-writer lock writes under the real happy home; keep the
// unit test off the filesystem (the lock has its own tests).
vi.mock('@/utils/sessionLock', () => ({
    claimSessionOrExit: vi.fn(async () => {}),
}));

vi.mock('@/claude/utils/sessionScanner', () => ({
    createSessionScanner: mockCreateSessionScanner,
}));

vi.mock('@/claude/loop', () => ({
    loop: mockLoop,
}));

vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonSessionStarted: mockNotifyDaemonSessionStarted,
}));

vi.mock('@/daemon/machineMetadata', () => ({
    getInitialMachineMetadata: () => ({}),
}));

vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: mockStartHappyServer,
}));

vi.mock('@/claude/utils/startHookServer', () => ({
    startHookServer: mockStartHookServer,
}));

vi.mock('@/claude/utils/generateHookSettings', () => ({
    generateHookSettingsFile: vi.fn(() => '/tmp/happy-hook-settings.json'),
    cleanupHookSettingsFile: vi.fn(),
}));

vi.mock('./registerKillSessionHandler', () => ({
    registerKillSessionHandler: mockRegisterKillSessionHandler,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        infoDeveloper: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('@/ui/doctor', () => ({
    getEnvironmentInfo: vi.fn(() => ({})),
}));

vi.mock('@/utils/serverConnectionErrors', () => ({
    connectionState: {
        setBackend: vi.fn(),
        notifyOffline: vi.fn(),
        fail: vi.fn(),
    },
    startOfflineReconnection: vi.fn(),
}));

vi.mock('@/claude/claudeLocal', () => ({
    claudeLocal: vi.fn(),
}));

// B-515: keep the prewarm cache and slot files off the real happy home.
const prewarmMocks = vi.hoisted(() => ({
    readCache: vi.fn((): string | null => null),
    writeCache: vi.fn((_file: string, _value: string) => true),
    acquireSlot: vi.fn(() => ({ path: '/slot', release: vi.fn() })),
}));
vi.mock('@/claude/claudePrewarm', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./claudePrewarm')>()),
    readPrewarmSystemPromptCache: prewarmMocks.readCache,
    writePrewarmSystemPromptCache: prewarmMocks.writeCache,
    acquirePrewarmSlot: prewarmMocks.acquireSlot,
}));

import { runClaude } from './runClaude';

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('runClaude remote JSONL scanner', () => {
    const processEvents = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'] as const;
    const originalListeners = new Map<string, Array<(...args: any[]) => void>>();

    beforeEach(() => {
        vi.clearAllMocks();
        for (const event of processEvents) {
            originalListeners.set(event, process.listeners(event as any) as Array<(...args: any[]) => void>);
        }

        delete process.env.HAPPY_RECONNECT_SESSION_ID;
        delete process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
        delete process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT;
        delete process.env.HAPPY_RECONNECT_SEQ;
        delete process.env.HAPPY_RECONNECT_METADATA_VERSION;
        delete process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION;
        delete process.env.HAPPY_FORKED_FROM_SESSION_ID;
        delete process.env.HAPPY_FORKED_FROM_MESSAGE_ID;
        delete process.env.HAPPY_FORK_CLAUDE_SESSION_ID;

        mockReadSettings.mockResolvedValue({
            machineId: 'machine-1',
            sandboxConfig: undefined,
        });
        mockNotifyDaemonSessionStarted.mockResolvedValue({});
        mockStartHappyServer.mockResolvedValue({
            url: 'http://127.0.0.1:12345',
            toolNames: ['change_title'],
            stop: vi.fn(),
        });
        mockStartHookServer.mockResolvedValue({
            port: 23456,
            stop: vi.fn(),
        });
        mockCreateSessionScanner.mockResolvedValue({
            onNewSession: vi.fn(),
            cleanup: vi.fn(),
        });
    });

    afterEach(() => {
        for (const [event, listeners] of originalListeners) {
            process.removeAllListeners(event as any);
            for (const listener of listeners) {
                process.on(event as any, listener);
            }
        }
        originalListeners.clear();
    });

    it('does not forward terminal JSONL messages while local mode owns the transcript', async () => {
        const sentMessages: unknown[] = [];
        const sessionClient = {
            attachPromptQueueDrain: vi.fn(() => ({ onIdle: vi.fn(), onQueueChanged: vi.fn(), onInbound: vi.fn(), close: vi.fn(), hasPending: () => false, maybeDispatch: vi.fn(async () => false) })),
            promptQueueHasPending: vi.fn(() => false),
            closePromptQueueDrain: vi.fn(),
            sessionId: 'happy-session-1',
            suppressNextArchiveSignal: vi.fn(),
            skipExistingMessages: vi.fn(),
            updateMetadata: vi.fn(),
            sendClaudeSessionMessage: vi.fn((message: unknown) => {
                sentMessages.push(message);
            }),
            onUserMessage: vi.fn(),
            onFileEvent: vi.fn(),
            on: vi.fn(),
            trackAttachmentDownload: vi.fn(),
            drainAttachmentsForUserMessage: vi.fn(async () => []),
            downloadAndDecryptAttachment: vi.fn(),
            getMetadata: vi.fn(() => ({})),
            sendSessionEvent: vi.fn(),
            updateAgentState: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            sendSessionDeath: vi.fn(),
            flush: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        };
        const api = {
            getOrCreateMachine: vi.fn(async () => ({})),
            getOrCreateSession: vi.fn(async () => ({
                id: 'happy-session-1',
                seq: 0,
                metadata: {},
                metadataVersion: 0,
                agentState: {},
                agentStateVersion: 0,
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy' as const,
            })),
            sessionSyncClient: vi.fn(() => sessionClient),
            deactivateSession: vi.fn(async () => {}),
        };
        mockApiClientCreate.mockResolvedValue(api);

        const loopDeferred = createDeferred<number>();
        mockLoop.mockReturnValue(loopDeferred.promise);

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'local',
            shouldStartDaemon: false,
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
            expect(mockCreateSessionScanner).toHaveBeenCalled();
        });

        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        scannerOptions.onMessage({
            type: 'user',
            uuid: 'local-owned-user',
            parentUuid: null,
            isSidechain: false,
            sessionId: 'claude-session-1',
            timestamp: new Date().toISOString(),
            message: {
                role: 'user',
                content: 'typed in local terminal',
            },
        });

        expect(sentMessages).toHaveLength(0);

        const loopOptions = mockLoop.mock.calls[0][0];
        loopOptions.onModeChange('remote');
        scannerOptions.onMessage({
            type: 'user',
            uuid: 'remote-terminal-user',
            parentUuid: null,
            isSidechain: false,
            sessionId: 'claude-session-1',
            timestamp: new Date().toISOString(),
            message: {
                role: 'user',
                content: 'typed in parallel remote terminal',
            },
        });

        expect(sentMessages).toHaveLength(1);
        expect(sessionClient.sendClaudeSessionMessage).toHaveBeenCalledWith(
            expect.objectContaining({ uuid: 'remote-terminal-user' }),
        );

        loopDeferred.resolve(0);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
    });

    it('routes delivery=steer to the live Session and does not enqueue it', async () => {
        let userMessageHandler!: (message: any) => Promise<void>;
        const sessionClient = {
            attachPromptQueueDrain: vi.fn(() => ({ onIdle: vi.fn(), onQueueChanged: vi.fn(), onInbound: vi.fn(), close: vi.fn(), hasPending: () => false, maybeDispatch: vi.fn(async () => false) })),
            promptQueueHasPending: vi.fn(() => false),
            closePromptQueueDrain: vi.fn(),
            sessionId: 'happy-session-steer',
            suppressNextArchiveSignal: vi.fn(),
            skipExistingMessages: vi.fn(),
            updateMetadata: vi.fn(),
            sendClaudeSessionMessage: vi.fn(),
            onUserMessage: vi.fn((handler) => { userMessageHandler = handler; }),
            onFileEvent: vi.fn(),
            on: vi.fn(),
            trackAttachmentDownload: vi.fn(),
            drainAttachmentsForUserMessage: vi.fn(async () => []),
            downloadAndDecryptAttachment: vi.fn(),
            getMetadata: vi.fn(() => ({ summary: { text: 'Existing title' } })),
            sendSessionEvent: vi.fn(),
            updateAgentState: vi.fn(),
            rpcHandlerManager: { registerHandler: vi.fn() },
            sendSessionDeath: vi.fn(),
            flush: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        };
        const api = {
            getOrCreateMachine: vi.fn(async () => ({})),
            getOrCreateSession: vi.fn(async () => ({
                id: 'happy-session-steer',
                seq: 0,
                metadata: {},
                metadataVersion: 0,
                agentState: {},
                agentStateVersion: 0,
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy' as const,
            })),
            sessionSyncClient: vi.fn(() => sessionClient),
            deactivateSession: vi.fn(async () => {}),
        };
        mockApiClientCreate.mockResolvedValue(api);

        const loopDeferred = createDeferred<number>();
        mockLoop.mockReturnValue(loopDeferred.promise);
        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'remote',
            shouldStartDaemon: false,
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
            expect(sessionClient.onUserMessage).toHaveBeenCalled();
        });
        expect(api.getOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                capabilities: ['claude-steer-v1', 'claude-live-permission-v1', 'claude-live-permission-v2', 'claude-btw-v1', 'claude-runtime-controls-v1', 'claude-opus-5-5-v1', 'prompt-queue-v1'],
            }),
        }));

        const trySteer = vi.fn(async () => true);
        const loopOptions = mockLoop.mock.calls[0][0];
        loopOptions.onSessionReady({ trySteer, cleanup: vi.fn() });
        const queuePush = vi.spyOn(loopOptions.messageQueue, 'push');

        await userMessageHandler({
            role: 'user',
            content: { type: 'text', text: 'focus on the failing test' },
            meta: { sentFrom: 'web', delivery: 'steer' },
        });

        expect(trySteer).toHaveBeenCalledWith(expect.objectContaining({
            message: 'focus on the failing test',
            mode: expect.objectContaining({ permissionMode: 'default' }),
        }));
        expect(queuePush).not.toHaveBeenCalled();

        trySteer.mockResolvedValue(false);
        await userMessageHandler({
            role: 'user',
            content: { type: 'text', text: 'late steering message' },
            meta: { sentFrom: 'web', delivery: 'steer' },
        });
        expect(queuePush).toHaveBeenCalledWith(
            'late steering message',
            expect.objectContaining({ permissionMode: 'default' }),
            [],
            undefined,
        );

        loopOptions.onPermissionModeChange('bypassPermissions');
        await userMessageHandler({
            role: 'user',
            content: { type: 'text', text: 'follow live permission mode' },
            meta: { sentFrom: 'web' },
        });
        expect(queuePush).toHaveBeenLastCalledWith(
            'follow live permission mode',
            expect.objectContaining({ permissionMode: 'bypassPermissions' }),
            [],
            undefined,
        );

        loopDeferred.resolve(0);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
    });
});

describe('runClaude startup order (B-512)', () => {
    const processEvents = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'] as const;
    const originalListeners = new Map<string, Array<(...args: any[]) => void>>();
    const reconnectEnv = [
        'HAPPY_RECONNECT_SESSION_ID', 'HAPPY_RECONNECT_ENCRYPTION_KEY', 'HAPPY_RECONNECT_ENCRYPTION_VARIANT',
        'HAPPY_RECONNECT_SEQ', 'HAPPY_RECONNECT_METADATA_VERSION', 'HAPPY_RECONNECT_AGENT_STATE_VERSION',
    ];

    beforeEach(() => {
        vi.clearAllMocks();
        for (const event of processEvents) {
            originalListeners.set(event, process.listeners(event as any) as Array<(...args: any[]) => void>);
        }
        for (const key of reconnectEnv) delete process.env[key];
        delete process.env.HAPPY_FORK_CLAUDE_SESSION_ID;
        mockReadSettings.mockResolvedValue({ machineId: 'machine-1', sandboxConfig: undefined });
        mockNotifyDaemonSessionStarted.mockResolvedValue({});
        mockStartHappyServer.mockResolvedValue({ url: 'http://127.0.0.1:12345', toolNames: [], stop: vi.fn() });
        mockStartHookServer.mockResolvedValue({ port: 23456, stop: vi.fn() });
        mockCreateSessionScanner.mockResolvedValue({ onNewSession: vi.fn(), cleanup: vi.fn() });
    });

    afterEach(() => {
        for (const key of reconnectEnv) delete process.env[key];
        for (const [event, listeners] of originalListeners) {
            process.removeAllListeners(event as any);
            for (const listener of listeners) process.on(event as any, listener);
        }
        originalListeners.clear();
    });

    function fixtures() {
        const sessionClient = {
            attachPromptQueueDrain: vi.fn(() => ({ onIdle: vi.fn(), onQueueChanged: vi.fn(), onInbound: vi.fn(), close: vi.fn(), hasPending: () => false, maybeDispatch: vi.fn(async () => false) })),
            promptQueueHasPending: vi.fn(() => false),
            closePromptQueueDrain: vi.fn(),
            sessionId: 'happy-session-order',
            suppressNextArchiveSignal: vi.fn(),
            skipExistingMessages: vi.fn(),
            cancelUndeliveredQueuedInputs: vi.fn(async () => {}),
            updateMetadata: vi.fn(),
            sendClaudeSessionMessage: vi.fn(),
            onUserMessage: vi.fn(),
            onFileEvent: vi.fn(),
            on: vi.fn(),
            trackAttachmentDownload: vi.fn(),
            drainAttachmentsForUserMessage: vi.fn(async () => []),
            downloadAndDecryptAttachment: vi.fn(),
            getMetadata: vi.fn(() => ({})),
            sendSessionEvent: vi.fn(),
            updateAgentState: vi.fn(),
            rpcHandlerManager: { registerHandler: vi.fn() },
            sendSessionDeath: vi.fn(),
            flush: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        };
        const api = {
            getOrCreateMachine: vi.fn(async () => ({})),
            getOrCreateSession: vi.fn(async () => ({
                id: 'happy-session-order', seq: 0, metadata: {}, metadataVersion: 0,
                agentState: {}, agentStateVersion: 0,
                encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const,
            })),
            reactivateSession: vi.fn(async () => true),
            getSession: vi.fn(async () => ({ ok: false, reason: 'test' })),
            sessionSyncClient: vi.fn((..._args: unknown[]) => sessionClient),
            deactivateSession: vi.fn(async () => {}),
        };
        mockApiClientCreate.mockResolvedValue(api);
        const loopDeferred = createDeferred<number>();
        mockLoop.mockReturnValue(loopDeferred.promise);
        return { api, sessionClient, loopDeferred };
    }

    async function finish(runPromise: Promise<void>, loopDeferred: { resolve: (v: number) => void }) {
        loopDeferred.resolve(0);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
    }

    const credentials = { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } } as any;

    it('a daemon spawn registers the machine only after the webhook and opens the session socket before it', async () => {
        const { api, loopDeferred } = fixtures();
        const runPromise = runClaude(credentials, { startingMode: 'remote', startedBy: 'daemon' });
        await vi.waitFor(() => expect(mockLoop).toHaveBeenCalled());

        // B-512 review: still registered (daemon may have started offline), but off the critical path
        expect(api.getOrCreateMachine).toHaveBeenCalledTimes(1);
        expect(api.getOrCreateMachine.mock.invocationCallOrder[0])
            .toBeGreaterThan(mockNotifyDaemonSessionStarted.mock.invocationCallOrder[0]);
        expect(api.getOrCreateSession.mock.invocationCallOrder[0])
            .toBeLessThan(api.getOrCreateMachine.mock.invocationCallOrder[0]);
        expect(api.sessionSyncClient).toHaveBeenCalledTimes(1);
        expect(api.sessionSyncClient.mock.calls[0]).toHaveLength(1); // fresh: no seeded cursor
        expect(api.sessionSyncClient.mock.invocationCallOrder[0])
            .toBeLessThan(mockNotifyDaemonSessionStarted.mock.invocationCallOrder[0]);
        await finish(runPromise, loopDeferred);
    });

    it('a failing background machine registration never becomes an unhandled rejection', async () => {
        const { api, loopDeferred } = fixtures();
        api.getOrCreateMachine.mockRejectedValue(new Error('server down'));
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            const runPromise = runClaude(credentials, { startingMode: 'remote', startedBy: 'daemon' });
            await vi.waitFor(() => expect(mockLoop).toHaveBeenCalled());
            await vi.waitFor(() => expect(api.getOrCreateMachine).toHaveBeenCalled());
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(unhandled).not.toHaveBeenCalled();
            await finish(runPromise, loopDeferred);
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });

    it('a terminal launch still registers the machine', async () => {
        const { api, loopDeferred } = fixtures();
        const runPromise = runClaude(credentials, { startingMode: 'remote', startedBy: 'terminal' });
        await vi.waitFor(() => expect(mockLoop).toHaveBeenCalled());

        expect(api.getOrCreateMachine).toHaveBeenCalledTimes(1);
        expect(api.getOrCreateMachine.mock.invocationCallOrder[0])
            .toBeLessThan(api.getOrCreateSession.mock.invocationCallOrder[0]);
        await finish(runPromise, loopDeferred);
    });

    it('a reconnect keeps reactivate → snapshot → webhook → socket', async () => {
        const { api, sessionClient, loopDeferred } = fixtures();
        process.env.HAPPY_RECONNECT_SESSION_ID = 'happy-session-order';
        process.env.HAPPY_RECONNECT_ENCRYPTION_KEY = Buffer.from(new Uint8Array(32)).toString('base64');
        process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT = 'legacy';
        const runPromise = runClaude(credentials, { startingMode: 'remote', startedBy: 'daemon' });
        await vi.waitFor(() => expect(mockLoop).toHaveBeenCalled());

        expect(api.getOrCreateSession).not.toHaveBeenCalled();
        const reactivate = api.reactivateSession.mock.invocationCallOrder[0];
        const snapshot = api.getSession.mock.invocationCallOrder[0];
        const webhook = mockNotifyDaemonSessionStarted.mock.invocationCallOrder[0];
        const socket = api.sessionSyncClient.mock.invocationCallOrder[0];
        expect(reactivate).toBeLessThan(snapshot);
        expect(snapshot).toBeLessThan(webhook);
        expect(webhook).toBeLessThan(socket);
        expect(sessionClient.skipExistingMessages).toHaveBeenCalled();
        await finish(runPromise, loopDeferred);
    });

    describe('B-515 prewarm wiring', () => {
        const prewarmEnv = ['HAPPY_CLAUDE_PREWARM', 'HAPPY_SPAWNED_BY', 'HAPPY_CLAUDE_AUTH_STATUS'];
        beforeEach(() => {
            for (const key of prewarmEnv) delete process.env[key];
            prewarmMocks.readCache.mockReset().mockReturnValue(null);
            prewarmMocks.writeCache.mockReset().mockReturnValue(true);
            prewarmMocks.acquireSlot.mockReset().mockImplementation(() => ({ path: '/slot', release: vi.fn() }));
        });

        const fakeClaudeSession = () => {
            const callbacks: Array<(id: string) => void> = [];
            return {
                callbacks,
                sessionId: null as string | null,
                onSessionFound: vi.fn(),
                addSessionFoundCallback: vi.fn((cb: (id: string) => void) => { callbacks.push(cb); }),
                cleanup: vi.fn(),
                trySteer: vi.fn(async () => false),
            };
        };

        it('ignores SessionStart hooks from an unadopted warm process; untagged hooks still land', async () => {
            const { loopDeferred } = fixtures();
            const runPromise = runClaude(credentials, { startingMode: 'remote', startedBy: 'daemon' });
            await vi.waitFor(() => expect(mockLoop).toHaveBeenCalled());
            const scanner = await mockCreateSessionScanner.mock.results[0].value;
            const { onSessionHook } = mockStartHookServer.mock.calls[0][0];
            const claudeSession = fakeClaudeSession();
            mockLoop.mock.calls[0][0].onSessionReady(claudeSession);

            onSessionHook('warm-claude-id', { session_id: 'warm-claude-id' }, { source: 'prewarm-1-0' });
            expect(scanner.onNewSession).not.toHaveBeenCalled();
            expect(claudeSession.onSessionFound).not.toHaveBeenCalled();

            onSessionHook('live-claude-id', { session_id: 'live-claude-id' }, {});
            expect(scanner.onNewSession).toHaveBeenCalledWith('live-claude-id', { treatExistingAsProcessed: true });
            expect(claudeSession.onSessionFound).toHaveBeenCalledWith('live-claude-id');
            await finish(runPromise, loopDeferred);
        });

        it('the system/init path announces the Claude session id to the remote scanner (once)', async () => {
            const { loopDeferred } = fixtures();
            const runPromise = runClaude(credentials, { startingMode: 'remote', startedBy: 'daemon' });
            await vi.waitFor(() => expect(mockLoop).toHaveBeenCalled());
            const scanner = await mockCreateSessionScanner.mock.results[0].value;
            const claudeSession = fakeClaudeSession();
            mockLoop.mock.calls[0][0].onSessionReady(claudeSession);
            expect(claudeSession.callbacks).toHaveLength(1);

            claudeSession.callbacks[0]('adopted-claude-id');
            claudeSession.callbacks[0]('adopted-claude-id');
            expect(scanner.onNewSession).toHaveBeenCalledTimes(1);
            expect(scanner.onNewSession).toHaveBeenCalledWith('adopted-claude-id', { treatExistingAsProcessed: true });
            await finish(runPromise, loopDeferred);
        });

        it('caches the web appendSystemPrompt and predicts the first message with it', async () => {
            const { sessionClient, loopDeferred } = fixtures();
            let userMessageHandler!: (message: any) => Promise<void>;
            sessionClient.onUserMessage.mockImplementation((handler: any) => { userMessageHandler = handler; });
            prewarmMocks.readCache.mockReturnValue('WEB PROMPT v1');
            const runPromise = runClaude(credentials, { startingMode: 'remote', startedBy: 'daemon', permissionMode: 'acceptEdits' });
            await vi.waitFor(() => expect(mockLoop).toHaveBeenCalled());
            const loopOptions = mockLoop.mock.calls[0][0];

            const lease = loopOptions.claudePrewarm();
            expect(lease).not.toBeNull();
            expect(lease.mode).toEqual(expect.objectContaining({ permissionMode: 'acceptEdits', appendSystemPrompt: 'WEB PROMPT v1' }));
            expect(lease.tag).toMatch(/^prewarm-/);
            lease.discard('test');

            await userMessageHandler({ role: 'user', content: { type: 'text', text: 'hi' }, meta: { sentFrom: 'web', appendSystemPrompt: 'WEB PROMPT v2' } });
            await userMessageHandler({ role: 'user', content: { type: 'text', text: 'again' }, meta: { sentFrom: 'web', appendSystemPrompt: 'WEB PROMPT v2' } });
            expect(prewarmMocks.writeCache).toHaveBeenCalledTimes(1);
            expect(prewarmMocks.writeCache.mock.calls[0][1]).toBe('WEB PROMPT v2');
            // A message already arrived: no warm process for this wrapper any more.
            expect(loopOptions.claudePrewarm()).toBeNull();
            await finish(runPromise, loopDeferred);
        });

        it('no lease without a cached prompt, when switched off, or for a dispatched session', async () => {
            const { loopDeferred } = fixtures();
            const runPromise = runClaude(credentials, { startingMode: 'remote', startedBy: 'daemon' });
            await vi.waitFor(() => expect(mockLoop).toHaveBeenCalled());
            const loopOptions = mockLoop.mock.calls[0][0];
            expect(loopOptions.claudePrewarm()).toBeNull(); // no cache
            await finish(runPromise, loopDeferred);

            mockLoop.mockClear();
            const second = fixtures();
            prewarmMocks.readCache.mockReturnValue('WEB');
            process.env.HAPPY_CLAUDE_PREWARM = '0';
            const run2 = runClaude(credentials, { startingMode: 'remote', startedBy: 'daemon' });
            await vi.waitFor(() => expect(mockLoop).toHaveBeenCalled());
            expect(mockLoop.mock.calls[0][0].claudePrewarm()).toBeNull();
            delete process.env.HAPPY_CLAUDE_PREWARM;
            process.env.HAPPY_SPAWNED_BY = 'assistant';
            expect(mockLoop.mock.calls[0][0].claudePrewarm()).toBeNull();
            delete process.env.HAPPY_SPAWNED_BY;
            prewarmMocks.acquireSlot.mockReturnValue(null as any);
            expect(mockLoop.mock.calls[0][0].claudePrewarm()).toBeNull(); // concurrency limit
            await finish(run2, second.loopDeferred);
        });
    });
});
