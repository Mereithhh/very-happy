// node --test examples/plugins/hello-board/verify.test.mjs
// Locks the reference verifier to the test vectors in docs/plugin-api-v1.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSecret, signEvent, signRequest, verifyEvent, verifyRequest, createDedupe } from './verify.mjs';

const secretFile = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE\n';
const key = decodeSecret(secretFile);
const ts = 1795577286;
const eventId = 'evt_01JTESTVECTOR0000000000000';
const rawBody = '{"id":"evt_01JTESTVECTOR0000000000000","type":"decision.responded","installId":"pi_test","pluginId":"hello-board","createdAt":1795577286598,"attempt":1,"data":{"itemId":"it_1","key":"count:5","action":"choose","choice":"continue","respondedAt":1795577286000,"actor":"owner"}}';

test('event vector', () => {
    const sig = 'v1=020f2dc559ea6540094c4ad2adfc0cc55408f104ca8b96166a1738525874c737';
    assert.equal(signEvent(key, ts, eventId, rawBody), sig);
    const headers = { 'x-vh-timestamp': String(ts), 'x-vh-event-id': eventId, 'x-vh-signature': sig };
    assert.equal(verifyEvent({ key, headers, rawBody: Buffer.from(rawBody), nowSec: ts + 300 }), true);
    assert.equal(verifyEvent({ key, headers, rawBody: Buffer.from(rawBody), nowSec: ts + 301 }), false);
    assert.equal(verifyEvent({ key, headers, rawBody: Buffer.from(rawBody + ' '), nowSec: ts }), false);
    assert.equal(verifyEvent({ key: Buffer.alloc(32, 2), headers, rawBody, nowSec: ts }), false);
    assert.equal(verifyEvent({ key, headers: { ...headers, 'x-vh-event-id': 'evt_other' }, rawBody, nowSec: ts }), false);
    assert.equal(verifyEvent({ key, headers: { ...headers, 'x-vh-signature': undefined }, rawBody, nowSec: ts }), false);
});

test('request vectors', () => {
    const sig = 'v1=60cf37275780ee4c721da0b4724d2fb8f872b474066d1b20bad20cb325708362';
    assert.equal(signRequest(key, ts, 'req_01JTEST', 'POST', '/api/count?x=1', Buffer.from('{"delta":1}')), sig);
    assert.equal(signRequest(key, ts, 'req_01JTEST', 'GET', '/'), 'v1=44002e33ed4e7748d5813ea71d5e87e0bc28a38d6ea67022b3ae179d89891433');
    const headers = { 'x-vh-timestamp': String(ts), 'x-vh-request-id': 'req_01JTEST', 'x-vh-signature': sig };
    assert.equal(verifyRequest({ key, method: 'POST', pathWithQuery: '/api/count?x=1', headers, body: Buffer.from('{"delta":1}'), nowSec: ts }), true);
    assert.equal(verifyRequest({ key, method: 'POST', pathWithQuery: '/api/count?x=2', headers, body: Buffer.from('{"delta":1}'), nowSec: ts }), false);
});

test('secret file decoding', () => {
    assert.equal(key.toString('hex'), '01'.repeat(32));
    for (const bad of ['vhs_' + secretFile.trim(), secretFile.trim() + '=', secretFile.trim().slice(0, 42), secretFile.trim().slice(0, 42) + '+', '']) {
        assert.throws(() => decodeSecret(bad), bad);
    }
    assert.throws(() => signEvent(secretFile, ts, eventId, rawBody), TypeError);
});

test('dedupe remembers ids for 10 minutes', () => {
    const first = createDedupe();
    assert.equal(first('a', 0), true);
    assert.equal(first('a', 1000), false);
    assert.equal(first('a', 10 * 60 * 1000 + 1), true);
});
