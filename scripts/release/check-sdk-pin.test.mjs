import { test } from 'node:test';
import assert from 'node:assert/strict';
import { message, sdkPinFreshness, WARN_BEHIND_DAYS } from './check-sdk-pin.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-06T00:00:00Z');
const registry = (versions) => ({
    'dist-tags': { latest: versions.at(-1)[0] },
    versions: Object.fromEntries(versions.map(([v]) => [v, {}])),
    time: Object.fromEntries(versions.map(([v, at]) => [v, new Date(at).toISOString()])),
});

test('current pin is not stale', () => {
    const r = sdkPinFreshness({ pinned: '0.3.319', registry: registry([['0.3.318', NOW - DAY], ['0.3.319', NOW]]), now: NOW });
    assert.deepEqual(r, { pinned: '0.3.319', latest: '0.3.319', behind: 0, days: 0, stale: false });
    assert.match(message(r), /is current/);
});

test('a few releases behind but recent is reported, not stale', () => {
    const r = sdkPinFreshness({ pinned: '0.3.306', registry: registry([['0.3.306', NOW - 3 * DAY], ['0.3.307', NOW - 2 * DAY]]), now: NOW });
    assert.equal(r.behind, 1);
    assert.equal(r.stale, false);
});

test('stale after 5 releases or 14 days since the first newer one (11-06 real case: 13 behind)', () => {
    const many = Array.from({ length: 14 }, (_, i) => [`0.3.${306 + i}`, NOW - (13 - i) * DAY]);
    const r = sdkPinFreshness({ pinned: '0.3.306', registry: registry(many), now: NOW });
    assert.equal(r.behind, 13);
    assert.equal(r.stale, true);
    assert.match(message(r), /Consider bumping/);
    const old = sdkPinFreshness({ pinned: '0.3.306', registry: registry([['0.3.306', 0], ['0.3.307', NOW - WARN_BEHIND_DAYS * DAY]]), now: NOW });
    assert.equal(old.stale, true);
});

test('pre-releases are ignored', () => {
    const reg = registry([['0.3.306', NOW]]);
    reg.versions['0.3.400-beta.1'] = {};
    assert.equal(sdkPinFreshness({ pinned: '0.3.306', registry: reg, now: NOW }).behind, 0);
});
