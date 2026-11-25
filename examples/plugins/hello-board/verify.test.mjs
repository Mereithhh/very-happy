// node --test examples/plugins/hello-board/verify.test.mjs
// Locks the reference verifier to the test vectors in docs/plugin-api-v1.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signEvent, signRequest, verifyEvent, verifyRequest, createDedupe } from './verify.mjs';

const secret = 'vhs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ts = 1795577286;
const eventId = 'evt_01JTESTVECTOR0000000000000';
const rawBody = '{"id":"evt_01JTESTVECTOR0000000000000","type":"decision.responded","installId":"pi_test","pluginId":"hello-board","createdAt":1795577286598,"attempt":1,"data":{"itemId":"it_1","key":"count:5","action":"choose","choice":"continue","respondedAt":1795577286000,"actor":"owner"}}';

test('event vector', () => {
    const sig = 'v1=26293e76e58b6d272a3f57797bdf36caacac9a6b83682bb89157ff6a40191748';
    assert.equal(signEvent(secret, ts, eventId, rawBody), sig);
    const headers = { 'x-vh-timestamp': String(ts), 'x-vh-event-id': eventId, 'x-vh-signature': sig };
    assert.equal(verifyEvent({ secret, headers, rawBody: Buffer.from(rawBody), nowSec: ts + 300 }), true);
    assert.equal(verifyEvent({ secret, headers, rawBody: Buffer.from(rawBody), nowSec: ts + 301 }), false);
    assert.equal(verifyEvent({ secret, headers, rawBody: Buffer.from(rawBody + ' '), nowSec: ts }), false);
    assert.equal(verifyEvent({ secret: secret + 'x', headers, rawBody, nowSec: ts }), false);
    assert.equal(verifyEvent({ secret, headers: { ...headers, 'x-vh-event-id': 'evt_other' }, rawBody, nowSec: ts }), false);
    assert.equal(verifyEvent({ secret, headers: { ...headers, 'x-vh-signature': undefined }, rawBody, nowSec: ts }), false);
});

test('request vectors', () => {
    const sig = 'v1=a729e176808c5ea4371e5a960690f469103473763da445b1a9f19cc6cf86702e';
    assert.equal(signRequest(secret, ts, 'req_01JTEST', 'POST', '/api/count?x=1', Buffer.from('{"delta":1}')), sig);
    assert.equal(signRequest(secret, ts, 'req_01JTEST', 'GET', '/'), 'v1=80a3a21bab1f04934a5e204d24f482d695dfb437dfcc44f60767eb2a6b8092dc');
    const headers = { 'x-vh-timestamp': String(ts), 'x-vh-request-id': 'req_01JTEST', 'x-vh-signature': sig };
    assert.equal(verifyRequest({ secret, method: 'POST', pathWithQuery: '/api/count?x=1', headers, body: Buffer.from('{"delta":1}'), nowSec: ts }), true);
    assert.equal(verifyRequest({ secret, method: 'POST', pathWithQuery: '/api/count?x=2', headers, body: Buffer.from('{"delta":1}'), nowSec: ts }), false);
});

test('dedupe remembers ids for 10 minutes', () => {
    const first = createDedupe();
    assert.equal(first('a', 0), true);
    assert.equal(first('a', 1000), false);
    assert.equal(first('a', 10 * 60 * 1000 + 1), true);
});
