/**
 * B-818: a bounded read has two clocks — until the response headers, then the
 * longest gap between body bytes — instead of one 10s budget for headers and
 * body together (which cut a 1.8MB list on slow 4G every time; B-816 Q1).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithDeadline, RequestTimeoutError, SYNC_READ_TIMEOUT_MS } from './requestDeadline';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** A fetch double: headers when `respond()` is called, body bytes when `push()` is. It ignores the abort signal. */
function slowServer() {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    let answer!: (response: Response) => void;
    let signal: AbortSignal | null = null;
    const fetchImpl = ((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? null;
        return new Promise<Response>((resolve) => { answer = resolve; });
    }) as unknown as typeof fetch;
    return {
        fetchImpl,
        signal: () => signal,
        respond: () => answer(new Response(new ReadableStream<Uint8Array>({ start(c) { body = c; } }), { status: 200, headers: { 'content-type': 'application/json' } })),
        push: (text: string) => body.enqueue(new TextEncoder().encode(text)),
        end: () => body.close(),
    };
}

describe('B-818 fetchWithDeadline: headers deadline + body idle deadline', () => {
    it('a slow but moving body outlives SYNC_READ_TIMEOUT_MS by far', async () => {
        const s = slowServer();
        const onResponse = vi.fn();
        const pending = fetchWithDeadline(s.fetchImpl, '/v1/sessions', { timeoutMs: SYNC_READ_TIMEOUT_MS, onResponse });
        await vi.advanceTimersByTimeAsync(SYNC_READ_TIMEOUT_MS - 1_000);
        s.respond();
        const response = await pending;
        expect(onResponse).toHaveBeenCalledTimes(1);
        const json = response.json();
        s.push('{"sessions":[');
        for (let i = 0; i < 6; i++) {
            await vi.advanceTimersByTimeAsync(SYNC_READ_TIMEOUT_MS - 1_000);
            s.push(`${i ? ',' : ''}${i}`);
        }
        s.push(']}');
        s.end();
        await expect(json).resolves.toEqual({ sessions: [0, 1, 2, 3, 4, 5] });
        expect(s.signal()?.aborted).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('the headers switch the clock: a first body byte 5s after late headers is not cut at the 10s mark', async () => {
        const s = slowServer();
        const pending = fetchWithDeadline(s.fetchImpl, '/v1/sessions', { timeoutMs: SYNC_READ_TIMEOUT_MS });
        await vi.advanceTimersByTimeAsync(SYNC_READ_TIMEOUT_MS - 1_000);
        s.respond();
        const json = (await pending).json();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(s.signal()?.aborted).toBe(false);
        s.push('{"sessions":[]}');
        s.end();
        await expect(json).resolves.toEqual({ sessions: [] });
    });

    it('a body that stops moving for SYNC_READ_TIMEOUT_MS fails with an idle RequestTimeoutError (even if the stream ignores the abort)', async () => {
        const s = slowServer();
        const pending = fetchWithDeadline(s.fetchImpl, '/v1/sessions', { timeoutMs: SYNC_READ_TIMEOUT_MS });
        s.respond();
        const json = (await pending).json();
        json.catch(() => {});
        s.push('{"sessions":[');
        await vi.advanceTimersByTimeAsync(SYNC_READ_TIMEOUT_MS - 1);
        expect(s.signal()?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(s.signal()?.aborted).toBe(true);
        const error = await json.then(() => null, (e: unknown) => e);
        expect(error).toBeInstanceOf(RequestTimeoutError);
        expect((error as RequestTimeoutError).phase).toBe('idle');
    });

    it('no headers within SYNC_READ_TIMEOUT_MS still fails then (the dead-link bound B-803b relies on)', async () => {
        const s = slowServer();
        const onResponse = vi.fn();
        const pending = fetchWithDeadline(s.fetchImpl, '/v1/sessions', { timeoutMs: SYNC_READ_TIMEOUT_MS, onResponse });
        const error = pending.then(() => null, (e: unknown) => e);
        await vi.advanceTimersByTimeAsync(SYNC_READ_TIMEOUT_MS);
        expect(await error).toBeInstanceOf(RequestTimeoutError);
        expect((await error as RequestTimeoutError).phase).toBe('response');
        expect(onResponse).not.toHaveBeenCalled();
    });

    it('idleTimeoutMs overrides the body gap', async () => {
        const s = slowServer();
        const pending = fetchWithDeadline(s.fetchImpl, '/x', { timeoutMs: SYNC_READ_TIMEOUT_MS, idleTimeoutMs: 2_000 });
        s.respond();
        const text = (await pending).text();
        text.catch(() => {});
        await vi.advanceTimersByTimeAsync(2_000);
        expect(s.signal()?.aborted).toBe(true);
        await expect(text).rejects.toBeInstanceOf(RequestTimeoutError);
    });

    it('a caller abort mid-body ends the read with its reason', async () => {
        const s = slowServer();
        const outer = new AbortController();
        const pending = fetchWithDeadline(s.fetchImpl, '/x', { timeoutMs: SYNC_READ_TIMEOUT_MS, signal: outer.signal });
        s.respond();
        const text = (await pending).text();
        text.catch(() => {});
        s.push('partial');
        const reason = new DOMException('Superseded by a responding attempt', 'AbortError');
        outer.abort(reason);
        await expect(text).rejects.toBe(reason);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps status and headers; without timeoutMs nothing is wrapped and onResponse still fires', async () => {
        const s = slowServer();
        const onResponse = vi.fn();
        const pending = fetchWithDeadline(s.fetchImpl, '/x', { timeoutMs: SYNC_READ_TIMEOUT_MS });
        s.respond();
        const response = await pending;
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('application/json');
        const plain = new Response('{}');
        const direct = await fetchWithDeadline((() => Promise.resolve(plain)) as unknown as typeof fetch, '/x', { onResponse });
        expect(direct).toBe(plain);
        expect(onResponse).toHaveBeenCalledTimes(1);
    });
});

describe('B-818 wiring in sync.ts', () => {
    const sync = readFileSync(resolve(__dirname, 'sync.ts'), 'utf8');

    it('the UI is ready after the FIRST session list, not after a full fetch queued behind it', () => {
        const init = sync.slice(sync.indexOf('async #init() {'), sync.indexOf('async #init() {') + 4_000);
        expect(init).toContain('const firstListLoaded = new Promise<void>((resolve) => { this.onSessionsListLoaded = resolve; });');
        expect(init).toContain('Promise.race([firstListLoaded, this.sessionsSync.awaitQueue()]).then(() => {\n            storage.getState().applyReady();');
        const fetchSessions = sync.slice(sync.indexOf('private fetchSessions = async () => {'), sync.indexOf('private catchUpSessionsSinceList'));
        expect(fetchSessions).toContain('this.applySessions(mergedSessions);\n        this.sessionListSnapshot = sessionListSnapshot(sessions, parseServedAt(date));\n        log.log(`📥 fetchSessions completed - processed ${decryptedSessions.length} sessions`);\n        this.onSessionsListLoaded?.();');
    });

    it('every hedged read hands the attempt init (onResponse) to its request', () => {
        const fetchSessions = sync.slice(sync.indexOf('private fetchSessions = async () => {'), sync.indexOf('private catchUpSessionsSinceList'));
        expect(fetchSessions).toMatch(/hedgedRead\(async \(signal, pool, index\): Promise<SessionListResponse> => \{[\s\S]*?signal,\n\s*\.\.\.pool,\n\s*\}\);/);
        // B-823: the boot prefetch is the first attempt and commits through the same onResponse.
        expect(fetchSessions).toContain('if (index === 0 && prefetched) return adoptSessionListPrefetch(prefetched, signal, pool.onResponse);');
    });
});
