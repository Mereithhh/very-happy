import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPluginSecret, createPluginToken, signEvent, signPanelRequest, verifyEventSignature } from './signing';

// Fixed vector (DESIGN §8: the wire tests lock the same values).
const SECRET = Buffer.alloc(32, 7).toString('base64url');

describe('B-974c signatures (DESIGN §5.5)', () => {
    it('token is vhp_ + 32 bytes base64url; secret is 32 bytes', () => {
        expect(createPluginToken()).toMatch(/^vhp_[A-Za-z0-9_-]{43}$/);
        expect(Buffer.from(createPluginSecret(), 'base64url')).toHaveLength(32);
        expect(createPluginToken()).not.toBe(createPluginToken());
    });

    it('event signature = v1=hex(HMAC(secret, "v1:ts:eventId:body")) with the decoded key', () => {
        const body = '{"id":"evt_1","type":"ping"}';
        const expected = createHmac('sha256', Buffer.alloc(32, 7)).update(`v1:1795577286:evt_1:${body}`).digest('hex');
        expect(signEvent(SECRET, 1795577286, 'evt_1', body)).toBe(`v1=${expected}`);
        expect(signEvent(SECRET, 1795577286, 'evt_1', body)).toBe('v1=' + expected);
    });

    it('panel signature covers method, path+query and the body hash', () => {
        const a = signPanelRequest(SECRET, 100, 'r1', 'post', '/api/x?a=1', Buffer.from('{}'));
        expect(a).toBe(signPanelRequest(SECRET, 100, 'r1', 'POST', '/api/x?a=1', Buffer.from('{}')));
        for (const other of [
            signPanelRequest(SECRET, 101, 'r1', 'POST', '/api/x?a=1', Buffer.from('{}')),
            signPanelRequest(SECRET, 100, 'r2', 'POST', '/api/x?a=1', Buffer.from('{}')),
            signPanelRequest(SECRET, 100, 'r1', 'GET', '/api/x?a=1', Buffer.from('{}')),
            signPanelRequest(SECRET, 100, 'r1', 'POST', '/api/x?a=2', Buffer.from('{}')),
            signPanelRequest(SECRET, 100, 'r1', 'POST', '/api/x?a=1', Buffer.from('{ }')),
            signPanelRequest(createPluginSecret(), 100, 'r1', 'POST', '/api/x?a=1', Buffer.from('{}')),
        ]) expect(other).not.toBe(a);
    });

    it('reference verifier: right signature, ±300 s window, tampering', () => {
        const now = 2_000_000_000;
        const sig = signEvent(SECRET, now, 'evt_9', 'body');
        expect(verifyEventSignature(SECRET, sig, now, 'evt_9', 'body', now)).toBe(true);
        expect(verifyEventSignature(SECRET, sig, now, 'evt_9', 'body', now + 300)).toBe(true);
        expect(verifyEventSignature(SECRET, sig, now, 'evt_9', 'body', now + 301)).toBe(false);
        expect(verifyEventSignature(SECRET, sig, now, 'evt_9', 'body!', now)).toBe(false);
        expect(verifyEventSignature(SECRET, sig, now, 'evt_8', 'body', now)).toBe(false);
        expect(verifyEventSignature(SECRET, sig.slice(0, -1), now, 'evt_9', 'body', now)).toBe(false);
        expect(verifyEventSignature(SECRET, undefined, now, 'evt_9', 'body', now)).toBe(false);
    });
});
