import { describe, expect, it } from 'vitest';
import { AttentionRequestError, AttentionUnsupportedError, createAttentionClient, UNSUPPORTED_BACKOFF_MS } from './client';

function respond(status: number, body: unknown) {
    const calls: string[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
        calls.push(`${init.method} ${url}`);
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
}

describe('attention client (B-766)', () => {
    it('probes the list route and treats an old server or the kill switch as "no board", with a backoff', async () => {
        for (const body of [{ error: 'Not Found' }, { error: 'owner_board_disabled' }, '<html>404</html>']) {
            let t = 0;
            const { fetch, calls } = respond(404, body);
            const client = createAttentionClient({ serverUrl: 'http://relay', token: async () => 'tok', fetch, now: () => t });
            expect(await client.probe('s 1')).toBe(false);
            expect(calls).toEqual(['GET http://relay/v1/attention-items?sessionId=s%201&limit=1']);
            expect(client.isDisabled()).toBe(true);
            await expect(client.post({ sessionId: 's', source: 'agent', kind: 'blocked', title: 'x' })).rejects.toBeInstanceOf(AttentionUnsupportedError);
            expect(calls).toHaveLength(1);
            t += UNSUPPORTED_BACKOFF_MS + 1;
            expect(client.isDisabled()).toBe(false);
        }
    });

    it('keeps an item-level 404 an ordinary error and reports success on 200', async () => {
        const missing = respond(404, { error: 'attention_item_not_found' });
        const client = createAttentionClient({ serverUrl: 'http://relay', token: async () => 'tok', fetch: missing.fetch });
        await expect(client.resolve('nope', { outcome: 'done' })).rejects.toMatchObject({ status: 404, code: 'attention_item_not_found' });
        expect(client.isDisabled()).toBe(false);
        const ok = respond(200, { items: [] });
        expect(await createAttentionClient({ serverUrl: 'http://relay', token: async () => 'tok', fetch: ok.fetch }).probe('s')).toBe(true);
    });

    it('needs a signed-in account and never sends without a token', async () => {
        const { fetch, calls } = respond(200, { items: [] });
        const client = createAttentionClient({ serverUrl: 'http://relay', token: async () => null, fetch });
        await expect(client.probe('s')).rejects.toBeInstanceOf(AttentionRequestError);
        expect(calls).toEqual([]);
    });

    it('serialises list queries and item routes', async () => {
        const { fetch, calls } = respond(200, { items: [], item: {} });
        const client = createAttentionClient({ serverUrl: 'http://relay', token: async () => 'tok', fetch });
        await client.list({ sessionId: 's', state: 'open', limit: 20 });
        await client.patch('a/b', { state: 'in_progress' });
        expect(calls).toEqual(['GET http://relay/v1/attention-items?sessionId=s&state=open&limit=20', 'PATCH http://relay/v1/attention-items/a%2Fb']);
    });
});
