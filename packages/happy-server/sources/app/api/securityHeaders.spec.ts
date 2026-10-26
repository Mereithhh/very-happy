import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, htmlSecurityHeaders, inlineScriptHashes, parseCspMode, reportOnlyContentSecurityPolicy } from './securityHeaders';

const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
const THEME = "(function(){document.documentElement.dataset.theme='dark'})()";
const CONFIG = 'window.__HAPPY_CONFIG__ = {"serverUrl":"same-origin"};';
const HTML = `<html><head><script id="vh-runtime-config">${CONFIG}</script><style>a{}</style><script>${THEME}</script>`
    + '<script type="module" crossorigin src="/assets/index-abc.js"></script></head><body></body></html>';

const directive = (policy: string, name: string) => policy.split('; ').find((d) => d.startsWith(`${name} `)) ?? null;

describe('B-825 CSP', () => {
    it('hashes exactly the inline scripts (runtime config + startup theme), not external ones', () => {
        expect(inlineScriptHashes(HTML)).toEqual([sha(CONFIG), sha(THEME)].sort());
    });

    it('script-src: self + those hashes, never unsafe-inline / unsafe-eval', () => {
        const policy = contentSecurityPolicy({ html: HTML, serverUrl: 'same-origin' });
        const scripts = directive(policy, 'script-src')!;
        expect(scripts).toContain("'self'");
        expect(scripts).toContain(sha(CONFIG));
        expect(scripts).toContain(sha(THEME));
        expect(scripts).not.toContain("'unsafe-inline'");
        expect(scripts).not.toContain("'unsafe-eval'");
        expect(directive(policy, 'object-src')).toBe("object-src 'none'");
        expect(directive(policy, 'base-uri')).toBe("base-uri 'self'");
        expect(directive(policy, 'frame-ancestors')).toBe("frame-ancestors 'self'");
        expect(directive(policy, 'report-uri')).toBe('report-uri /v1/csp-report');
        // The terminal CJK font CDN (stylesheet + woff2).
        expect(directive(policy, 'style-src')).toContain('https://veryhappy-fonts.pages.dev');
        expect(directive(policy, 'font-src')).toContain('https://veryhappy-fonts.pages.dev');
    });

    it('an http API origin (local self-host) is allowed with its socket; https ones are covered by https:/wss:', () => {
        const local = contentSecurityPolicy({ html: HTML, serverUrl: 'http://192.168.1.5:3005' });
        expect(directive(local, 'connect-src')).toContain('http://192.168.1.5:3005 ws://192.168.1.5:3005');
        const remote = contentSecurityPolicy({ html: HTML, serverUrl: 'https://api.example.com' });
        expect(directive(remote, 'connect-src')).toBe("connect-src 'self' https: wss: blob: data:");
    });

    it('stage two (report-only) narrows connect-src to known origins and drops frame-ancestors', () => {
        const policy = reportOnlyContentSecurityPolicy({ html: HTML, serverUrl: 'https://api.example.com', requestOrigin: 'https://veryhappy.dev' });
        const connect = directive(policy, 'connect-src')!;
        expect(connect).toContain('https://api.example.com wss://api.example.com');
        expect(connect).toContain('https://veryhappy.dev wss://veryhappy.dev');
        expect(connect).not.toMatch(/ https: | wss: /);
        expect(directive(policy, 'frame-ancestors')).toBeNull();
        expect(directive(policy, 'script-src')).toBe(directive(contentSecurityPolicy({ html: HTML }), 'script-src'));
    });

    it('modes: enforce sends both, report-only only the report header, off none; other headers always', () => {
        const ctx = { html: HTML, serverUrl: 'same-origin' };
        const enforce = htmlSecurityHeaders(ctx, 'enforce');
        expect(enforce['content-security-policy']).toBeDefined();
        expect(enforce['content-security-policy-report-only']).toBeDefined();
        const reportOnly = htmlSecurityHeaders(ctx, 'report-only');
        expect(reportOnly['content-security-policy']).toBeUndefined();
        expect(reportOnly['content-security-policy-report-only']).toBe(contentSecurityPolicy(ctx));
        const off = htmlSecurityHeaders(ctx, 'off');
        expect(Object.keys(off).filter((k) => k.includes('content-security'))).toEqual([]);
        for (const headers of [enforce, reportOnly, off]) {
            expect(headers['x-frame-options']).toBe('SAMEORIGIN');
            expect(headers['x-content-type-options']).toBe('nosniff');
            expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
            expect(headers['permissions-policy']).toContain('camera=()');
            expect(headers['permissions-policy']).toContain('microphone=(self)');
        }
        // A share page already chose no-referrer.
        expect(htmlSecurityHeaders(ctx, 'enforce', (n) => (n === 'referrer-policy' ? 'no-referrer' : undefined))['referrer-policy']).toBeUndefined();
    });

    it('CSP_MODE parsing defaults to enforce', () => {
        expect(parseCspMode(undefined)).toBe('enforce');
        expect(parseCspMode('Report-Only')).toBe('report-only');
        expect(parseCspMode('off')).toBe('off');
        expect(parseCspMode('nonsense')).toBe('enforce');
    });
});
