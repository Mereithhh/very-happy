import { describe, expect, it } from 'vitest';
import { FRAME_COOKIE, frameCookie, readCookie, safeEntryPath, sameSite, shouldRenew, signToken, verifyToken } from './pluginFrame';
import { forwardRequestHeaders, isServiceWorkerRequest, isUnsupportedUpgrade, originAllowed, rewriteResponseHeaders, rewriteSetCookie, stripFrameAncestors } from './pluginHeaders';
import { bodyChunks, BODY_CHUNK_MAX } from './pluginGateway';

const key = Buffer.alloc(32, 7);

describe('frame tokens', () => {
    it('verify only an untampered, unexpired token of the same kind', () => {
        const now = 1_000;
        const t = signToken('ticket', { exp: now + 60_000, i: 'pi_1' }, key);
        expect(verifyToken('ticket', t, now, key)).toMatchObject({ i: 'pi_1' });
        expect(verifyToken('frame', t, now, key)).toBeNull();
        expect(verifyToken('ticket', t, now + 60_000, key)).toBeNull();
        expect(verifyToken('ticket', t, now, Buffer.alloc(32, 8))).toBeNull();
        const [body, sig] = t.split('.');
        const forged = Buffer.from(JSON.stringify({ k: 'ticket', exp: now + 60_000, i: 'pi_2' })).toString('base64url');
        expect(verifyToken('ticket', `${forged}.${sig}`, now, key)).toBeNull();
        expect(verifyToken('ticket', `${body}.`, now, key)).toBeNull();
        expect(verifyToken('ticket', `${body}.${sig}.x`, now, key)).toBeNull();
        expect(verifyToken('ticket', undefined, now, key)).toBeNull();
    });

    it('renews in the second half of the 12 h session', () => {
        expect(shouldRenew({ exp: 10 * 3600_000 }, 0)).toBe(false);
        expect(shouldRenew({ exp: 5 * 3600_000 }, 0)).toBe(true);
    });

    it('cookie: __Host- prefix rules (Secure, Path=/, no Domain), HttpOnly; Lax same-site, None+Partitioned cross-site', () => {
        const c = frameCookie('v', false);
        expect(c.startsWith(`${FRAME_COOKIE}=v;`)).toBe(true);
        expect(c).toContain('Path=/'); expect(c).toContain('Secure'); expect(c).toContain('HttpOnly'); expect(c).toContain('SameSite=Lax');
        expect(c.toLowerCase()).not.toContain('domain=');
        expect(frameCookie('v', true)).toContain('SameSite=None; Partitioned');
        expect(sameSite('https://app.example.com', 'p.example.com')).toBe(true);
        expect(sameSite('https://veryhappy.dev', 'p.example.com')).toBe(false);
        expect(readCookie('a=1; __Host-vhp=tok; b=2', FRAME_COOKIE)).toBe('tok');
        expect(readCookie('x__Host-vhp=no', FRAME_COOKIE)).toBeUndefined();
    });

    it('entry redirect stays on the plugin origin', () => {
        expect(safeEntryPath('/board?x=1', '/')).toBe('/board?x=1');
        for (const bad of ['//evil.example/', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)', '/a\nb']) expect(safeEntryPath(bad, '/'), bad).toBe('/');
        expect(safeEntryPath(undefined, '/entry')).toBe('/entry');
    });
});

describe('plugin origin headers (§4.3)', () => {
    const ancestors = ['https://web.example'];

    it('host headers win: frame-ancestors, CORP, Permissions-Policy, nosniff, no-referrer; XFO removed', () => {
        const out = rewriteResponseHeaders({
            'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Permissions-Policy': 'camera=*',
            'Referrer-Policy': 'unsafe-url', 'X-Content-Type-Options': 'x', 'Content-Type': 'text/html', 'Transfer-Encoding': 'chunked',
            'Content-Length': '5', 'Service-Worker-Allowed': '/',
        }, ancestors);
        expect(out['x-frame-options']).toBeUndefined();
        expect(out['transfer-encoding']).toBeUndefined();
        expect(out['content-length']).toBeUndefined();
        expect(out['service-worker-allowed']).toBeUndefined();
        expect(out['cross-origin-resource-policy']).toBe('same-origin');
        expect(out['permissions-policy']).toBe('camera=(), microphone=(), geolocation=(), clipboard-read=(), usb=(), payment=()');
        expect(out['referrer-policy']).toBe('no-referrer');
        expect(out['x-content-type-options']).toBe('nosniff');
        expect(out['content-security-policy']).toBe('frame-ancestors https://web.example');
        expect(out['content-type']).toBe('text/html');
    });

    it("keeps the plugin's own CSP minus its frame-ancestors, and adds the host's", () => {
        expect(stripFrameAncestors("default-src 'self'; frame-ancestors *; img-src data:")).toBe("default-src 'self'; img-src data:");
        expect(stripFrameAncestors('frame-ancestors *')).toBeNull();
        const out = rewriteResponseHeaders({ 'content-security-policy': "script-src 'self'; frame-ancestors *" }, ancestors);
        expect(out['content-security-policy']).toEqual(["script-src 'self'", 'frame-ancestors https://web.example']);
        expect(rewriteResponseHeaders({}, [])['content-security-policy']).toBe("frame-ancestors 'none'");
    });

    it('Set-Cookie made host-only; the host cookie name cannot be set', () => {
        expect(rewriteSetCookie('sid=1; Domain=.p.example.com; Path=/; HttpOnly')).toBe('sid=1; Path=/; HttpOnly');
        expect(rewriteSetCookie('__Host-vhp=evil; Path=/; Secure')).toBeNull();
        expect(rewriteSetCookie('__host-VHP2=evil')).toBeNull();
        const out = rewriteResponseHeaders({ 'set-cookie': ['a=1; domain=p.example.com', '__Host-vhp=x'] }, ancestors);
        expect(out['set-cookie']).toEqual(['a=1']);
    });

    it('request headers: frame cookie, X-VH-*, hop-by-hop, Host and forwarding headers stripped', () => {
        const out = forwardRequestHeaders({
            host: 'x.p.example.com', cookie: 'a=1; __Host-vhp=secret; b=2', 'x-vh-signature': 'forged', 'X-VH-Viewer': 'owner',
            connection: 'keep-alive', 'x-forwarded-for': '1.2.3.4', accept: 'text/html', 'content-length': '3',
        });
        expect(out).toEqual({ cookie: 'a=1; b=2', accept: 'text/html' });
        expect(forwardRequestHeaders({ cookie: '__Host-vhp=only' })).toEqual({});
    });

    it('non-GET needs this origin (or same-origin fetch metadata without Origin)', () => {
        const me = 'https://a-1.p.example.com';
        expect(originAllowed('GET', { origin: 'https://evil.example' }, me)).toBe(true);
        expect(originAllowed('POST', { origin: me }, me)).toBe(true);
        expect(originAllowed('POST', { origin: 'https://b-2.p.example.com' }, me)).toBe(false);
        expect(originAllowed('POST', { origin: 'null' }, me)).toBe(false);
        expect(originAllowed('DELETE', { 'sec-fetch-site': 'same-site' }, me)).toBe(false);
        expect(originAllowed('PUT', { 'sec-fetch-site': 'same-origin' }, me)).toBe(true);
        expect(originAllowed('POST', {}, me)).toBe(false);
        expect(originAllowed('POST', { origin: 'https://b-2.p.example.com', 'sec-fetch-site': 'same-origin' }, me)).toBe(false);
    });

    it('service worker scripts and upgrades / SSE are refused', () => {
        expect(isServiceWorkerRequest({ 'service-worker': 'script' })).toBe(true);
        expect(isServiceWorkerRequest({})).toBe(false);
        expect(isUnsupportedUpgrade({ upgrade: 'websocket' })).toBe(true);
        expect(isUnsupportedUpgrade({ accept: 'text/event-stream' })).toBe(true);
        expect(isUnsupportedUpgrade({ accept: 'text/html' })).toBe(false);
    });
});

describe('request body chunks', () => {
    it('≤ 512 KB each, in order', () => {
        const body = Buffer.alloc(BODY_CHUNK_MAX * 2 + 3, 1);
        const chunks = bodyChunks(body);
        expect(chunks.map(c => c.length)).toEqual([BODY_CHUNK_MAX, BODY_CHUNK_MAX, 3]);
    });
});
