import { describe, expect, it, vi } from 'vitest';
import type { WebhookSendResult } from './webhookNotify';
import { createWebhookDeliveryStats, deliverWebhook, isRetryableWebhookFailure, WEBHOOK_RETRY_DELAYS_MS } from './webhookDelivery';

const payload = { title: 't', message: 'm' };

describe('B-026 isRetryableWebhookFailure', () => {
    it('retries what can heal: no status (timeout/reset/DNS), 408, 425, 429, 5xx', () => {
        for (const res of [
            { ok: false, error: 'webhook request timed out' },
            { ok: false, error: 'read ECONNRESET' },
            { ok: false, error: 'getaddrinfo ENOTFOUND hooks.example.test' },
            { ok: false, status: 408 }, { ok: false, status: 425 }, { ok: false, status: 429 },
            { ok: false, status: 500 }, { ok: false, status: 502 }, { ok: false, status: 503 },
        ] as WebhookSendResult[]) expect(isRetryableWebhookFailure(res), JSON.stringify(res)).toBe(true);
    });

    it('never retries success, an answered 3xx/4xx, or an SSRF-guard verdict', () => {
        for (const res of [
            { ok: true, status: 200 }, { ok: false, status: 301 }, { ok: false, status: 400 },
            { ok: false, status: 401 }, { ok: false, status: 404 }, { ok: false, status: 410 },
            { ok: false, error: 'invalid url: Only https:// URLs are allowed' },
            { ok: false, error: 'webhook host resolved to a non-public address' },
            { ok: false, error: 'webhook response too large' },
        ] as WebhookSendResult[]) expect(isRetryableWebhookFailure(res), JSON.stringify(res)).toBe(false);
    });
});

function scripted(results: WebhookSendResult[]) {
    const calls: string[] = [];
    const send = vi.fn(async (_url: string, _p: unknown, deliveryId: string) => { calls.push(deliveryId); return results.shift() ?? { ok: false, status: 599 }; });
    return { send, calls };
}

describe('B-026 deliverWebhook', () => {
    it('a receiver blip (502, timeout) is retried with backoff until it answers 2xx, same delivery id each time', async () => {
        const { send, calls } = scripted([{ ok: false, status: 502 }, { ok: false, error: 'webhook request timed out' }, { ok: true, status: 200 }]);
        const waits: number[] = [];
        const res = await deliverWebhook('https://x.test/h', payload, { send, sleep: async (ms) => { waits.push(ms); }, random: () => 0.5 });
        expect(res).toMatchObject({ ok: true, status: 200, attempts: 3 });
        expect(waits).toEqual([WEBHOOK_RETRY_DELAYS_MS[0], WEBHOOK_RETRY_DELAYS_MS[1]]);
        expect(new Set(calls).size).toBe(1);
        expect(calls[0]).toBe(res.deliveryId);
    });

    it('gives up after 3 retries (4 attempts) and returns the last failure', async () => {
        const { send } = scripted([{ ok: false, status: 503 }, { ok: false, status: 503 }, { ok: false, status: 503 }, { ok: false, status: 504 }]);
        const res = await deliverWebhook('https://x.test/h', payload, { send, sleep: async () => {} });
        expect(res).toMatchObject({ ok: false, status: 504, attempts: 4 });
        expect(send).toHaveBeenCalledTimes(4);
    });

    it('stops at once on a permanent answer', async () => {
        const { send } = scripted([{ ok: false, status: 502 }, { ok: false, status: 404 }, { ok: true, status: 200 }]);
        const res = await deliverWebhook('https://x.test/h', payload, { send, sleep: async () => {} });
        expect(res).toMatchObject({ ok: false, status: 404, attempts: 2 });
    });

    it('backoff is exponential with ±20% jitter', async () => {
        const waits: number[] = [];
        const { send } = scripted([{ ok: false, status: 500 }, { ok: false, status: 500 }, { ok: false, status: 500 }, { ok: false, status: 500 }]);
        await deliverWebhook('https://x.test/h', payload, { send, sleep: async (ms) => { waits.push(ms); }, random: () => 1 });
        expect(waits).toEqual(WEBHOOK_RETRY_DELAYS_MS.map((d) => Math.round(d * 1.2)));
        expect(WEBHOOK_RETRY_DELAYS_MS[1] / WEBHOOK_RETRY_DELAYS_MS[0]).toBeGreaterThanOrEqual(2);
        expect(WEBHOOK_RETRY_DELAYS_MS[2] / WEBHOOK_RETRY_DELAYS_MS[1]).toBeGreaterThanOrEqual(2);
    });

    it('continues from an inline first attempt without re-sending it', async () => {
        const { send } = scripted([{ ok: true, status: 204 }]);
        const res = await deliverWebhook('https://x.test/h', payload, { send, sleep: async () => {}, firstResult: { ok: false, status: 502 }, deliveryId: 'd-1' });
        expect(res).toMatchObject({ ok: true, attempts: 2, deliveryId: 'd-1' });
        expect(send).toHaveBeenCalledTimes(1);
    });
});

describe('B-026 delivery counters', () => {
    it('counts delivered / failed / retries per account and keeps the last error', () => {
        let t = 1_000;
        const stats = createWebhookDeliveryStats(() => t);
        t = 2_000; stats.record('a', { ok: true, status: 200, attempts: 2 });
        t = 3_000; stats.record('a', { ok: false, status: 502, attempts: 4 });
        t = 4_000; stats.record('a', { ok: false, error: 'webhook request timed out', attempts: 4 });
        stats.record('b', { ok: true, status: 200, attempts: 1 });
        expect(stats.get('a')).toEqual({
            since: 1_000, delivered: 1, failed: 2, retries: 7,
            lastSuccessAt: 2_000, lastFailureAt: 4_000, lastError: 'webhook request timed out',
        });
        expect(stats.get('b')).toMatchObject({ delivered: 1, failed: 0, retries: 0 });
        expect(stats.get('nobody')).toMatchObject({ since: 1_000, delivered: 0, failed: 0, lastError: null });
    });
});

describe('B-026 wiring', () => {
    it('session-event webhooks go through the retrying, counting path', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const src = readFileSync(join(process.cwd(), 'sources/app/push/pushDispatch.ts'), 'utf8');
        expect(src).toContain('await deliverAccountWebhook(params.userId, params.sessionId, config.url, payload);');
        expect(src).not.toMatch(/\bsendWebhook\(/);
    });
});
