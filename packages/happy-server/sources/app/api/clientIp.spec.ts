import { afterEach, describe, expect, it } from 'vitest';
import fastify from 'fastify';
import pino from 'pino';
import { Writable } from 'node:stream';
import {
    clientIp,
    clientIpInfo,
    clientRateLimitKey,
    compileTrustedPeer,
    configureClientIpTrust,
    rateLimitKeyForIp,
    requestLogSerializer,
} from './clientIp';
import { resolveTrustProxy } from './trustProxy';

const req = (peer: string | undefined, headers: Record<string, string | string[] | undefined> = {}, ip = peer ?? '') => ({
    ip, headers, socket: { remoteAddress: peer },
});

afterEach(() => configureClientIpTrust(resolveTrustProxy(process.env.TRUST_PROXY)));

describe('trusted peer boundary', () => {
    it('matches Fastify trustProxy forms for the immediate peer and fails closed on junk', () => {
        const list = compileTrustedPeer(['172.18.0.1', '10.0.0.0/8', 'loopback', 'bogus', '1.2.3.4/99']);
        expect(list('172.18.0.1')).toBe(true);
        expect(list('172.18.0.2')).toBe(false);
        expect(list('10.9.8.7')).toBe(true);
        expect(list('127.0.0.1')).toBe(true);
        expect(list('::1')).toBe(true);
        expect(list('1.2.3.4')).toBe(false);
        expect(list(undefined)).toBe(false);
        expect(compileTrustedPeer(false)('172.18.0.1')).toBe(false);
        expect(compileTrustedPeer(1)('203.0.113.1')).toBe(true);
    });
});

describe('clientIp', () => {
    it('uses X-Real-Client-IP only from the TRUST_PROXY peer', () => {
        configureClientIpTrust(['172.18.0.1']);
        expect(clientIpInfo(req('172.18.0.1', { 'x-real-client-ip': '203.0.113.9' }, '162.158.1.1')))
            .toEqual({ ip: '203.0.113.9', source: 'proxy-header' });
        // Docker/Node may report the gateway as an IPv4-mapped IPv6 address.
        expect(clientIp(req('::ffff:172.18.0.1', { 'x-real-client-ip': '203.0.113.9' }))).toBe('203.0.113.9');
        // Anyone else forging the header gets their Fastify-derived address.
        expect(clientIpInfo(req('198.51.100.66', { 'x-real-client-ip': '6.6.6.6' })))
            .toEqual({ ip: '198.51.100.66', source: 'peer' });
    });
    it('rejects malformed, list or multi-valued headers and normalizes IPv6', () => {
        configureClientIpTrust(['172.18.0.1']);
        for (const bad of ['', 'nope', '203.0.113.9, 6.6.6.6', '203.0.113.9:443', ['203.0.113.9'], undefined]) {
            expect(clientIpInfo(req('172.18.0.1', { 'x-real-client-ip': bad }, '162.158.1.1')))
                .toEqual({ ip: '162.158.1.1', source: 'peer' });
        }
        expect(clientIp(req('172.18.0.1', { 'x-real-client-ip': '2001:DB8:0::1' }))).toBe('2001:db8::1');
        expect(clientIp(req('172.18.0.1', { 'x-real-client-ip': '::ffff:203.0.113.9' }))).toBe('203.0.113.9');
    });
    it('ignores the header entirely when proxy trust is disabled', () => {
        configureClientIpTrust(false);
        expect(clientIp(req('172.18.0.1', { 'x-real-client-ip': '203.0.113.9' }))).toBe('172.18.0.1');
    });
});

describe('rate-limit identity', () => {
    it('keys IPv4 per address and IPv6 per /64', () => {
        expect(rateLimitKeyForIp('203.0.113.9')).toBe('203.0.113.9');
        expect(rateLimitKeyForIp('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
        expect(rateLimitKeyForIp('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
        expect(rateLimitKeyForIp('2001:db8::1')).toBe('2001:db8:0:0::/64');
        expect(rateLimitKeyForIp('::1')).toBe('0:0:0:0::/64');
    });
    it('separates two users behind the same edge and ignores spoofing from outside', () => {
        configureClientIpTrust(['172.18.0.1']);
        const a = clientRateLimitKey(req('172.18.0.1', { 'x-real-client-ip': '203.0.113.1' }, '162.158.1.1'));
        const b = clientRateLimitKey(req('172.18.0.1', { 'x-real-client-ip': '203.0.113.2' }, '162.158.1.1'));
        const spoof = clientRateLimitKey(req('198.51.100.66', { 'x-real-client-ip': '203.0.113.1' }));
        expect(a).toBe('203.0.113.1');
        expect(b).toBe('203.0.113.2');
        expect(spoof).toBe('198.51.100.66');
    });
});

describe('Fastify integration', () => {
    it('resolves through a real Fastify request and logs the client IP, not the edge', async () => {
        const lines: string[] = [];
        const stream = new Writable({ write(chunk, _enc, done) { lines.push(chunk.toString()); done(); } });
        const trustProxy = resolveTrustProxy('172.18.0.1');
        configureClientIpTrust(trustProxy);
        const app = fastify({
            trustProxy,
            loggerInstance: pino({}, stream).child({}, { serializers: { req: requestLogSerializer } }),
        });
        app.get('/ip', async (request) => ({ ip: clientIp(request), fastifyIp: request.ip }));
        const viaCaddy = await app.inject({
            method: 'GET', url: '/ip', remoteAddress: '172.18.0.1',
            headers: { 'x-forwarded-for': '162.158.1.1', 'x-real-client-ip': '203.0.113.9' },
        });
        expect(viaCaddy.json()).toEqual({ ip: '203.0.113.9', fastifyIp: '162.158.1.1' });
        const direct = await app.inject({
            method: 'GET', url: '/ip', remoteAddress: '198.51.100.66',
            headers: { 'x-forwarded-for': '6.6.6.6', 'x-real-client-ip': '6.6.6.6' },
        });
        expect(direct.json()).toEqual({ ip: '198.51.100.66', fastifyIp: '198.51.100.66' });
        const incoming = lines.map((line) => JSON.parse(line)).filter((line) => line.msg === 'incoming request');
        expect(incoming.map((line) => line.req.remoteAddress)).toEqual(['203.0.113.9', '198.51.100.66']);
        await app.close();
    });
});
