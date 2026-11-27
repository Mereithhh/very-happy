import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forwardHeaders, shouldTagUpstream, startRequestTagger, upstreamUrl, type RequestTagger } from './requestTagger';
import { startClaudeRequestTagging } from './claudeTagging';

const config = { sessionHeader: 'X-Test-Session', requestHeader: 'X-Test-Request', hosts: ['gateway.example.com', '*.models.example.org'] };

describe('shouldTagUpstream', () => {
    it('matches listed hosts and suffix patterns only', () => {
        expect(shouldTagUpstream('https://gateway.example.com/api', config)).toBe(true);
        expect(shouldTagUpstream('https://a.models.example.org', config)).toBe(true);
        expect(shouldTagUpstream('https://models.example.org', config)).toBe(false);
        expect(shouldTagUpstream('https://evilgateway.example.com', config)).toBe(false);
        expect(shouldTagUpstream('https://api.anthropic.com', config)).toBe(false);
        expect(shouldTagUpstream('https://api.anthropic.com', config, true)).toBe(true);
        expect(shouldTagUpstream('not a url', config, true)).toBe(false);
        expect(shouldTagUpstream('https://gateway.example.com', null)).toBe(false);
    });
});

describe('upstreamUrl / forwardHeaders', () => {
    it('keeps the base path prefix and query', () => {
        expect(upstreamUrl(new URL('https://g.example.com/anthropic/'), '/v1/messages?beta=true').toString()).toBe('https://g.example.com/anthropic/v1/messages?beta=true');
        expect(upstreamUrl(new URL('https://g.example.com'), '/v1/messages').toString()).toBe('https://g.example.com/v1/messages');
    });
    it('drops hop-by-hop headers, rewrites host and lets no client spoof a tag', () => {
        const out = forwardHeaders({ host: '127.0.0.1:1', connection: 'keep-alive', 'x-api-key': 'k', 'x-test-request': 'spoofed' }, new URL('https://g.example.com'), { 'X-Test-Request': 'real' });
        expect(out).toEqual({ host: 'g.example.com', 'x-api-key': 'k', 'X-Test-Request': 'real' });
    });
});

describe('startRequestTagger (real loopback upstream)', () => {
    let upstream: http.Server | null = null;
    let tagger: RequestTagger | null = null;
    afterEach(async () => {
        await tagger?.close();
        await new Promise(r => (upstream ? upstream.close(r) : r(null)));
        upstream = null; tagger = null;
    });

    async function startUpstream(handler: http.RequestListener): Promise<string> {
        upstream = http.createServer(handler);
        await new Promise<void>(r => upstream!.listen(0, '127.0.0.1', r));
        return `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/prefix`;
    }

    it('adds session + fresh request id headers, streams the body, and hands ids to the turn once', async () => {
        const seen: Array<{ url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
        const base = await startUpstream((req, res) => {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                seen.push({ url: req.url, headers: req.headers, body });
                res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'up-1' });
                res.write('event: a\ndata: 1\n\n');
                setTimeout(() => res.end('event: b\ndata: 2\n\n'), 20);
            });
        });
        let n = 0;
        tagger = await startRequestTagger({ upstream: base, sessionId: 'sess-1', config, newRequestId: () => `req-${++n}` });
        expect(tagger.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        for (const i of [1, 2]) {
            const res = await fetch(`${tagger.baseUrl}/v1/messages?beta=true`, { method: 'POST', headers: { 'x-api-key': 'secret', 'content-type': 'application/json' }, body: JSON.stringify({ i }) });
            expect(res.status).toBe(200);
            expect(res.headers.get('request-id')).toBe('up-1');
            expect(await res.text()).toBe('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n');
        }
        expect(seen.map(s => [s.url, s.headers['x-test-session'], s.headers['x-test-request'], s.headers['x-api-key'], s.body])).toEqual([
            ['/prefix/v1/messages?beta=true', 'sess-1', 'req-1', 'secret', '{"i":1}'],
            ['/prefix/v1/messages?beta=true', 'sess-1', 'req-2', 'secret', '{"i":2}'],
        ]);
        expect(tagger.takeRequestIds()).toEqual(['req-1', 'req-2']);
        // A HEAD probe is tagged upstream but is not a model call of the turn.
        await fetch(`${tagger.baseUrl}/api/hello`, { method: 'HEAD' });
        expect(seen.at(-1)?.headers['x-test-request']).toBe('req-3');
        expect(tagger.takeRequestIds()).toEqual([]);
    });

    it('answers 502 in the provider error shape when the upstream is down', async () => {
        const base = await startUpstream(() => undefined);
        await new Promise(r => upstream!.close(r)); upstream = null;
        tagger = await startRequestTagger({ upstream: base, sessionId: 's', config });
        const res = await fetch(`${tagger.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
        expect(res.status).toBe(502);
        expect((await res.json()).type).toBe('error');
    });
});

describe('startClaudeRequestTagging', () => {
    const home = () => mkdtempSync(join(tmpdir(), 'vh-tag-'));
    const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

    it('points the env at the forwarder only for a configured gateway', async () => {
        const h = home();
        try {
            const env: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: 'https://gateway.example.com/x' };
            const t = await startClaudeRequestTagging({ env, sessionId: 's', serverUrl: 'http://server', token: 't', happyHome: h, accountUsable: true, fetch: ok({ modelRequestTagging: config }) });
            expect(t).not.toBeNull();
            expect(env.ANTHROPIC_BASE_URL).toBe(t!.baseUrl);
            await t!.close();

            const other: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' };
            expect(await startClaudeRequestTagging({ env: other, sessionId: 's', serverUrl: 'http://server', token: 't', happyHome: h, accountUsable: true, fetch: ok({ modelRequestTagging: config }) })).toBeNull();
            expect(other.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
        } finally {
            rmSync(h, { recursive: true, force: true });
        }
    });

    it('keeps the last good config when the server is unreachable, and never tags an unusable account', async () => {
        const h = home();
        try {
            const first: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: 'https://gateway.example.com' };
            (await startClaudeRequestTagging({ env: first, sessionId: 's', serverUrl: 'http://server', token: 't', happyHome: h, accountUsable: true, fetch: ok({ modelRequestTagging: config }) }))!.close();
            const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
            const env: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: 'https://gateway.example.com' };
            const t = await startClaudeRequestTagging({ env, sessionId: 's', serverUrl: 'http://server', token: 't', happyHome: h, accountUsable: true, fetch: down });
            expect(t).not.toBeNull();
            await t!.close();
            const blocked: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: 'https://gateway.example.com' };
            expect(await startClaudeRequestTagging({ env: blocked, sessionId: 's', serverUrl: 'http://server', token: 't', happyHome: h, accountUsable: false, fetch: ok({ modelRequestTagging: config }) })).toBeNull();
        } finally {
            rmSync(h, { recursive: true, force: true });
        }
    });

    it('an older server (404) turns tagging off', async () => {
        const h = home();
        try {
            const env: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: 'https://gateway.example.com' };
            const notFound = (async () => new Response('{"error":"Not Found"}', { status: 404 })) as unknown as typeof fetch;
            expect(await startClaudeRequestTagging({ env, sessionId: 's', serverUrl: 'http://server', token: 't', happyHome: h, accountUsable: true, fetch: notFound })).toBeNull();
        } finally {
            rmSync(h, { recursive: true, force: true });
        }
    });
});
