/**
 * B-662 — `pullingNext` must be released the moment the pulled message is in
 * the Query, not a few microtasks later in `.finally`. A result that lands in
 * that window (the CLI answers a short prompt immediately, or the pull path
 * gains one more `await`) used to find the flag still set, log "Already
 * waiting for the next message" and return — nothing ever pulled again and the
 * queued message sat there until the session was restarted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { query } from '@/claude/sdk';
import type { EnhancedMode } from './loop';

vi.mock('@/claude/sdk', () => ({
    query: vi.fn(),
    AbortError: class AbortError extends Error {},
}));

const mode: EnhancedMode = { permissionMode: 'default' };

/** A Query that answers every prompt with a result as soon as it reads it. */
function instantResultQuery(observed: string[]) {
    vi.mocked(query).mockImplementation((args: any) => ({
        setPermissionMode: vi.fn(),
        interrupt: vi.fn(),
        async *[Symbol.asyncIterator]() {
            const input = args.prompt[Symbol.asyncIterator]();
            for (;;) {
                const next = await input.next();
                if (next.done) return;
                observed.push(next.value.message.content);
                yield { type: 'result', subtype: 'success', is_error: false };
            }
        },
    } as any));
}

function run(nextMessage: () => Promise<{ message: string; mode: EnhancedMode } | null>) {
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
    });
}

describe('claudeRemote pulling the next message (B-662)', () => {
    beforeEach(() => vi.mocked(query).mockReset());

    it('delivers every queued message when each result lands right after its push', async () => {
        const observed: string[] = [];
        instantResultQuery(observed);
        const queue = ['first', 'second', 'third', 'fourth'];
        const nextMessage = vi.fn(async () => {
            const m = queue.shift();
            return m ? { message: m, mode } : null;
        });
        await run(nextMessage);
        expect(observed).toEqual(['first', 'second', 'third', 'fourth']);
        expect(nextMessage).toHaveBeenCalledTimes(5); // four messages + the null that ends the Query
    });

    it('still delivers them when the pull path adds microtasks of its own', async () => {
        const observed: string[] = [];
        instantResultQuery(observed);
        const queue = ['first', 'second', 'third'];
        // Extra hops between "the waiter resolved" and "the value arrives" —
        // the shape B-634 had to avoid instead of fixing (#603).
        const nextMessage = vi.fn(() => Promise.resolve().then(() => Promise.resolve()).then(async () => {
            await null;
            const m = queue.shift();
            return m ? { message: m, mode } : null;
        }));
        await run(nextMessage);
        expect(observed).toEqual(['first', 'second', 'third']);
    });

    it('keeps one puller at a time: two results in a row push one message', async () => {
        const observed: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        vi.mocked(query).mockImplementation((args: any) => ({
            setPermissionMode: vi.fn(),
            interrupt: vi.fn(),
            async *[Symbol.asyncIterator]() {
                const input = args.prompt[Symbol.asyncIterator]();
                observed.push((await input.next()).value.message.content);
                // A pre-empted turn's result and the next one's, back to back,
                // while the queue is still empty (B-631).
                yield { type: 'result', subtype: 'success', is_error: false };
                yield { type: 'result', subtype: 'success', is_error: false };
                release();
                const second = await input.next();
                observed.push(second.value.message.content);
                yield { type: 'result', subtype: 'success', is_error: false };
                expect((await input.next()).done).toBe(true);
            },
        } as any));
        let n = 0;
        const nextMessage = vi.fn(async () => {
            n += 1;
            if (n === 1) return { message: 'first', mode };
            if (n === 2) { await gate; return { message: 'queued', mode }; }
            return null;
        });
        await run(nextMessage);
        expect(observed).toEqual(['first', 'queued']);
        expect(nextMessage).toHaveBeenCalledTimes(3);
    });
});
