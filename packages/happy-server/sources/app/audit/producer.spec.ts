import { describe, it, expect, vi } from 'vitest';
import { AuditProducer } from './producer';

function harness(options: Record<string, unknown> = {}) {
    let now = 0;
    const send = vi.fn<typeof fetch>(async (_input, _init) => new Response('', { status: 200 }));
    const producer = new AuditProducer({ url: 'http://audit/ingest', token: 'test', sourceId: 'boot', fetch: send, now: () => now, ...options });
    return { producer, send, advance: () => { now += 60_000; } };
}
const event = { kind: 'message.stored', accountId: 'account', payload: { content: 'ciphertext' } };

describe('bounded audit producer', () => {
    it('enqueues without I/O, snapshots payload, and only removes on ACK', async () => {
        const { producer, send } = harness();
        const input = { ...event, payload: { content: 'original' } };
        expect(producer.enqueue(input)).toBe(true);
        input.payload.content = 'changed';
        expect(send).not.toHaveBeenCalled();
        expect(producer.status().queued).toBe(1);
        await producer.flush();
        const body = JSON.parse(send.mock.calls[0][1]!.body as string);
        expect(body.events[0]).toMatchObject({ v: 1, id: 'boot:1', seq: 1, sourceId: 'boot', payload: { content: 'original' } });
        expect(producer.status()).toMatchObject({ sent: 1, queued: 0, dropped: 0, errors: 0 });
    });
    it('drops excess counts, oversize and aggregate bytes without throwing', () => {
        const { producer } = harness({ maxEvents: 1 });
        expect(producer.enqueue(event)).toBe(true);
        expect(producer.enqueue(event)).toBe(false);
        expect(producer.status().dropped).toBe(1);
        expect(harness({ maxEventBytes: 1 }).producer.enqueue(event)).toBe(false);
        const tiny = harness({ maxBytes: 250 }).producer;
        expect(tiny.enqueue(event)).toBe(true);
        expect(tiny.enqueue(event)).toBe(false);
    });
    it('retries identical prefix and id, drops after three failures, then makes progress', async () => {
        const { producer, send, advance } = harness();
        send.mockRejectedValue(new Error('offline'));
        producer.enqueue(event);
        await producer.flush();
        producer.enqueue({ kind: 'login.succeeded' });
        await producer.flush(); // Backoff, no request.
        expect(send).toHaveBeenCalledTimes(1);
        advance(); await producer.flush();
        advance(); await producer.flush();
        expect(send.mock.calls.map((call) => JSON.parse(call[1]!.body as string).events.map((entry: any) => entry.id))).toEqual([['boot:1'], ['boot:1'], ['boot:1']]);
        expect(producer.status()).toMatchObject({ dropped: 1, queued: 1, errors: 3 });
        send.mockResolvedValue(new Response(''));
        advance(); await producer.flush();
        expect(producer.status()).toMatchObject({ sent: 1, queued: 0 });
    });
    it('does not overlap requests or remove events appended during delivery', async () => {
        const { producer, send } = harness();
        let resolve!: (value: Response) => void;
        send.mockImplementation(() => new Promise((r) => { resolve = r; }));
        producer.enqueue(event);
        const pending = producer.flush();
        producer.enqueue(event);
        await producer.flush();
        expect(send).toHaveBeenCalledTimes(1);
        resolve(new Response(''));
        await pending;
        expect(producer.status()).toMatchObject({ sent: 1, queued: 1 });
    });
    it('batches only a contiguous prefix under byte limit', async () => {
        const { producer, send } = harness();
        producer.enqueue({ kind: 'large', payload: { content: 'a'.repeat(1_700_000) } });
        producer.enqueue({ kind: 'large', payload: { content: 'b'.repeat(1_700_000) } });
        producer.enqueue({ kind: 'small' });
        await producer.flush();
        expect(JSON.parse(send.mock.calls[0][1]!.body as string).events.map((e: any) => e.seq)).toEqual([1]);
        await producer.flush();
        expect(JSON.parse(send.mock.calls[1][1]!.body as string).events.map((e: any) => e.seq)).toEqual([2, 3]);
    });
    it('sends initial and ten-second heartbeat even without traffic', async () => {
        vi.useFakeTimers();
        try {
            const { producer, send } = harness();
            producer.start();
            await vi.advanceTimersByTimeAsync(0);
            expect(send).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(10_000);
            expect(send).toHaveBeenCalledTimes(2);
            producer.stop();
        } finally { vi.useRealTimers(); }
    });
});

it('aborts a stalled transport and retains events for bounded retry', async () => {
    const stalled = vi.fn<typeof fetch>(async (_input, init) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const producer = new AuditProducer({ url: 'http://audit/ingest', token: 'test', fetch: stalled, timeoutMs: 10 });
    producer.enqueue(event);
    const start = performance.now();
    await producer.flush();
    expect(performance.now() - start).toBeLessThan(1000);
    expect(producer.status()).toMatchObject({ errors: 1, queued: 1, sent: 0 });
});
