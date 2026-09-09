import { describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { requestAuditContext, auditLoginFailure, auditLogin } from './requestAudit';
import { publishAudit } from './producer';
vi.mock('./producer', () => ({ publishAudit: vi.fn() }));

describe('audit request origin', () => {
    it('ignores client-supplied CF and XFF headers when proxy trust is disabled', async () => {
        const app = fastify({ trustProxy: false });
        app.get('/test', async (request) => requestAuditContext(request));
        const response = await app.inject({ method: 'GET', url: '/test?token=never-record', remoteAddress: '203.0.113.20', headers: {
            'cf-connecting-ip': '198.51.100.9', 'x-forwarded-for': '198.51.100.10', 'user-agent': 'browser',
        } });
        expect(response.json()).toMatchObject({ ip: '203.0.113.20', ipSource: 'socket-peer', route: '/test' });
        expect(response.body).not.toContain('never-record');
        await app.close();
    });
    it('uses the configured single-hop peer boundary, never claims forwarded CF identity', async () => {
        const app = fastify({ trustProxy: 1 });
        app.get('/test', async (request) => requestAuditContext(request));
        const response = await app.inject({ method: 'GET', url: '/test', remoteAddress: '172.18.0.1', headers: {
            'x-forwarded-for': '198.51.100.99, 203.0.113.20', 'cf-connecting-ip': '198.51.100.50',
        } });
        expect(response.json()).toMatchObject({ ip: '203.0.113.20', ipSource: 'forwarded-peer' });
        await app.close();
    });
    it('handles IPv6 and malformed origin while bounding user agent', () => {
        const request = { ip: '2001:db8::1', method: 'POST', headers: { 'user-agent': 'a'.repeat(1000) }, routeOptions: { url: '/v1/account/login' } };
        expect(requestAuditContext(request)).toMatchObject({ ip: '2001:db8::1', userAgent: 'a'.repeat(256) });
        expect(requestAuditContext({ ...request, ip: 'bad,ip' })).toMatchObject({ ip: undefined, ipSource: 'unavailable' });
    });
    it('failure events contain status and route, never submitted credentials or guessed account identity', () => {
        vi.mocked(publishAudit).mockClear();
        const request = { ip: '203.0.113.1', method: 'POST', headers: {}, routeOptions: { url: '/v1/account/login' }, body: { password: 'never-record' } };
        auditLoginFailure(request, 401);
        expect(publishAudit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'login.failed', payload: { statusCode: 401 } }));
        expect(JSON.stringify(vi.mocked(publishAudit).mock.calls)).not.toContain('never-record');
        auditLoginFailure(request, 200);
        auditLoginFailure({ ...request, routeOptions: { url: '/v1/auth/email/code' } }, 400);
        expect(publishAudit).toHaveBeenCalledTimes(1);
        auditLogin(request, 'account-1', 'password');
        expect(publishAudit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'login.succeeded', accountId: 'account-1' }));
    });
});

describe('explicit Cloudflare origin recovery', () => {
    it('requires opt-in and CF-owned peer, supports IPv4, IPv6 and mapped IPv4', async () => {
        const { cloudflareClientIp } = await import('./cloudflareOrigin');
        expect(cloudflareClientIp('104.21.58.207', '203.0.113.7', false)).toBeUndefined();
        expect(cloudflareClientIp('203.0.113.7', '198.51.100.2', true)).toBeUndefined();
        expect(cloudflareClientIp('104.21.58.207', '203.0.113.7', true)).toBe('203.0.113.7');
        expect(cloudflareClientIp('2606:4700::1234', '2001:db8::7', true)).toBe('2001:db8::7');
        expect(cloudflareClientIp('::ffff:104.21.58.207', '::ffff:203.0.113.7', true)).toBe('203.0.113.7');
        expect(cloudflareClientIp('::ffff:6815:3acf', '203.0.113.7', true)).toBe('203.0.113.7');
        for (const header of ['198.51.100.2, 203.0.113.7', 'bad', ['203.0.113.7'], undefined]) {
            expect(cloudflareClientIp('104.21.58.207', header, true)).toBeUndefined();
        }
    });
    it('keeps peer labeling when origin header is absent or malformed', () => {
        vi.stubEnv('BUSINESS_AUDIT_TRUST_CLOUDFLARE', '1');
        try {
            const base = { ip: '104.21.58.207', ips: ['172.18.0.1', '104.21.58.207'], method: 'POST', headers: {} };
            expect(requestAuditContext(base)).toMatchObject({ ip: '104.21.58.207', ipSource: 'forwarded-peer' });
            expect(requestAuditContext({ ...base, headers: { 'cf-connecting-ip': '203.0.113.7' } })).toMatchObject({ ip: '203.0.113.7', ipSource: 'cloudflare' });
        } finally { vi.unstubAllEnvs(); }
    });
});
