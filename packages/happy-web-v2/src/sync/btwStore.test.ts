import { describe, expect, it, vi } from 'vitest';
import { createBtwStore } from './btwStore';
import type { SideQuestionPollResponse } from './ops';

function harness(polls: Array<Partial<SideQuestionPollResponse> | Error>, askImpl?: () => Promise<any>) {
    let clock = 5000;
    const queue = [...polls];
    const ask = vi.fn(askImpl ?? (async () => ({ requestId: 'req-1', hadContext: true })));
    const poll = vi.fn(async (_s: string, requestId: string) => {
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return { requestId, status: 'running', text: '', startedAt: 5000, ...next } as SideQuestionPollResponse;
    });
    const cancel = vi.fn(async () => true);
    const delay = vi.fn(async () => { clock += 1000; });
    const store = createBtwStore({ ask, poll, cancel, delay, now: () => clock, pollMs: 1000 });
    return { store, ask, poll, cancel, delay };
}

describe('btwStore ask/poll loop (B-279)', () => {
    it('records the exchange, streams partial text and lands on done', async () => {
        const h = harness([{ text: 'part' }, { text: 'partial answer', status: 'done', finishedAt: 7000 }]);
        await h.store.getState().ask('s1', '  why?  ');
        const [exchange] = h.store.getState().sessions.s1.exchanges;
        expect(exchange).toEqual(expect.objectContaining({
            question: 'why?', answer: 'partial answer', status: 'done', requestId: 'req-1', hadContext: true, finishedAt: 7000,
        }));
        expect(h.ask).toHaveBeenCalledWith('s1', 'why?', []);
        expect(h.poll).toHaveBeenCalledTimes(2);
        expect(h.store.getState().sessions.s1.draft).toBe('');
    });

    it('sends earlier answered exchanges as history and refuses a second concurrent ask', async () => {
        const h = harness([{ text: 'a1', status: 'done' }, { text: 'a2', status: 'done' }]);
        await h.store.getState().ask('s1', 'q1');
        await h.store.getState().ask('s1', 'q2');
        expect(h.ask.mock.calls[1]).toEqual(['s1', 'q2', [{ question: 'q1', answer: 'a1' }]]);
        // a running question blocks a new one
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const slow = harness([], async () => { await gate; return { requestId: 'r', hadContext: true }; });
        const first = slow.store.getState().ask('s2', 'first');
        await slow.store.getState().ask('s2', 'second');
        expect(slow.ask).toHaveBeenCalledTimes(1);
        expect(slow.store.getState().sessions.s2.exchanges).toHaveLength(1);
        release();
        slow.poll.mockResolvedValueOnce({ requestId: 'r', status: 'done', text: 'ok', startedAt: 0 } as any);
        await first;
    });

    it('marks an ask failure (old CLI / offline) as error without polling', async () => {
        const h = harness([], async () => { throw new Error('Method not found'); });
        await h.store.getState().ask('s1', 'q');
        expect(h.store.getState().sessions.s1.exchanges[0]).toEqual(expect.objectContaining({ status: 'error', error: 'Method not found' }));
        expect(h.poll).not.toHaveBeenCalled();
    });

    it('tolerates transient poll failures but gives up after five in a row', async () => {
        const flaky = harness([new Error('timeout'), { text: 'x', status: 'done' }]);
        await flaky.store.getState().ask('s1', 'q');
        expect(flaky.store.getState().sessions.s1.exchanges[0].status).toBe('done');
        const dead = harness(Array.from({ length: 5 }, () => new Error('socket closed')));
        await dead.store.getState().ask('s1', 'q');
        expect(dead.store.getState().sessions.s1.exchanges[0]).toEqual(expect.objectContaining({ status: 'error', error: 'socket closed' }));
        expect(dead.poll).toHaveBeenCalledTimes(5);
    });

    it('cancel finalises locally, tells the wrapper, and stops the poll loop', async () => {
        const h = harness([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
        const run = h.store.getState().ask('s1', 'q');
        await Promise.resolve();
        await Promise.resolve();
        await h.store.getState().cancel('s1');
        await run;
        expect(h.store.getState().sessions.s1.exchanges[0].status).toBe('cancelled');
        expect(h.cancel).toHaveBeenCalledWith('s1', 'req-1');
        expect(h.poll.mock.calls.length).toBeLessThan(3);
    });

    it('draft and clear are per session', () => {
        const h = harness([]);
        h.store.getState().setDraft('s1', 'hello');
        h.store.getState().setDraft('s2', 'other');
        expect(h.store.getState().sessions.s1.draft).toBe('hello');
        h.store.getState().clear('s1');
        expect(h.store.getState().sessions.s1).toBeUndefined();
        expect(h.store.getState().sessions.s2.draft).toBe('other');
    });
});
