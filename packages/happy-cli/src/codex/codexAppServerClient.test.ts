import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '@/persistence';

const {
    mockExecSync,
    mockInitializeSandbox,
    mockWrapForMcpTransport,
    mockSandboxCleanup,
    mockSpawn,
    mockLoggerDebug,
} = vi.hoisted(() => ({
    mockExecSync: vi.fn(),
    mockInitializeSandbox: vi.fn(),
    mockWrapForMcpTransport: vi.fn(),
    mockSandboxCleanup: vi.fn(),
    mockSpawn: vi.fn(),
    mockLoggerDebug: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    execSync: mockExecSync,
    spawn: mockSpawn,
}));

vi.mock('cross-spawn', () => ({
    spawn: mockSpawn,
}));

vi.mock('@/sandbox/manager', () => ({
    initializeSandbox: mockInitializeSandbox,
    wrapForMcpTransport: mockWrapForMcpTransport,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: mockLoggerDebug,
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('../package.json', () => ({
    default: { version: '0.0.1-test' },
}));

type MockRpcMessage = {
    id?: number;
    method?: string;
    params?: any;
    result?: any;
};

function pushJsonLine(stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }, payload: unknown) {
    stdout.push(JSON.stringify(payload) + '\n');
}

// Mock child process with stdin/stdout/stderr
function createMockProcess(opts?: {
    pid?: number;
    initializeDelayMs?: number;
    onRequest?: (msg: MockRpcMessage, stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }) => void;
}) {
    const { Readable, Writable } = require('stream');
    const initializeDelayMs = opts?.initializeDelayMs ?? 5;
    const stdin = new Writable({ write: (_: any, __: any, cb: () => void) => cb() });
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const proc = Object.assign(new (require('events').EventEmitter)(), {
        stdin,
        stdout,
        stderr,
        pid: opts?.pid ?? 12345,
        kill: vi.fn(),
    });
    // Send initialize response immediately when stdin is written to
    const origWrite = stdin.write.bind(stdin);
    stdin.write = (data: any, ...args: any[]) => {
        try {
            const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
            if (msg.method === 'initialize' && msg.id != null) {
                // Send response on next tick
                setTimeout(() => {
                    pushJsonLine(stdout, { id: msg.id, result: { userAgent: 'test' } });
                }, initializeDelayMs);
            }
            opts?.onRequest?.(msg, stdout);
        } catch {}
        return origWrite(data, ...args);
    };
    return proc;
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const sandboxConfig: SandboxConfig = {
    enabled: true,
    workspaceRoot: '~/projects',
    sessionIsolation: 'workspace',
    customWritePaths: [],
    denyReadPaths: ['~/.ssh'],
    extraWritePaths: ['/tmp'],
    denyWritePaths: ['.env'],
    networkMode: 'allowed',
    allowedDomains: [],
    deniedDomains: [],
    allowLocalBinding: true,
};

describe('CodexAppServerClient sandbox integration', () => {
    const originalRustLog = process.env.RUST_LOG;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.RUST_LOG = originalRustLog;
        mockExecSync.mockReturnValue('codex-cli 0.107.0');
        mockInitializeSandbox.mockResolvedValue(mockSandboxCleanup);
        mockWrapForMcpTransport.mockResolvedValue({ command: 'sh', args: ['-c', 'wrapped codex app-server'] });
        mockSpawn.mockImplementation(() => createMockProcess());
    });

    afterAll(() => {
        process.env.RUST_LOG = originalRustLog;
    });

    it('paginates model/list and preserves per-model reasoning capabilities', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const astra = { model: 'gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: 'Delegation' }] };
        const luna = { model: 'gpt-5.6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'max', description: 'Maximum' }] };
        const request = vi.spyOn(client as any, 'request')
            .mockResolvedValueOnce({ data: [astra, { model: 'hidden', hidden: true }], nextCursor: 'page2' })
            .mockResolvedValueOnce({ data: [luna], nextCursor: null });
        expect(await client.listModels()).toEqual([astra, luna]);
        expect(request).toHaveBeenNthCalledWith(1, 'model/list', { limit: 100, cursor: null, includeHidden: false });
        expect(request).toHaveBeenNthCalledWith(2, 'model/list', { limit: 100, cursor: 'page2', includeHidden: false });
    });

    it('wraps transport when sandbox is enabled', async () => {
        // Dynamic import to ensure mocks are applied
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockInitializeSandbox).toHaveBeenCalledWith(sandboxConfig, process.cwd());
        expect(mockWrapForMcpTransport).toHaveBeenCalledWith('codex', ['app-server', '--listen', 'stdio://']);
        expect(mockSpawn).toHaveBeenCalledWith(
            'sh',
            ['-c', 'wrapped codex app-server'],
            expect.objectContaining({
                env: expect.objectContaining({
                    CODEX_SANDBOX: 'seatbelt',
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
                }),
            }),
        );
        expect(client.sandboxEnabled).toBe(true);

        await client.disconnect();
    });

    it('falls back to non-sandbox transport when sandbox initialization fails', async () => {
        mockInitializeSandbox.mockRejectedValue(new Error('sandbox init failed'));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockWrapForMcpTransport).not.toHaveBeenCalled();
        expect(mockSpawn).toHaveBeenCalledWith(
            'codex',
            ['app-server', '--listen', 'stdio://'],
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
                }),
            }),
        );
        expect(client.sandboxEnabled).toBe(false);

        await client.disconnect();
    });

    it('resets sandbox on disconnect', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();
        await client.disconnect();

        expect(mockSandboxCleanup).toHaveBeenCalledTimes(1);
        expect(client.sandboxEnabled).toBe(false);
    });

    it('appends rollout log filter to existing RUST_LOG', async () => {
        process.env.RUST_LOG = 'info,codex_core=warn';
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockSpawn).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: 'info,codex_core=warn,codex_core::rollout::list=off',
                }),
            }),
        );

        await client.disconnect();
    });

    it('ignores stale process exit during reconnect initialize', async () => {
        const proc1 = createMockProcess({ pid: 1001, initializeDelayMs: 5 });
        const proc2 = createMockProcess({ pid: 1002, initializeDelayMs: 50 });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.disconnect();

        const reconnect = client.connect();
        setTimeout(() => {
            proc1.emit('exit', 0, null);
        }, 10);

        await expect(reconnect).resolves.toBeUndefined();
        await client.disconnect();
    });

    it('reconnects and resumes the same thread after forced restart timeout', async () => {
        const firstProcessRequests: MockRpcMessage[] = [];
        const secondProcessRequests: MockRpcMessage[] = [];
        type CapturedEvent = { type: string; [key: string]: unknown };

        const proc1 = createMockProcess({
            pid: 2001,
            onRequest: (msg, stdout) => {
                firstProcessRequests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-1', path: '/tmp/thread-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-1' } },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { abortReason: 'interrupted' } });
                    }, 0);
                }
            },
        });

        const proc2 = createMockProcess({
            pid: 2002,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);

                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-1', path: '/tmp/thread-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-2' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_complete', turn_id: 'turn-2' } },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: CapturedEvent[] = [];
        client.setEventHandler((msg) => {
            events.push(msg as CapturedEvent);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        const pendingTurn = client.sendTurnAndWait('hang forever', { turnTimeoutMs: 5000 });
        // The request reaching stdin is not enough: the mock answers on a
        // timer. Under CI load, a 1ms forced restart can otherwise disconnect
        // the still-pending turn/start RPC before task_started is processed,
        // testing setup timing rather than the active-turn restart path.
        await waitFor(() => client.turnId === 'turn-1');

        const abortResult = await client.abortTurnWithFallback({
            gracePeriodMs: 1,
            forceRestartOnTimeout: true,
        });

        await expect(pendingTurn).resolves.toEqual({ aborted: true });
        expect(abortResult).toEqual({
            hadActiveTurn: true,
            aborted: true,
            forcedRestart: true,
            resumedThread: true,
        });
        expect(events).toContainEqual(expect.objectContaining({
            type: 'turn_aborted',
            reason: 'interrupted',
            turn_id: 'turn-1',
            forced_restart: true,
        }));

        const resumeRequest = secondProcessRequests.find((msg) => msg.method === 'thread/resume');
        expect(resumeRequest?.params).toEqual(expect.objectContaining({
            threadId: 'thread-1',
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
            persistExtendedHistory: true,
        }));
        expect(client.threadId).toBe('thread-1');

        await expect(client.sendTurnAndWait('follow up after reconnect')).resolves.toEqual({ aborted: false });

        await client.disconnect();
    });

    it('releases the app-server while idle and resumes the same thread on the next turn (B-461)', async () => {
        const firstProcessRequests: MockRpcMessage[] = [];
        const secondProcessRequests: MockRpcMessage[] = [];

        const threadResult = {
            thread: { id: 'thread-idle', path: '/tmp/thread-idle' },
            model: 'gpt-test',
            modelProvider: 'openai',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: { type: 'workspaceWrite' },
            reasoningEffort: null,
        };
        const completeTurn = (msg: MockRpcMessage, stdout: any, turnId: string) => {
            setTimeout(() => {
                pushJsonLine(stdout, { id: msg.id, result: {} });
                pushJsonLine(stdout, { method: 'codex/event', params: { msg: { type: 'task_started', turn_id: turnId } } });
                pushJsonLine(stdout, { method: 'codex/event', params: { msg: { type: 'task_complete', turn_id: turnId } } });
            }, 0);
        };

        const proc1 = createMockProcess({
            pid: 3001,
            onRequest: (msg, stdout) => {
                firstProcessRequests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: threadResult }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) completeTurn(msg, stdout, 'turn-a');
            },
        });
        const proc2 = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);
                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: threadResult }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) completeTurn(msg, stdout, 'turn-b');
            },
        });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });
        await expect(client.sendTurnAndWait('first')).resolves.toEqual({ aborted: false });
        expect(mockSpawn).toHaveBeenCalledTimes(1);

        // Idle: the child is killed but the thread is remembered.
        await expect(client.releaseIdleProcess()).resolves.toBe(true);
        expect(proc1.kill).toHaveBeenCalledWith('SIGTERM');
        expect(client.hasProcess).toBe(false);
        expect(client.hasActiveThread()).toBe(true);
        expect(client.threadId).toBe('thread-idle');
        // Nothing left to release; must not throw or spawn.
        await expect(client.releaseIdleProcess()).resolves.toBe(false);
        expect(mockSpawn).toHaveBeenCalledTimes(1);

        // Next message: respawn, thread/resume with the remembered defaults, then turn/start.
        await expect(client.sendTurnAndWait('after idle')).resolves.toEqual({ aborted: false });
        expect(mockSpawn).toHaveBeenCalledTimes(2);
        expect(client.hasProcess).toBe(true);
        const methods = secondProcessRequests.map((msg) => msg.method);
        expect(methods.indexOf('initialize')).toBeLessThan(methods.indexOf('thread/resume'));
        expect(methods.indexOf('thread/resume')).toBeLessThan(methods.indexOf('turn/start'));
        const resumeRequest = secondProcessRequests.find((msg) => msg.method === 'thread/resume');
        expect(resumeRequest?.params).toEqual(expect.objectContaining({
            threadId: 'thread-idle',
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        }));
        const turnRequest = secondProcessRequests.find((msg) => msg.method === 'turn/start');
        expect(turnRequest?.params).toEqual(expect.objectContaining({ threadId: 'thread-idle' }));
        expect(firstProcessRequests.filter((msg) => msg.method === 'turn/start')).toHaveLength(1);

        await client.disconnect();
    });

    it('refuses to release the app-server while a turn is still running (B-461)', async () => {
        const proc = createMockProcess({
            pid: 3003,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-busy', path: '/tmp/thread-busy' },
                            model: 'gpt-test', modelProvider: 'openai', cwd: '/tmp/project',
                            approvalPolicy: 'on-request', sandbox: { type: 'readOnly' }, reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, { method: 'codex/event', params: { msg: { type: 'task_started', turn_id: 'turn-busy' } } });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementationOnce(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({ model: 'gpt-test', cwd: '/tmp/project' });

        const pendingTurn = client.sendTurnAndWait('hang', { turnTimeoutMs: 5000 });
        await waitFor(() => client.turnId === 'turn-busy');

        await expect(client.releaseIdleProcess()).resolves.toBe(false);
        expect(proc.kill).not.toHaveBeenCalled();
        expect(client.hasProcess).toBe(true);

        // Idle release never resolves the turn — only a real completion does.
        proc.stdout.push(JSON.stringify({ method: 'codex/event', params: { msg: { type: 'task_complete', turn_id: 'turn-busy' } } }) + '\n');
        await expect(pendingTurn).resolves.toEqual({ aborted: false });

        await client.disconnect();
    });

    it('forks, reads, and rolls back Codex threads through app-server RPC', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2501,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/fork' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    path: '/tmp/thread-forked',
                                    forkedFromId: 'thread-source',
                                    turns: [],
                                },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/read' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    turns: [
                                        { id: 'turn-1', items: [{ type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] }] },
                                    ],
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/rollback' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    turns: [
                                        { id: 'turn-1', items: [{ type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] }] },
                                    ],
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/inject_items' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {},
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        const forked = await client.forkThread({
            threadId: 'thread-source',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });
        const read = await client.readThread({ threadId: forked.threadId, includeTurns: true });
        const rolledBack = await client.rollbackThread({ threadId: forked.threadId, numTurns: 2 });
        const injected = await client.injectItems({
            threadId: forked.threadId,
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hello' }],
            }],
        });

        expect(forked.threadId).toBe('thread-forked');
        expect(read.thread.turns).toHaveLength(1);
        expect(rolledBack.thread.turns).toHaveLength(1);
        expect(injected).toEqual({});
        expect(requests.find((msg) => msg.method === 'thread/fork')?.params).toEqual(expect.objectContaining({
            threadId: 'thread-source',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        }));
        expect(requests.find((msg) => msg.method === 'thread/read')?.params).toEqual({
            threadId: 'thread-forked',
            includeTurns: true,
        });
        expect(requests.find((msg) => msg.method === 'thread/rollback')?.params).toEqual({
            threadId: 'thread-forked',
            numTurns: 2,
        });
        expect(requests.find((msg) => msg.method === 'thread/inject_items')?.params).toEqual({
            threadId: 'thread-forked',
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hello' }],
            }],
        });

        await client.disconnect();
    });

    it('clears active thread state so the next prompt starts a fresh thread', async () => {
        const requests: MockRpcMessage[] = [];
        let nextThreadNumber = 1;
        const proc = createMockProcess({
            pid: 2601,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    const threadId = `thread-${nextThreadNumber++}`;
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: threadId, path: `/tmp/${threadId}` },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        expect(client.threadId).toBe('thread-1');
        expect(client.hasActiveThread()).toBe(true);

        client.clearThreadState();

        expect(client.threadId).toBeNull();
        expect(client.turnId).toBeNull();
        expect(client.hasActiveThread()).toBe(false);

        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        expect(client.threadId).toBe('thread-2');
        expect(requests.filter((msg) => msg.method === 'thread/start')).toHaveLength(2);

        await client.disconnect();
    });

    it('maps raw item notifications into legacy events and deduplicates turn completion', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3001,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-1', path: '/tmp/thread-raw-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'active', activeFlags: [] } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: { id: 'turn-raw-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    status: 'inProgress',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    aggregatedOutput: '/tmp/project\n',
                                    exitCode: 0,
                                    durationMs: 1,
                                    status: 'completed',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-1',
                                    text: 'done',
                                    phase: 'final_answer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'idle' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: { id: 'turn-raw-1', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('run pwd')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-raw-1' }),
            expect.objectContaining({ type: 'exec_command_begin', callId: 'call-1' }),
            expect.objectContaining({ type: 'exec_command_end', callId: 'call-1', output: '/tmp/project\n' }),
            expect.objectContaining({ type: 'agent_message', message: 'done' }),
        ]));
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);

        await client.disconnect();
    });

    it('maps raw file change items into legacy patch events', async () => {
        const proc = createMockProcess({
            pid: 3003,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-3', path: '/tmp/thread-raw-3' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }, {
                                        path: 'MONETIZATION.md',
                                        type: 'add',
                                        content: '# Monetization\n\nPaid plans.\n',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'completed',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }, {
                                        path: 'MONETIZATION.md',
                                        type: 'add',
                                        content: '# Monetization\n\nPaid plans.\n',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-3',
                                    text: 'patched',
                                    phase: 'final_answer',
                                },
                            },
                        });
                        // B-622: the message no longer ends the turn; Codex does.
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turn: { id: 'turn-raw-3', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('patch the file')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'patch_apply_begin',
                callId: 'patch-1',
                changes: {
                    'README.md': {
                        diff: '@@ -1 +1 @@',
                        kind: { type: 'update', move_path: null },
                    },
                    'MONETIZATION.md': {
                        kind: { type: 'add', move_path: null },
                        add: { content: '# Monetization\n\nPaid plans.\n' },
                    },
                },
            }),
            expect.objectContaining({
                type: 'patch_apply_end',
                callId: 'patch-1',
                status: 'completed',
            }),
        ]));

        await client.disconnect();
    });

    it('hydrates v2 file change approvals from raw item metadata', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const proc = createMockProcess({
            pid: 3004,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-4', path: '/tmp/thread-raw-4' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-approval-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 99,
                            method: 'item/fileChange/requestApproval',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                itemId: 'patch-approval-1',
                                reason: null,
                                grantRoot: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'patch',
            callId: 'patch-approval-1',
            fileChanges: {
                'README.md': {
                    diff: '@@ -1 +1 @@',
                    kind: { type: 'update', move_path: null },
                },
            },
            reason: null,
        }));

        await client.disconnect();
    });

    // B-622 — the turn ends when Codex says it ends. Shapes below are what
    // codex 0.154.0 app-server actually sends (probed 2026-10-18).
    const threadStartResult = (threadId: string) => ({
        thread: { id: threadId, path: `/tmp/${threadId}` },
        model: 'gpt-test',
        modelProvider: 'openai',
        cwd: '/tmp/project',
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: null,
    });
    const turnStartedLines = (stdout: Parameters<typeof pushJsonLine>[0], id: number, threadId: string, turnId: string) => {
        pushJsonLine(stdout, { id, result: { turn: { id: turnId, items: [], status: 'inProgress', error: null } } });
        pushJsonLine(stdout, { method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: [] } } });
        pushJsonLine(stdout, { method: 'turn/started', params: { threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } } });
    };
    const GATEWAY_504 = 'unexpected status 504 Gateway Timeout: <html>\r\n<head><title>504 Gateway Time-out</title></head>\r\n<body>\r\n<center><h1>504 Gateway Time-out</h1></center>\r\n</body>\r\n</html>, url: http://gateway.test/v1/responses';

    it('B-622: a final_answer agent message mid-turn does not end the turn — turn/completed does', async () => {
        // send_message_to_user_async: a final_answer-phase message, then the
        // model keeps running tools; the turn only ends with turn/completed.
        const proc = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: threadStartResult('thread-raw-2') }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        turnStartedLines(stdout, msg.id!, 'thread-raw-2', 'turn-raw-2');
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-2',
                                turnId: 'turn-raw-2',
                                item: { type: 'agentMessage', id: 'msg-2', text: 'still working on it, now checking the tests', phase: 'final_answer', delivery: 'async' },
                            },
                        });
                    }, 0);
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: { threadId: 'thread-raw-2', turnId: 'turn-raw-2', item: { type: 'commandExecution', id: 'call-2', command: 'pnpm test', cwd: '/tmp/project', status: 'inProgress' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: { threadId: 'thread-raw-2', turnId: 'turn-raw-2', item: { type: 'commandExecution', id: 'call-2', command: 'pnpm test', cwd: '/tmp/project', aggregatedOutput: 'ok\n', exitCode: 0, durationMs: 1, status: 'completed' } },
                        });
                        pushJsonLine(stdout, { method: 'thread/status/changed', params: { threadId: 'thread-raw-2', status: { type: 'idle' } } });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: { threadId: 'thread-raw-2', turn: { id: 'turn-raw-2', items: [], status: 'completed', error: null } },
                        });
                    }, 60);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({ model: 'gpt-test', cwd: '/tmp/project', approvalPolicy: 'never', sandbox: 'danger-full-access' });

        let settled = false;
        const turn = client.sendTurnAndWait('continue').then((result) => { settled = true; return result; });
        await waitFor(() => events.some((event) => event.type === 'agent_message'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        // The async message has been delivered, nothing has ended.
        expect(settled).toBe(false);
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(0);

        await expect(turn).resolves.toEqual({ aborted: false });
        const types = events.map((event) => event.type);
        expect(types.filter((type) => type === 'task_complete')).toHaveLength(1);
        expect(types.indexOf('task_complete')).toBeGreaterThan(types.indexOf('exec_command_end'));

        await client.disconnect();
    });

    it('B-622: a failed turn/completed still surfaces the failure after the turn was already resolved', async () => {
        const proc = createMockProcess({
            pid: 3005,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: threadStartResult('thread-raw-5') }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        turnStartedLines(stdout, msg.id!, 'thread-raw-5', 'turn-raw-5');
                        // Something resolved the turn first without a verdict…
                        pushJsonLine(stdout, { method: 'thread/status/changed', params: { threadId: 'thread-raw-5', status: { type: 'idle' } } });
                        // …and the verdict is a gateway failure.
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-raw-5',
                                turn: { id: 'turn-raw-5', items: [], status: 'failed', error: { message: GATEWAY_504, codexErrorInfo: 'other', additionalDetails: null } },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({ model: 'gpt-test', cwd: '/tmp/project', approvalPolicy: 'never', sandbox: 'danger-full-access' });
        await expect(client.sendTurnAndWait('hi')).resolves.toEqual({ aborted: false });
        await waitFor(() => events.some((event) => event.type === 'task_complete' && event.status === 'failed'));

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_complete', turn_id: 'turn-raw-5', status: 'failed', error: expect.objectContaining({ message: GATEWAY_504 }) }),
        ]));
        // Still exactly one *successful* completion frame for the turn.
        expect(events.filter((event) => event.type === 'task_complete' && event.status !== 'failed')).toHaveLength(1);

        await client.disconnect();
    });

    it('B-622: forwards Codex retry notices as turn_retry and leaves the final error to turn/completed', async () => {
        const proc = createMockProcess({
            pid: 3006,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: threadStartResult('thread-raw-6') }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        turnStartedLines(stdout, msg.id!, 'thread-raw-6', 'turn-raw-6');
                        pushJsonLine(stdout, {
                            method: 'error',
                            params: {
                                error: { message: 'Reconnecting... 1/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 504 } }, additionalDetails: GATEWAY_504, misalignment: null },
                                willRetry: true,
                                threadId: 'thread-raw-6',
                                turnId: 'turn-raw-6',
                            },
                        });
                        pushJsonLine(stdout, { method: 'thread/status/changed', params: { threadId: 'thread-raw-6', status: { type: 'systemError' } } });
                        pushJsonLine(stdout, {
                            method: 'error',
                            params: { error: { message: GATEWAY_504, codexErrorInfo: 'other', additionalDetails: null, misalignment: null }, willRetry: false, threadId: 'thread-raw-6', turnId: 'turn-raw-6' },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: { threadId: 'thread-raw-6', turn: { id: 'turn-raw-6', items: [], status: 'failed', error: { message: GATEWAY_504, codexErrorInfo: 'other', additionalDetails: null } } },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({ model: 'gpt-test', cwd: '/tmp/project', approvalPolicy: 'never', sandbox: 'danger-full-access' });
        await expect(client.sendTurnAndWait('hi')).resolves.toEqual({ aborted: false });

        expect(events.filter((event) => event.type === 'turn_retry')).toEqual([
            expect.objectContaining({ type: 'turn_retry', message: 'Reconnecting... 1/5', http_status: 504, turn_id: 'turn-raw-6', details: GATEWAY_504 }),
        ]);
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_complete', status: 'failed', error: expect.objectContaining({ message: GATEWAY_504 }) }),
        ]));

        await client.disconnect();
    });

    it('B-622: the turn watchdog bounds silence, not turn length', async () => {
        const proc = createMockProcess({
            pid: 3007,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: threadStartResult('thread-raw-7') }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => turnStartedLines(stdout, msg.id!, 'thread-raw-7', 'turn-raw-7'), 0);
                    // Six signs of life 30ms apart: 180ms of work under an 80ms watchdog.
                    for (let i = 1; i <= 6; i += 1) {
                        setTimeout(() => pushJsonLine(stdout, {
                            method: 'item/commandExecution/outputDelta',
                            params: { threadId: 'thread-raw-7', turnId: 'turn-raw-7', itemId: 'call-7', delta: `line ${i}\n` },
                        }), i * 30);
                    }
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({ model: 'gpt-test', cwd: '/tmp/project', approvalPolicy: 'never', sandbox: 'danger-full-access' });

        const startedAt = Date.now();
        let settled = false;
        const turn = client.sendTurnAndWait('long task', { turnTimeoutMs: 80 }).then((result) => { settled = true; return result; });
        await new Promise((resolve) => setTimeout(resolve, 170));
        // Longer than the old fixed timeout would have allowed, still alive.
        expect(settled).toBe(false);
        expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(0);

        // Then Codex goes quiet: the watchdog gives the turn up and says so.
        await expect(turn).resolves.toEqual({ aborted: true });
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180 + 80 - 5);
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'turn_aborted', reason: 'timeout', turn_id: 'turn-raw-7', error: expect.objectContaining({ message: expect.stringContaining('sent nothing') }) }),
        ]));

        await client.disconnect();
    });

    it('B-622: the turn watchdog waits while an approval is open', async () => {
        const proc = createMockProcess({
            pid: 3008,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: threadStartResult('thread-raw-8') }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        turnStartedLines(stdout, msg.id!, 'thread-raw-8', 'turn-raw-8');
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'item/commandExecution/requestApproval',
                            params: { threadId: 'thread-raw-8', turnId: 'turn-raw-8', itemId: 'call-8', command: 'rm -rf build', cwd: '/tmp/project', reason: null },
                        });
                    }, 0);
                }
                // Our answer arrives (id 77) → Codex finishes the turn.
                if (msg.id === 77 && msg.method == null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        method: 'turn/completed',
                        params: { threadId: 'thread-raw-8', turn: { id: 'turn-raw-8', items: [], status: 'completed', error: null } },
                    }), 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });
        // A human taking 150ms to decide, under a 60ms watchdog.
        client.setApprovalHandler(() => new Promise((resolve) => setTimeout(() => resolve('approved'), 150)));

        await client.connect();
        await client.startThread({ model: 'gpt-test', cwd: '/tmp/project', approvalPolicy: 'on-request', sandbox: 'workspace-write' });

        await expect(client.sendTurnAndWait('clean up', { turnTimeoutMs: 60 })).resolves.toEqual({ aborted: false });
        expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(0);

        await client.disconnect();
    });

    it('responds to MCP elicitation requests with an action payload', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3007,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-7', path: '/tmp/thread-raw-7' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'mcpServer/elicitation/request',
                            params: {
                                threadId: 'thread-raw-7',
                                turnId: 'turn-raw-7',
                                serverName: 'happy',
                                mode: 'form',
                                _meta: {
                                    codex_approval_kind: 'mcp_tool_call',
                                    tool_title: 'Change Chat Title',
                                    tool_description: 'Change the title of the current chat session',
                                    tool_params: { title: 'Casual Greeting' },
                                },
                                message: 'Allow the happy MCP server to run tool "change_title"?',
                                requestedSchema: {
                                    type: 'object',
                                    properties: {},
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);
        await waitFor(() => requests.some((msg) => msg.id === 77 && msg.result?.action === 'accept'));

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'mcp',
            callId: 'happy:77',
            toolName: 'change_title',
            input: { title: 'Casual Greeting' },
            serverName: 'happy',
        }));
        expect(requests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 77,
                result: {
                    action: 'accept',
                    content: {},
                    _meta: null,
                },
            }),
        ]));

        await client.disconnect();
    });

    it('does not log non-JSON or unhandled message contents', async () => {
        const secret = 'secret-sentinel-do-not-log';
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        (client as any).handleLine(`not-json ${secret}`);
        (client as any).handleLine(JSON.stringify({ privateBody: secret }));

        const serializedLogs = JSON.stringify(mockLoggerDebug.mock.calls);
        expect(serializedLogs).not.toContain(secret);
        expect(serializedLogs).not.toContain('privateBody');
        expect(serializedLogs).toContain('valueBytes');
        expect(serializedLogs).toContain('payloadBytes');
    });

    it('forwards the real thread token-usage notification shape', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        (client as any).handleLine(JSON.stringify({
            method: 'thread/tokenUsage/updated',
            params: {
                threadId: 'thread-usage',
                turnId: 'turn-usage',
                tokenUsage: {
                    total: {
                        totalTokens: 140,
                        inputTokens: 100,
                        cachedInputTokens: 60,
                        cacheWriteInputTokens: 4,
                        outputTokens: 40,
                        reasoningOutputTokens: 10,
                    },
                    last: {
                        totalTokens: 20,
                        inputTokens: 15,
                        cachedInputTokens: 5,
                        cacheWriteInputTokens: 0,
                        outputTokens: 5,
                        reasoningOutputTokens: 2,
                    },
                    modelContextWindow: 200_000,
                },
            },
        }));

        expect(events).toEqual([expect.objectContaining({
            type: 'token_count',
            total: expect.objectContaining({ totalTokens: 140, inputTokens: 100, outputTokens: 40 }),
            last: expect.objectContaining({ totalTokens: 20 }),
        })]);
    });
});

it('passes native local images alongside the text manifest without expanding sandbox permissions', async () => {
    const { CodexAppServerClient } = await import('./codexAppServerClient');
    const client = new CodexAppServerClient();
    (client as any)._threadId = 'image-thread';
    // sendTurn() now reconnects a released app-server first (B-461); this unit
    // test never spawned one, so present it as already connected.
    (client as any).connected = true;
    const request = vi.spyOn(client as any, 'request').mockResolvedValue({ turn: { id: 'image-turn' } });
    await client.sendTurn('Inspect attached file', { images: ['/private/chat/photo.png'], sandbox: 'read-only' });
    expect(request).toHaveBeenCalledWith('turn/start', {
        threadId: 'image-thread',
        input: [{ type: 'text', text: 'Inspect attached file' }, { type: 'localImage', path: '/private/chat/photo.png' }],
        sandboxPolicy: { type: 'readOnly' },
    });
});
