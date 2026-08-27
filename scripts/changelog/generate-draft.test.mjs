import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDraft, parseCommitLine } from './generate-draft.mjs';

test('parses conventional user-facing commits and strips PR suffixes', () => {
  assert.deepEqual(parseCommitLine('abc123\tfeat(web): add release history (#42)'), {
    hash: 'abc123', type: 'feat', scope: 'web', breaking: false, subject: 'add release history',
  });
  assert.equal(parseCommitLine('abc123\tdocs: update runbook'), null);
  assert.equal(parseCommitLine('malformed'), null);
});

test('groups a reviewable draft without publishing internal commit types', () => {
  const draft = buildDraft([
    'a1\tfeat(web): add release history',
    'b2\tfix(cli)!: restart the daemon',
    'c3\tperf(relay): reduce latency',
    'd4\ttest: add coverage',
  ], 'v0.2.80', 'HEAD');
  assert.equal(draft.count, 3);
  assert.match(draft.markdown, /## Features/);
  assert.match(draft.markdown, /\*\*BREAKING\*\*/);
  assert.doesNotMatch(draft.markdown, /add coverage/);
  assert.match(draft.markdown, /Review, rewrite for users, translate/);
});
