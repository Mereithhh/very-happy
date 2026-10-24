import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIDDEN_ACTION_ALLOWLIST, SMALL_TARGET_ALLOWLIST, notAllowed } from './touchGate.mjs';

test('notAllowed keeps only keys outside the allowlist (B-798 device-shots gate)', () => {
    const allow = new Map([['button.ok', 'reason']]);
    assert.deepEqual(notAllowed([{ key: 'button.ok', text: 'a' }, { key: 'button.new', text: 'b' }], allow), [{ key: 'button.new', text: 'b' }]);
    assert.deepEqual(notAllowed([], allow), []);
});

test('every allowlist entry names an owner or a reason', () => {
    for (const [key, why] of [...SMALL_TARGET_ALLOWLIST, ...HIDDEN_ACTION_ALLOWLIST]) {
        assert.match(key, /^[a-z]+(?:\.[\w-]+| in \.[\w-]+)$/, key);
        assert.ok(why.trim().length >= 4, key);
    }
});
