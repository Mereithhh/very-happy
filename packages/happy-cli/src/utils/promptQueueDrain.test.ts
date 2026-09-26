import { describe, expect, it } from 'vitest';
import { PROMPT_QUEUE_INFLIGHT_TIMEOUT_MS, PromptQueueDrain, type PromptQueueDispatchOutcome } from './promptQueueDrain';

function harness(opts?: { idle?: boolean; outcomes?: PromptQueueDispatchOutcome[]; inflightTimeoutMs?: number }) {
    let now = 1_000_000;
    let idle = opts?.idle ?? true;
    const outcomes = [...(opts?.outcomes ?? [])];
    const calls: string[] = [];
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const drain = new PromptQueueDrain({
        isIdle: () => idle,
        dispatch: async () => {
            calls.push('dispatch');
            return outcomes.shift() ?? { kind: 'empty' };
        },
        now: () => now,
        schedule: (fn, delayMs) => { scheduled.push({ fn, delayMs }); },
        inflightTimeoutMs: opts?.inflightTimeoutMs,
    });
    return {
        drain, calls, scheduled, outcomes,
        setIdle: (value: boolean) => { idle = value; },
        advance: (ms: number) => { now += ms; },
    };
}

describe('B-509 PromptQueueDrain', () => {
    it('dispatches only when the runner is idle', async () => {
        const h = harness({ idle: false, outcomes: [{ kind: 'dispatched', localId: 'a' }] });
        expect(await h.drain.maybeDispatch('idle')).toBe(false);
        expect(h.calls).toEqual([]);
        h.setIdle(true);
        expect(await h.drain.maybeDispatch('idle')).toBe(true);
        expect(h.calls).toEqual(['dispatch']);
    });

    it('holds further dispatches until the dispatched message is routed (one item per turn)', async () => {
        const h = harness({ outcomes: [{ kind: 'dispatched', localId: 'a' }, { kind: 'dispatched', localId: 'b' }] });
        await h.drain.onIdle();
        expect(h.drain.state().inflight?.localId).toBe('a');
        // The queue snapshot after our own pop still lists item b — must not pop it yet.
        h.drain.onQueueChanged(1);
        await Promise.resolve();
        expect(h.calls).toHaveLength(1);
        // Someone else's message does not release the guard.
        h.drain.onInbound('unrelated');
        expect(h.drain.state().inflight?.localId).toBe('a');
        h.drain.onInbound('a');
        expect(h.drain.state().inflight).toBeNull();
        // Once routed the runner's queue is non-empty, so the runner reports busy…
        h.setIdle(false);
        await h.drain.maybeDispatch('queue-changed');
        expect(h.calls).toHaveLength(1);
        // …and the next idle edge (turn over) pops the next item.
        h.setIdle(true);
        await h.drain.maybeDispatch('idle');
        expect(h.calls).toHaveLength(2);
        expect(h.drain.state().inflight?.localId).toBe('b');
    });

    it('releases a never-routed inflight item after the timeout so a lost socket cannot wedge the queue — and re-checks by itself', async () => {
        const h = harness({ outcomes: [{ kind: 'dispatched', localId: 'a' }, { kind: 'dispatched', localId: 'b' }] });
        await h.drain.maybeDispatch('idle');
        // Nothing else will poke the drain while the runner sits idle: it arms its own re-check.
        expect(h.scheduled.map((entry) => entry.delayMs)).toEqual([PROMPT_QUEUE_INFLIGHT_TIMEOUT_MS + 1]);
        h.advance(PROMPT_QUEUE_INFLIGHT_TIMEOUT_MS - 1);
        expect(await h.drain.maybeDispatch('idle')).toBe(false);
        h.advance(2);
        h.scheduled[0].fn();
        await Promise.resolve(); await Promise.resolve();
        expect(h.calls).toHaveLength(2);
        expect(h.drain.state().inflight?.localId).toBe('b');
    });

    it('the dispatched message can be routed BEFORE the dispatch call returns (server echo beats HTTP): no inflight is armed', async () => {
        let resolveDispatch: (outcome: PromptQueueDispatchOutcome) => void = () => {};
        let calls = 0;
        const drain = new PromptQueueDrain({
            isIdle: () => true,
            dispatch: () => { calls += 1; return new Promise((resolve) => { resolveDispatch = resolve; }); },
            schedule: () => {},
        });
        const first = drain.maybeDispatch('idle');
        drain.onInbound('a');            // socket echo lands first
        resolveDispatch({ kind: 'dispatched', localId: 'a' });
        await first;
        expect(drain.state().inflight).toBeNull();
        // The runner is idle again after that turn: the next item goes out at once, no 20 s stall.
        const second = drain.maybeDispatch('idle');
        resolveDispatch({ kind: 'dispatched', localId: 'b' });
        await second;
        expect(calls).toBe(2);
        expect(drain.state().inflight?.localId).toBe('b');
    });

    it('a 404 disables the drain for the rest of the process (old server, zero side effects)', async () => {
        const h = harness({ outcomes: [{ kind: 'unsupported' }, { kind: 'dispatched', localId: 'never' }] });
        await h.drain.onIdle();
        expect(h.drain.state().disabled).toBe(true);
        h.drain.onQueueChanged(3);
        await h.drain.maybeDispatch('idle');
        expect(h.calls).toHaveLength(1);
    });

    it('backs off exponentially after errors and retries on the schedule, capped at 30 s', async () => {
        const h = harness({ outcomes: [{ kind: 'error', message: 'boom' }, { kind: 'error', message: 'boom' }, { kind: 'dispatched', localId: 'a' }] });
        await h.drain.maybeDispatch('idle');
        expect(h.scheduled.map((entry) => entry.delayMs)).toEqual([1000]);
        // Within the window nothing is sent, and no second timer is armed.
        await h.drain.maybeDispatch('idle');
        expect(h.calls).toHaveLength(1);
        expect(h.scheduled).toHaveLength(1);
        h.advance(1000);
        h.scheduled[0].fn();
        await Promise.resolve(); await Promise.resolve();
        expect(h.calls).toHaveLength(2);
        expect(h.scheduled[1].delayMs).toBe(2000);
        h.advance(2000);
        h.scheduled[1].fn();
        await Promise.resolve(); await Promise.resolve();
        expect(h.calls).toHaveLength(3);
        expect(h.drain.state()).toMatchObject({ failures: 0, inflight: { localId: 'a' } });
        expect(h.scheduled.at(-1)?.delayMs).toBe(PROMPT_QUEUE_INFLIGHT_TIMEOUT_MS + 1); // the inflight re-check, not a retry
        // Cap: 2^n growth never exceeds 30 s.
        const capped = harness({ outcomes: Array.from({ length: 8 }, () => ({ kind: 'error' as const, message: 'x' })) });
        for (let index = 0; index < 8; index += 1) {
            await capped.drain.maybeDispatch('idle');
            capped.advance(60_000);
            capped.scheduled.pop();
            // simulate the timer firing by clearing the flag through a fresh call
            (capped.drain as unknown as { retryScheduled: boolean }).retryScheduled = false;
        }
        expect(capped.drain.state().retryAt - 1_000_000).toBeLessThanOrEqual(8 * 60_000 + 30_000);
    });

    it('an empty queue is not an error and does not arm any retry; a queue-changed with 0 items is ignored', async () => {
        const h = harness({ outcomes: [{ kind: 'empty' }] });
        expect(await h.drain.maybeDispatch('idle')).toBe(false);
        expect(h.scheduled).toEqual([]);
        h.drain.onQueueChanged(0);
        await Promise.resolve();
        expect(h.calls).toHaveLength(1);
    });

    it('never dispatches concurrently and stops after close', async () => {
        let resolveDispatch: (outcome: PromptQueueDispatchOutcome) => void = () => {};
        let calls = 0;
        const drain = new PromptQueueDrain({
            isIdle: () => true,
            dispatch: () => { calls += 1; return new Promise((resolve) => { resolveDispatch = resolve; }); },
            schedule: () => {},
        });
        const first = drain.maybeDispatch('idle');
        expect(await drain.maybeDispatch('queue-changed')).toBe(false);
        resolveDispatch({ kind: 'empty' });
        await first;
        expect(calls).toBe(1);
        drain.close();
        expect(await drain.maybeDispatch('idle')).toBe(false);
        expect(calls).toBe(1);
    });
});
