import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createReportBudget, cspReportRoutes, cspViolationsCounter, hostClass, parseCspReports, sourceClass } from './cspReportRoutes';

const logMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/log', () => ({ log: logMock }));

describe('B-825 CSP reports', () => {
    it('normalizes both formats and keeps no query, token or full URL', () => {
        expect(parseCspReports({ 'csp-report': {
            'document-uri': 'https://veryhappy.dev/session/cmabcdefghijklmnop1234?token=secret',
            'violated-directive': 'script-src-elem',
            'effective-directive': 'script-src-elem',
            'blocked-uri': 'https://evil.example/x.js?k=v',
            disposition: 'enforce',
        } })).toEqual([{ directive: 'script-src-elem', disposition: 'enforce', blocked: 'https://evil.example', page: '/session/:id', scheme: 'https', host: 'public', port: 'default', source: 'none' }]);
        expect(parseCspReports([
            { type: 'csp-violation', body: { documentURL: 'https://veryhappy.dev/', effectiveDirective: 'connect-src', blockedURL: 'wss://relay.example/socket?x', disposition: 'report' } },
            { type: 'deprecation', body: {} },
            { type: 'csp-violation', body: { documentURL: 'https://veryhappy.dev/', effectiveDirective: 'script-src', blockedURL: 'inline', disposition: 'enforce' } },
        ])).toEqual([
            { directive: 'connect-src', disposition: 'report', blocked: 'wss://relay.example', page: '/', scheme: 'wss', host: 'public', port: 'default', source: 'none' },
            { directive: 'script-src', disposition: 'enforce', blocked: 'inline', page: '/', scheme: 'none', host: 'none', port: 'none', source: 'none' },
        ]);
        expect(parseCspReports({ 'csp-report': { 'effective-directive': 'x-made-up', 'blocked-uri': 'data:abc' } })[0]).toMatchObject({ directive: 'other', blocked: 'data' });
        expect(parseCspReports('garbage')).toEqual([]);
    });

    // Raw bodies Chromium 1148 sent for an https page under the production policy
    // (~/code/github/skills/tmp/vh-team-csp-connect: page script vs. an MV3
    // extension's main-world content script). Only the hostnames were changed.
    const report = (blocked: string, sourceFile: string | undefined, line = 2) => ({ 'csp-report': {
        'document-uri': 'https://veryhappy.dev/terminal/cmvpe72j702e7qn2ulflthf88',
        referrer: '', 'violated-directive': 'connect-src', 'effective-directive': 'connect-src',
        disposition: 'enforce', 'blocked-uri': blocked, 'line-number': line, 'column-number': 1,
        ...(sourceFile === undefined ? {} : { 'source-file': sourceFile }), 'status-code': 200, 'script-sample': '',
    } });

    it('classifies captured enforce connect-src reports without keeping the URL', () => {
        const [extension] = parseCspReports(report('ws://localhost:35729/livereload', 'chrome-extension'));
        expect(extension).toEqual({ directive: 'connect-src', disposition: 'enforce', blocked: 'ws://localhost:35729', page: '/terminal/:id', scheme: 'ws', host: 'loopback', port: 'custom', source: 'extension' });
        const [app] = parseCspReports(report('http://127.0.0.1:38811/app-loopback', 'https://veryhappy.dev/assets/index-6c54afa6.js'));
        expect(app).toMatchObject({ scheme: 'http', host: 'loopback', port: 'custom', source: 'self' });
        expect(parseCspReports(report('http://10.0.0.5/app-private', 'https://veryhappy.dev/assets/index.js'))[0]).toMatchObject({ scheme: 'http', host: 'private', port: 'default', source: 'self' });
        expect(parseCspReports(report('http://example.com/app-public', 'https://veryhappy.dev/assets/index.js'))[0]).toMatchObject({ scheme: 'http', host: 'public', port: 'default' });
        // A script in the document itself (inline / injected text) reports the document URL.
        expect(parseCspReports(report('http://localhost:5173/', 'https://veryhappy.dev/terminal/cmvpe72j702e7qn2ulflthf88'))[0].source).toBe('inline');
        expect(parseCspReports(report('http://localhost:5173/', 'https://accounts.google.com/gsi/client'))[0].source).toBe('other');
        // Reporting API shape.
        expect(parseCspReports([{ type: 'csp-violation', body: { documentURL: 'https://veryhappy.dev/session/x', effectiveDirective: 'connect-src', blockedURL: 'ws://[::1]:9229/', sourceFile: 'moz-extension://0a1b/inject.js', disposition: 'enforce' } }])[0])
            .toMatchObject({ scheme: 'ws', host: 'loopback', port: 'custom', source: 'extension' });
        for (const violation of [extension, app]) expect(JSON.stringify(violation)).not.toMatch(/livereload|app-loopback|cmvpe72j/);
    });

    it('host classes', () => {
        for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]', 'LOCALHOST.']) expect(hostClass(host), host).toBe('loopback');
        for (const host of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.5', '169.254.1.1', '100.100.1.1', '[fd7a:115c::1]', '[fe80::1]', '[::ffff:192.168.0.2]', 'nas.local', 'devbox', 'router.lan', 'svc.internal']) expect(hostClass(host), host).toBe('private');
        for (const host of ['172.32.0.1', '8.8.8.8', '100.128.0.1', 'veryhappy.dev', '[2001:db8::1]', '999.1.1.1']) expect(hostClass(host), host).toBe('public');
    });

    it('source classes', () => {
        const doc = 'https://veryhappy.dev/session/abc#x';
        expect(sourceClass('chrome-extension', doc)).toBe('extension');
        expect(sourceClass('safari-web-extension://id/x.js', doc)).toBe('extension');
        expect(sourceClass('https://veryhappy.dev/assets/a.js', doc)).toBe('self');
        expect(sourceClass('https://veryhappy.dev/session/abc', doc)).toBe('inline');
        expect(sourceClass('https://cdn.example/x.js', doc)).toBe('other');
        expect(sourceClass(undefined, doc)).toBe('none');
        expect(sourceClass('', doc)).toBe('none');
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

    it('route: classification becomes metric labels and a URL-free log line', async () => {
        const app = Fastify();
        cspReportRoutes(app as any);
        logMock.mockClear();
        const res = await app.inject({ method: 'POST', url: '/v1/csp-report', headers: { 'content-type': 'application/csp-report' }, payload: JSON.stringify(report('ws://localhost:35729/livereload', 'chrome-extension')) });
        expect(res.statusCode).toBe(204);
        const series = (await cspViolationsCounter.get()).values.find((v) => v.labels.source === 'extension' && v.labels.host === 'loopback');
        expect(series?.labels).toEqual({ directive: 'connect-src', disposition: 'enforce', blocked: 'origin', scheme: 'ws', host: 'loopback', port: 'custom', source: 'extension' });
        const line = String(logMock.mock.calls.at(-1)?.[1]);
        expect(line).toBe('CSP violation: enforce connect-src blocked origin scheme=ws host=loopback port=custom source=extension on /terminal/:id');
        await app.close();
    });
});
