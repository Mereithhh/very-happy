import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signPluginEvent, signPluginRequest, verifyPluginEvent } from '@slopus/happy-wire';
import { createPluginSecretFileText, createPluginToken, readPluginSecretKey } from './signing';

describe('B-974c credentials (r3/r5) and the wire signatures', () => {
    it('token is vhp_ + 32 bytes base64url', () => {
        expect(createPluginToken()).toMatch(/^vhp_[A-Za-z0-9_-]{43}$/);
        expect(createPluginToken()).not.toBe(createPluginToken());
    });

    it('secret file: 43 base64url chars + newline, no prefix; the key is the 32 decoded bytes', () => {
        const text = createPluginSecretFileText();
        expect(text).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
        const key = readPluginSecretKey(text)!;
        expect(key).toHaveLength(32);
        expect(Buffer.from(key).toString('base64url')).toBe(text.trim());
        expect(readPluginSecretKey(`  ${text}  `)).toEqual(key);
        for (const bad of ['vhs_' + text.trim(), text.trim() + '=', text.trim().slice(0, 42), 'x', '']) expect(readPluginSecretKey(bad)).toBeNull();
        expect(readPluginSecretKey(null)).toBeNull();
    });

    it('the HMAC key is the decoded bytes, never the text', () => {
        const text = createPluginSecretFileText();
        const key = readPluginSecretKey(text)!;
        const body = '{"id":"evt_1"}';
        const expected = createHmac('sha256', Buffer.from(key)).update(`v1:1795577286:evt_1:${body}`).digest('hex');
        expect(signPluginEvent(key, 1795577286, 'evt_1', body)).toBe(`v1=${expected}`);
        const wrong = createHmac('sha256', text.trim()).update(`v1:1795577286:evt_1:${body}`).digest('hex');
        expect(signPluginEvent(key, 1795577286, 'evt_1', body)).not.toBe(`v1=${wrong}`);
        expect(verifyPluginEvent({ secret: key, signature: `v1=${expected}`, timestamp: 1795577286, eventId: 'evt_1', rawBody: body, nowSec: 1795577286 }).ok).toBe(true);
        expect(signPluginRequest(key, 1, 'r', 'post', '/x?a=1', new Uint8Array())).toBe(signPluginRequest(key, 1, 'r', 'POST', '/x?a=1'));
    });
});
