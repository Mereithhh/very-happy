import { describe, expect, it, vi } from 'vitest';
import { createBtwStore, localBtwPersistence, MAX_STORED_EXCHANGES, parseStoredBtwSession, type BtwPersistence } from './btwStore';
import type { SideQuestionPollResponse } from './ops';

function harness(polls: Array<Partial<SideQuestionPollResponse> | Error>, askImpl?: () => Promise<any>, persistence?: BtwPersistence) {
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
    const store = createBtwStore({ ask, poll, cancel, delay, now: () => clock, pollMs: 1000, persistence });
    return { store, ask, poll, cancel, delay };
}

describe('btwStore ask/poll loop (B-283)', () => {
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

    it('clips history to the CLI cap before sending', async () => {
        const h = harness([{ text: 'x'.repeat(5000), status: 'done' }, { text: 'a2', status: 'done' }]);
        await h.store.getState().ask('s1', 'q1');
        await h.store.getState().ask('s1', 'q2');
        const history = (h.ask.mock.calls[1] as unknown as [string, string, { question: string; answer: string }[]])[2];
        expect(history[0].answer.length).toBe(2001);
        expect(history[0].answer.endsWith('…')).toBe(true);
    });

    it('releases the CLI slot when the web gives up polling or cancelled during the ask round-trip', async () => {
        const dead = harness(Array.from({ length: 5 }, () => new Error('socket closed')));
        await dead.store.getState().ask('s1', 'q');
        expect(dead.cancel).toHaveBeenCalledWith('s1', 'req-1');

        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const late = harness([{ text: 'never', status: 'done' }], async () => { await gate; return { requestId: 'req-9', hadContext: true }; });
        const run = late.store.getState().ask('s2', 'q');
        await late.store.getState().cancel('s2'); // no requestId yet → nothing to tell the CLI
        expect(late.cancel).not.toHaveBeenCalled();
        release();
        await run;
        expect(late.cancel).toHaveBeenCalledWith('s2', 'req-9');
        expect(late.poll).not.toHaveBeenCalled();
        expect(late.store.getState().sessions.s2.exchanges[0].status).toBe('cancelled');
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

/** A Map-backed store with the JSON round trip of localStorage. */
function memoryPersistence(seed: Record<string, unknown> = {}) {
    const data = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
    const persistence: BtwPersistence = {
        load: (id) => (data.has(id) ? JSON.parse(data.get(id)!) : null),
        save: (id, state) => { if (state) data.set(id, JSON.stringify(state)); else data.delete(id); },
    };
    return { data, persistence };
}

describe('btwStore persistence (B-861)', () => {
    it('a reload keeps the side chat and its history feeds the next ask', async () => {
        const mem = memoryPersistence();
        const before = harness([{ text: 'PELICAN-7731', status: 'done' }], undefined, mem.persistence);
        await before.store.getState().ask('s1', 'codeword?');
        expect(JSON.parse(mem.data.get('s1')!).exchanges[0]).toEqual(expect.objectContaining({ question: 'codeword?', answer: 'PELICAN-7731', status: 'done' }));

        const after = harness([{ text: 'backwards', status: 'done' }], undefined, mem.persistence);
        after.store.getState().hydrate('s1');
        expect(after.store.getState().sessions.s1.exchanges.map((e) => e.answer)).toEqual(['PELICAN-7731']);
        await after.store.getState().ask('s1', 'reverse it');
        expect(after.ask).toHaveBeenCalledWith('s1', 'reverse it', [{ question: 'codeword?', answer: 'PELICAN-7731' }]);
    });

    it('resumes polling a question that was running at reload; one without a request id is cancelled', async () => {
        const mem = memoryPersistence({ s1: { draft: '', exchanges: [
            { id: 'a', question: 'q1', answer: '', status: 'running', startedAt: 1 },
            { id: 'b', question: 'q2', answer: 'par', status: 'running', startedAt: 2, requestId: 'req-7' },
        ] } });
        const h = harness([{ text: 'full answer', status: 'done', hadContext: false }], undefined, mem.persistence);
        h.store.getState().hydrate('s1');
        await vi.waitFor(() => expect(h.store.getState().sessions.s1.exchanges[1].status).toBe('done'));
        expect(h.poll).toHaveBeenCalledWith('s1', 'req-7');
        expect(h.store.getState().sessions.s1.exchanges.map((e) => [e.status, e.answer, e.hadContext])).toEqual([
            ['cancelled', '', true], ['done', 'full answer', false],
        ]);
    });

    it('a /btw draft parked before the panel mounts does not overwrite the stored chat', () => {
        const mem = memoryPersistence({ s1: { draft: '', exchanges: [{ id: 'a', question: 'q', answer: 'a', status: 'done', startedAt: 1 }] } });
        const h = harness([], undefined, mem.persistence);
        h.store.getState().setDraft('s1', 'next question');
        expect(JSON.parse(mem.data.get('s1')!)).toEqual(expect.objectContaining({ draft: 'next question', exchanges: [expect.objectContaining({ id: 'a' })] }));
    });

    it('clear removes the stored chat; only the newest exchanges are kept', async () => {
        const mem = memoryPersistence();
        const h = harness(Array.from({ length: MAX_STORED_EXCHANGES + 2 }, (_, i) => ({ text: `a${i}`, status: 'done' as const })), undefined, mem.persistence);
        for (let i = 0; i < MAX_STORED_EXCHANGES + 2; i++) await h.store.getState().ask('s1', `q${i}`);
        const stored = JSON.parse(mem.data.get('s1')!).exchanges;
        expect(stored).toHaveLength(MAX_STORED_EXCHANGES);
        expect(stored[0].question).toBe('q2');
        h.store.getState().clear('s1');
        expect(mem.data.has('s1')).toBe(false);
    });

    it('degrades to memory-only when storage throws, and drops malformed stored rows', async () => {
        vi.stubGlobal('localStorage', {
            getItem: () => { throw new Error('SecurityError'); },
            setItem: () => { throw new Error('QuotaExceededError'); },
            removeItem: () => { throw new Error('SecurityError'); },
        });
        try {
            const h = harness([{ text: 'ok', status: 'done' }], undefined, localBtwPersistence);
            await h.store.getState().ask('s1', 'q');
            expect(h.store.getState().sessions.s1.exchanges[0].answer).toBe('ok');
            h.store.getState().clear('s1');
            expect(localBtwPersistence.load('s1')).toBeNull();
        } finally {
            vi.unstubAllGlobals();
        }
        expect(parseStoredBtwSession({ exchanges: [{ id: 1 }, null, { id: 'x', question: 'q', answer: 'a', status: 'weird', startedAt: 1 }], draft: 3 })).toBeNull();
        expect(parseStoredBtwSession('garbage')).toBeNull();
    });
});
