import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe('CodexAppServerClient rate limits (B-555)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockExecSync.mockReturnValue('codex-cli 0.154.0');
    });

    it('reads once after connect and forwards account/rateLimits/updated notifications', async () => {
        const reads: number[] = [];
        let stdoutRef: any = null;
        const makeProc = () => createMockProcess({
            onRequest: (msg, stdout) => {
                stdoutRef = stdout;
                if (msg.method === 'account/rateLimits/read' && msg.id != null) {
                    reads.push(msg.id);
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1791836601 }, secondary: null } },
                    }), 1);
                }
            },
        });
        mockSpawn.mockImplementation(makeProc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const seen: unknown[] = [];
        client.setRateLimitHandler((snapshot) => seen.push(snapshot));
        await client.connect();
        await waitFor(() => seen.length === 1);
        expect(reads).toHaveLength(1);
        expect(seen[0]).toMatchObject({ primary: { usedPercent: 12 } });

        pushJsonLine(stdoutRef, { method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: null, secondary: null } } });
        await waitFor(() => seen.length === 2);
        expect(seen[1]).toMatchObject({ primary: null });

        // Throttled: a reconnect inside the interval does not read again.
        await client.disconnect();
        await client.connect();
        await new Promise((r) => setTimeout(r, 20));
        expect(reads).toHaveLength(1);
        await client.disconnect();
    });

    it('stops reading after the app-server says the method does not exist', async () => {
        let reads = 0;
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                if (msg.method === 'account/rateLimits/read' && msg.id != null) {
                    reads += 1;
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, error: { code: -32600, message: 'Invalid request: unknown variant `account/rateLimits/read`' } }), 1);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const handler = vi.fn();
        client.setRateLimitHandler(handler);
        await client.connect();
        await waitFor(() => reads === 1);
        await new Promise((r) => setTimeout(r, 10));
        expect((client as any).rateLimitReadUnsupported).toBe(true);
        expect(handler).not.toHaveBeenCalled();
        await client.disconnect();
    });
});
