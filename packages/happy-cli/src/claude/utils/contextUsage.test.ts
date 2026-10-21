import { describe, it, expect, vi } from 'vitest';
import { startHappyServer } from './startHappyServer';
import type { ApiSessionClient } from '@/api/apiSession';

describe('session-bound pi context telemetry', () => {
    it('accepts real occupancy and unknown snapshots, rejects invalid and cross-origin writes', async () => {
        const received: unknown[] = [];
        const client = { sessionId:'context-test', rpcHandlerManager:{registerHandler:vi.fn(),unregisterHandler:vi.fn()}, updateMetadata:vi.fn() } as unknown as ApiSessionClient;
        const server = await startHappyServer(client, {onContextUsage: usage => received.push(usage)});
        const post = (body: unknown, url = server.contextUsageUrl!, headers = {}) => fetch(url, {method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
        try {
            expect((await post({source:'pi',tokens:42000,contextWindow:1000000})).status).toBe(204);
            expect(received[0]).toMatchObject({source:'pi',tokens:42000,contextWindow:1000000});
            expect((await post({source:'pi',tokens:null,contextWindow:128000})).status).toBe(204);
            expect((await post({source:'pi',tokens:-1,contextWindow:0})).status).toBe(400);
            expect((await post({source:'pi',tokens:1,contextWindow:200000},server.url+'runtime-context/wrong')).status).toBe(403);
            expect((await post({source:'pi',tokens:1,contextWindow:200000},undefined,{origin:'https://other.test'})).status).toBe(403);
            expect((await post({junk:'x'.repeat(5000)})).status).toBe(413);
            // B-727: the extension's provenance fields pass through to the wrapper.
            const peers = Array.from({length:8},(_,i)=>({provider:`provider-${i}`.padEnd(200,'x'),contextWindow:1000000}));
            expect((await post({source:'pi',tokens:5,contextWindow:128000,model:'m'.repeat(200),provider:'p'.repeat(200),event:'turn_end',peers})).status).toBe(204);
            expect(received[2]).toMatchObject({event:'turn_end',peers:expect.arrayContaining([expect.objectContaining({contextWindow:1000000})])});
            expect(received).toHaveLength(3);
        } finally { server.stop(); }
    });
});
