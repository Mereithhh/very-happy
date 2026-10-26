import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createReportBudget, cspReportRoutes, cspViolationsCounter, parseCspReports } from './cspReportRoutes';

describe('B-825 CSP reports', () => {
    it('normalizes both formats and keeps no query, token or full URL', () => {
        expect(parseCspReports({ 'csp-report': {
            'document-uri': 'https://veryhappy.dev/session/cmabcdefghijklmnop1234?token=secret',
            'violated-directive': 'script-src-elem',
            'effective-directive': 'script-src-elem',
            'blocked-uri': 'https://evil.example/x.js?k=v',
            disposition: 'enforce',
        } })).toEqual([{ directive: 'script-src-elem', disposition: 'enforce', blocked: 'https://evil.example', page: '/session/:id' }]);
        expect(parseCspReports([
            { type: 'csp-violation', body: { documentURL: 'https://veryhappy.dev/', effectiveDirective: 'connect-src', blockedURL: 'wss://relay.example/socket?x', disposition: 'report' } },
            { type: 'deprecation', body: {} },
            { type: 'csp-violation', body: { documentURL: 'https://veryhappy.dev/', effectiveDirective: 'script-src', blockedURL: 'inline', disposition: 'enforce' } },
        ])).toEqual([
            { directive: 'connect-src', disposition: 'report', blocked: 'wss://relay.example', page: '/' },
            { directive: 'script-src', disposition: 'enforce', blocked: 'inline', page: '/' },
        ]);
        expect(parseCspReports({ 'csp-report': { 'effective-directive': 'x-made-up', 'blocked-uri': 'data:abc' } })[0]).toMatchObject({ directive: 'other', blocked: 'data' });
        expect(parseCspReports('garbage')).toEqual([]);
    });

    it('per-key budget with bounded keys', () => {
        const allow = createReportBudget(2, 1000, 2);
        expect([allow('a', 0), allow('a', 1), allow('a', 2)]).toEqual([true, true, false]);
        expect(allow('b', 3)).toBe(true);
        expect(allow('c', 4)).toBe(false); // key cap
        expect(allow('a', 1000)).toBe(true); // next window
    });

    it('accepts application/csp-report and application/reports+json with 204, counts them', async () => {
        const app = Fastify();
        cspReportRoutes(app as any);
        const before = (await cspViolationsCounter.get()).values.reduce((sum, v) => sum + v.value, 0);
        const legacy = await app.inject({ method: 'POST', url: '/v1/csp-report', headers: { 'content-type': 'application/csp-report' }, payload: JSON.stringify({ 'csp-report': { 'effective-directive': 'img-src', 'blocked-uri': 'https://x.example/a.png', 'document-uri': 'https://veryhappy.dev/' } }) });
        expect(legacy.statusCode).toBe(204);
        const modern = await app.inject({ method: 'POST', url: '/v1/csp-report', headers: { 'content-type': 'application/reports+json' }, payload: JSON.stringify([{ type: 'csp-violation', body: { effectiveDirective: 'connect-src', blockedURL: 'https://y.example', documentURL: 'https://veryhappy.dev/', disposition: 'report' } }]) });
        expect(modern.statusCode).toBe(204);
        const bad = await app.inject({ method: 'POST', url: '/v1/csp-report', headers: { 'content-type': 'application/csp-report' }, payload: '{not json' });
        expect(bad.statusCode).toBe(204);
        const after = (await cspViolationsCounter.get()).values.reduce((sum, v) => sum + v.value, 0);
        expect(after - before).toBe(2);
        await app.close();
    });
});
