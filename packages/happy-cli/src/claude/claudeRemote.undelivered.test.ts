/**
 * B-853 — a Query whose input has closed must never take another message.
 *
 * Reproduced on dev-sg (B-851b, session c7): a web message with a different
 * mode was parked for a relaunch, `nextMessage` returned null and the input
 * ended — but the old Claude Code process still had a background Bash task.
 * Its task notification ended one more turn, the result pulled again, took the
 * PARKED message, `setModel` failed with "Query closed before response
 * received", `messages.push` threw into a `.catch` that swallowed it, and the
 * message was gone: not in the transcript, not in the log, no tombstone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { query } from '@/claude/sdk';
import type { EnhancedMode } from './loop';

vi.mock('@/claude/sdk', () => ({
    query: vi.fn(),
    AbortError: class AbortError extends Error {},
}));

const opus: EnhancedMode = { permissionMode: 'bypassPermissions', model: 'claude-opus-5-5' };
const haiku: EnhancedMode = { permissionMode: 'bypassPermissions', model: 'haiku' };
const result = { type: 'result', subtype: 'success', is_error: false };
type Pulled = { message: string; mode: EnhancedMode; uuid?: string } | null;

function run(nextMessage: () => Promise<Pulled>, extra: Record<string, unknown> = {}) {
    return claudeRemote({
        sessionId: null,
        path: process.cwd(),
        allowedTools: [],
        hookSettingsPath: '/unused-test-settings.json',
        nextMessage,
        onReady: vi.fn(),
        canCallTool: async () => ({ behavior: 'allow' }) as any,
        isAborted: () => false,
        onSessionFound: vi.fn(),
        onMessage: vi.fn(),
        ...extra,
    });
}

describe('claudeRemote after its input closed (B-853)', () => {
    beforeEach(() => vi.mocked(query).mockReset());

    it('a background-task turn after the relaunch hand-off does not pull the parked message', async () => {
        const observed: string[] = [];
        vi.mocked(query).mockImplementation((args: any) => ({
            setPermissionMode: vi.fn(),
            setModel: vi.fn(async () => {}),
            interrupt: vi.fn(),
            async *[Symbol.asyncIterator]() {
                const input = args.prompt[Symbol.asyncIterator]();
                observed.push((await input.next()).value.message.content);
                yield result; // turn 1 ends → pull → mode change → null → input ends
                expect((await input.next()).done).toBe(true);
                // The background task finishes: Claude Code runs a turn of its
                // own (announced like any turn, c7: `running` then a result).
                yield { type: 'system', subtype: 'session_state_changed', state: 'running' };
                yield result;
            },
        } as any));
        const queue: Pulled[] = [{ message: 'first', mode: opus }, null, { message: 'parked', mode: haiku }];
        const nextMessage = vi.fn(async () => queue.shift() ?? null);
        const onUndeliveredMessage = vi.fn();
        await run(nextMessage, { onUndeliveredMessage });
        await new Promise((r) => setTimeout(r, 10));
        expect(observed).toEqual(['first']);
        // first + the null that closed the input — the parked one stays for the next launch.
        expect(nextMessage).toHaveBeenCalledTimes(2);
        expect(onUndeliveredMessage).not.toHaveBeenCalled();
    });

    it('a message pulled while the Query was ending is handed back, not dropped', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const setModel = vi.fn(async () => {});
        vi.mocked(query).mockImplementation((args: any) => ({
            setPermissionMode: vi.fn(),
            setModel,
            interrupt: vi.fn(),
            async *[Symbol.asyncIterator]() {
                const input = args.prompt[Symbol.asyncIterator]();
                await input.next();
                yield result; // pull starts…
                // …and the process exits before the queue answers.
            },
        } as any));
        let n = 0;
        const nextMessage = vi.fn(async (): Promise<Pulled> => {
            n += 1;
            if (n === 1) return { message: 'first', mode: opus };
            await gate;
            return { message: 'second', mode: haiku, uuid: 'u-2' };
        });
        const onUndeliveredMessage = vi.fn();
        await run(nextMessage, { onUndeliveredMessage });
        release();
        await new Promise((r) => setTimeout(r, 10));
        expect(onUndeliveredMessage).toHaveBeenCalledWith({ message: 'second', mode: haiku, uuid: 'u-2' });
        expect(setModel).not.toHaveBeenCalled(); // no control request to a dead Query
    });

    it('a Query that ends while a model switch is in flight still hands the message back', async () => {
        let closeQuery!: () => void;
        const closed = new Promise<{ done: true }>((r) => { closeQuery = () => r({ done: true }); });
        vi.mocked(query).mockImplementation((args: any) => ({
            setPermissionMode: vi.fn(),
            setModel: vi.fn(async () => {
                closeQuery();
                await new Promise((r) => setTimeout(r, 5));
            }),
            interrupt: vi.fn(),
            async *[Symbol.asyncIterator]() {
                const input = args.prompt[Symbol.asyncIterator]();
                await input.next();
                yield result;
                await Promise.race([input.next(), closed]);
            },
        } as any));
        const queue: Pulled[] = [{ message: 'first', mode: opus }, { message: 'switch', mode: haiku, uuid: 'u-2' }];
        const nextMessage = vi.fn(async () => queue.shift() ?? null);
        const onUndeliveredMessage = vi.fn();
        await run(nextMessage, { onUndeliveredMessage });
        await new Promise((r) => setTimeout(r, 20));
        expect(onUndeliveredMessage).toHaveBeenCalledWith({ message: 'switch', mode: haiku, uuid: 'u-2' });
    });

    it('setModel failing because the Query closed hands the message back on the model it asked for', async () => {
        let closeQuery!: () => void;
        const closed = new Promise<{ done: true }>((r) => { closeQuery = () => r({ done: true }); });
        vi.mocked(query).mockImplementation((args: any) => ({
            setPermissionMode: vi.fn(),
            setModel: vi.fn(async () => {
                closeQuery();
                await new Promise((r) => setTimeout(r, 5));
                throw new Error('Query closed before response received');
            }),
            interrupt: vi.fn(),
            async *[Symbol.asyncIterator]() {
                const input = args.prompt[Symbol.asyncIterator]();
                await input.next();
                yield result;
                await Promise.race([input.next(), closed]);
            },
        } as any));
        const queue: Pulled[] = [{ message: 'first', mode: opus }, { message: 'switch', mode: haiku, uuid: 'u-2' }];
        const nextMessage = vi.fn(async () => queue.shift() ?? null);
        const onUndeliveredMessage = vi.fn();
        const onCompletionEvent = vi.fn();
        await run(nextMessage, { onUndeliveredMessage, onCompletionEvent });
        await new Promise((r) => setTimeout(r, 20));
        expect(onUndeliveredMessage).toHaveBeenCalledWith({ message: 'switch', mode: haiku, uuid: 'u-2' });
        // Not a model problem: no "model switch failed, staying on opus" notice.
        expect(onCompletionEvent).not.toHaveBeenCalled();
    });
});
