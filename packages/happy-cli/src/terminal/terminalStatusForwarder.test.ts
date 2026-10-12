/**
 * B-547: scripts/terminal_status_forwarder.cjs, run as the real child process
 * claude would spawn. The contract that matters most is what it does NOT do:
 * no prompt / tool / assistant text leaves the machine-local hook, nothing is
 * written to stdout (claude would read it as a decision or extra context),
 * and every failure exits 0.
 */
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const FORWARDER = resolve(process.cwd(), 'scripts/terminal_status_forwarder.cjs');
const homes: string[] = [];

afterEach(async () => {
    await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

function runForwarder(args: string[], stdin: string): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolveRun) => {
        const child = spawn(process.execPath, [FORWARDER, ...args], { stdio: ['pipe', 'pipe', 'ignore'] });
        let stdout = '';
        child.stdout.on('data', (d) => { stdout += String(d); });
        child.on('exit', (code) => resolveRun({ code, stdout }));
        // The forwarder may exit before reading stdin (bad args) — EPIPE is fine.
        child.stdin.on('error', () => undefined);
        child.stdin.end(stdin);
    });
}

async function withDaemon(token: string | undefined, fn: (home: string, received: Promise<{ path?: string; auth?: string; body: any }>) => Promise<void>) {
    const home = await mkdtemp(join(tmpdir(), 'vh-status-fwd-'));
    homes.push(home);
    let done!: (v: { path?: string; auth?: string; body: any }) => void;
    const received = new Promise<{ path?: string; auth?: string; body: any }>((r) => { done = r; });
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            res.writeHead(200).end('{"status":"ok"}');
            done({ path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    await writeFile(join(home, 'daemon.state.json'), JSON.stringify({ httpPort: address.port, ...(token ? { controlToken: token } : {}) }));
    try {
        await fn(home, received);
    } finally {
        await new Promise<void>((r) => server.close(() => r()));
    }
}

describe('terminal status forwarder (B-547)', () => {
    it('posts a whitelisted payload with the control token, prints nothing, exits 0', async () => {
        await withDaemon('secret-token', async (home, received) => {
            const input = {
                hook_event_name: 'UserPromptSubmit', session_id: 's-1', transcript_path: '/x/s-1.jsonl', cwd: '/x',
                prompt_id: 'p-9', prompt: 'please refactor my secret thing',
                tool_input: { command: 'rm -rf /' }, tool_response: 'big', last_assistant_message: 'hi',
            };
            const result = await runForwarder(['term_1', home, '4242'], JSON.stringify(input));
            const got = await received;
            expect(result).toEqual({ code: 0, stdout: '' });
            expect(got.path).toBe('/terminal-agent-hook');
            expect(got.auth).toBe('Bearer secret-token');
            expect(got.body).toEqual({
                terminalId: 'term_1', claudePid: 4242,
                hook_event_name: 'UserPromptSubmit', session_id: 's-1', transcript_path: '/x/s-1.jsonl', cwd: '/x', prompt_id: 'p-9',
                promptHash: expect.stringMatching(/^[0-9a-f]{16}$/),
            });
            expect(JSON.stringify(got.body)).not.toContain('secret thing');
        });
    });

    it('marks an old-style permission Notification without a type', async () => {
        await withDaemon(undefined, async (home, received) => {
            await runForwarder(['t1', home, '7'], JSON.stringify({ hook_event_name: 'Notification', session_id: 's', message: 'Claude needs your permission to use Bash' }));
            const got = await received;
            expect(got.auth).toBeUndefined();
            expect(got.body).toMatchObject({ hook_event_name: 'Notification', permissionHint: true });
            expect(got.body.message).toBeUndefined();
        });
    });

    it('exits 0 silently with no daemon, bad args, or garbage input', async () => {
        const home = await mkdtemp(join(tmpdir(), 'vh-status-fwd-'));
        homes.push(home);
        expect(await runForwarder(['t1', home, '1'], '{"hook_event_name":"Stop","session_id":"s"}')).toEqual({ code: 0, stdout: '' });
        expect(await runForwarder(['bad id', home, '1'], '{}')).toEqual({ code: 0, stdout: '' });
        expect(await runForwarder([], '{}')).toEqual({ code: 0, stdout: '' });
        await writeFile(join(home, 'daemon.state.json'), JSON.stringify({ httpPort: 1 }));
        expect(await runForwarder(['t1', home, '1'], 'not json')).toEqual({ code: 0, stdout: '' });
        expect(await runForwarder(['t1', home, '1'], '{"hook_event_name":"Stop","session_id":"s"}')).toEqual({ code: 0, stdout: '' });
    });
});
