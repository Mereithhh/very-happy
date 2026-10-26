import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { spaFallback } from './spaFallback';
import { webStaticOptions } from './staticCache';
import { runtimeConfigScript } from './htmlConfigInjection';
import { webDocumentOnSend } from './webDocumentOnSend';
import { HTML_PREVIEW_CSP } from './securityHeaders';

const THEME = "document.documentElement.dataset.theme='dark'";
const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

async function webApp(cspMode: 'enforce' | 'report-only' | 'off' = 'enforce', relayOrigins?: string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-csp-test-'));
    fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><script>${THEME}</script></head><body>shell</body></html>`);
    fs.writeFileSync(path.join(dir, 'html-preview.html'), '<html><head><script src="html-preview.js"></script></head></html>');
    fs.writeFileSync(path.join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const app = Fastify();
    const config = { serverUrl: 'same-origin' };
    const injectScript = runtimeConfigScript(config);
    app.register((await import('@fastify/static')).default, webStaticOptions(dir));
    app.addHook('onSend', webDocumentOnSend({ injectScript, brand: null, serverUrl: config.serverUrl, relayOrigins, cspMode }));
    app.setNotFoundHandler(spaFallback(dir, injectScript, null));
    cleanup.push(() => app.close(), () => fs.rmSync(dir, { recursive: true, force: true }));
    const configText = /<script id="vh-runtime-config">([\s\S]*?)<\/script>/.exec(injectScript)![1];
    return { app, configText };
}

describe('B-825 Web documents carry a CSP matching what they contain', () => {
    it('/, /index.html and SPA routes: enforced CSP with the hashes of both inline scripts', async () => {
        const { app, configText } = await webApp();
        for (const url of ['/', '/index.html', '/session/abc', '/dev/sidebar']) {
            const res = await app.inject({ url });
            expect(res.statusCode, url).toBe(200);
            expect(res.body, url).toContain('__HAPPY_CONFIG__');
            const csp = res.headers['content-security-policy'] as string;
            expect(csp, url).toContain(sha(THEME));
            expect(csp, url).toContain(sha(configText));
            expect(csp, url).not.toMatch(/script-src[^;]*'unsafe-inline'/);
            expect(res.headers['content-security-policy-report-only'], url).toBeDefined();
            expect(res.headers['x-frame-options'], url).toBe('SAMEORIGIN');
            expect(res.headers['referrer-policy'], url).toBe('strict-origin-when-cross-origin');
            expect(res.headers['x-content-type-options'], url).toBe('nosniff');
            expect(Number(res.headers['content-length']), url).toBe(Buffer.byteLength(res.body));
        }
    });

    it('the Report-Only connect-src carries the configured relays (served documents, not just the builder)', async () => {
        const { app } = await webApp('enforce', ['https://relay-sg.veryhappy.dev', 'https://relay-us.veryhappy.dev']);
        const res = await app.inject({ url: '/terminal/cmvpe72j702e7qn2ulflthf88', headers: { host: 'veryhappy.dev', 'x-forwarded-proto': 'https' } });
        const connect = String(res.headers['content-security-policy-report-only']).split('; ').find((d) => d.startsWith('connect-src '))!;
        expect(connect).toContain('https://veryhappy.dev wss://veryhappy.dev');
        expect(connect).toContain('https://relay-sg.veryhappy.dev wss://relay-sg.veryhappy.dev https://relay-us.veryhappy.dev wss://relay-us.veryhappy.dev');
    });

    it('startApi wires the HAPPY_RELAYS_JSON relays it parsed at startup into the document hook', () => {
        const api = fs.readFileSync(path.join(__dirname, 'api.ts'), 'utf8');
        expect(api).toContain('const relays = relayFeatureConfig();');
        expect(api).toMatch(/webDocumentOnSend\(\{[^}]*relayOrigins: relays\.candidates\.map\(\(relay\) => relay\.url\)/);
    });

    it('share pages keep no-referrer and get the same CSP', async () => {
        const { app } = await webApp();
        const res = await app.inject({ url: '/s/cmlink123' });
        expect(res.headers['referrer-policy']).toBe('no-referrer');
        expect(res.headers['content-security-policy']).toContain(sha(THEME));
    });

    it('the HTML preview frame gets its own sandboxed policy and no runtime config', async () => {
        const { app } = await webApp();
        const res = await app.inject({ url: '/html-preview.html' });
        expect(res.headers['content-security-policy']).toBe(HTML_PREVIEW_CSP);
        expect(res.headers['content-security-policy']).toMatch(/^sandbox allow-scripts /);
        expect(res.headers['content-security-policy']).not.toContain('allow-same-origin');
        expect(res.body).not.toContain('__HAPPY_CONFIG__');
    });

    it('non-HTML responses get nosniff only; CSP_MODE=report-only never enforces', async () => {
        const { app } = await webApp('report-only');
        const svg = await app.inject({ url: '/icon.svg' });
        expect(svg.headers['x-content-type-options']).toBe('nosniff');
        expect(svg.headers['content-security-policy']).toBeUndefined();
        const page = await app.inject({ url: '/' });
        expect(page.headers['content-security-policy']).toBeUndefined();
        expect(page.headers['content-security-policy-report-only']).toContain(sha(THEME));
    });
});
