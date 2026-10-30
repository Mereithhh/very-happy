import assert from 'node:assert/strict';
import test from 'node:test';
import { findStaleness, loadTable, tierVersion } from './check-latest-models.mjs';

const codex = loadTable().agents.codex;
const list = (ids, def) => ids.map((model) => ({ model, isDefault: model === def }));

test('Codex 0.166 bundled catalog (2026-10-30) is covered by the table', () => {
    const catalog = list(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-6.1-terra', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'], 'gpt-6.1-sol');
    assert.deepEqual(findStaleness(codex, catalog), []);
});

test('a newer sol in the catalog is reported', () => {
    const problems = findStaleness(codex, list(['gpt-6.2-sol', 'gpt-6.1-sol'], 'gpt-6.2-sol'));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /gpt-6\.2-sol newer than table head gpt-6\.1-sol/);
    assert.equal(findStaleness(codex, list(['gpt-7-sol'], 'gpt-7-sol')).length, 1);
});

test('other tiers never count as newer, but a default outside the tier is flagged', () => {
    assert.deepEqual(findStaleness(codex, list(['gpt-7-luna', 'gpt-6.1-sol'], 'gpt-6.1-sol')), []);
    const problems = findStaleness(codex, list(['gpt-7-astra', 'gpt-6.1-sol'], 'gpt-7-astra'));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /outside the sol tier/);
});

test('tier versions parse like the wire resolver', () => {
    assert.deepEqual(tierVersion(codex, 'gpt-6.1-sol'), [6, 1]);
    assert.deepEqual(tierVersion(codex, 'gpt-6-sol'), [6]);
    assert.equal(tierVersion(codex, 'gpt-6.1-terra'), null);
});
