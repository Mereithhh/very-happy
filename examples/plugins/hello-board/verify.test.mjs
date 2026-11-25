// node --test examples/plugins/hello-board/verify.test.mjs
// Locks the reference verifier to the test vectors in docs/plugin-api-v1.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

// The documented vectors must stay identical to the host's own tests
// (packages/happy-wire/src/pluginCrypto.test.ts) and to this manifest.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const canonical = (v) => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
    : v && typeof v === 'object' ? '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
    : JSON.stringify(v);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

test('docs vectors match the wire tests and vh-plugin.json', () => {
    const doc = read('../../../docs/plugin-api-v1.md');
    const wire = read('../../../packages/happy-wire/src/pluginCrypto.test.ts');
    for (const v of [secretFile.trim(), String(ts), eventId, rawBody, 'req_01JTEST',
        'v1=020f2dc559ea6540094c4ad2adfc0cc55408f104ca8b96166a1738525874c737',
        'v1=60cf37275780ee4c721da0b4724d2fb8f872b474066d1b20bad20cb325708362',
        'v1=44002e33ed4e7748d5813ea71d5e87e0bc28a38d6ea67022b3ae179d89891433']) {
        assert.ok(doc.includes(v), `doc lacks ${v}`);
        assert.ok(wire.includes(v), `pluginCrypto.test.ts lacks ${v}`);
    }
    assert.ok(doc.includes(key.toString('hex')));
    // hello-board's manifest already spells out every default and has no unknown
    // fields, so its parsed form equals the file and the canonical hash applies directly.
    const m = JSON.parse(read('./vh-plugin.json'));
    assert.ok(doc.includes(sha256(canonical(m))), 'manifestHash vector');
    const priv = canonical({
        id: m.id, name: m.name, icon: m.icon, permissions: [...m.permissions].sort(),
        panels: m.panels.map((p) => ({ id: p.id, upstream: p.upstream })).sort((a, b) => (a.id < b.id ? -1 : 1)),
        callbackUrl: m.callback?.url ?? null, sidebarPanel: m.sidebar?.panel ?? null, sessionWidget: m.sessionWidget === true,
    });
    assert.ok(doc.includes(priv), 'privileged canonical view');
    assert.ok(doc.includes(sha256(priv)), 'privilegedHash vector');
    assert.ok(read('../../../packages/happy-wire/src/plugins.test.ts').includes(sha256(priv)), 'wire privilegedHash');
});
