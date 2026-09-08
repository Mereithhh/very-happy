import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateSmokeEvidence } from './cli-smoke-evidence.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/cli-smoke-success.json', import.meta.url), 'utf8'));
const expected = { sha: 'a'.repeat(40), tag: 'v0.2.123', repository: 'Mereithhh/very-happy' };
const check = (evidence) => evaluateSmokeEvidence(evidence, expected);

test('accepts a complete single-attempt six-job JSON fixture', () => {
  assert.equal(check(structuredClone(fixture)).state, 'passed');
});
for (const [label, mutate] of [
  ['missing Windows matrix', (e) => { e.jobs = e.jobs.slice(0, 4); }],
  ['skipped Windows despite green workflow', (e) => { e.jobs[4].conclusion = 'skipped'; }],
  ['cancelled job', (e) => { e.jobs[0].conclusion = 'cancelled'; }],
  ['failed job', (e) => { e.jobs[1].conclusion = 'failure'; }],
  ['unfinished job despite completed workflow', (e) => { e.jobs[0].status = 'in_progress'; }],
  ['missing conclusion', (e) => { delete e.jobs[0].conclusion; }],
  ['duplicate matrix slot', (e) => { e.jobs.push(e.jobs[0]); }],
  ['wrong job SHA', (e) => { e.jobs[0].head_sha = 'b'.repeat(40); }],
  ['jobs mixed across runs', (e) => { e.jobs[0].run_id++; }],
  ['jobs mixed across rerun attempts', (e) => { e.jobs[0].run_attempt--; }],
  ['wrong run SHA', (e) => { e.run.head_sha = 'b'.repeat(40); }],
  ['main push instead of tag', (e) => { e.run.head_branch = 'main'; }],
  ['another tag at same SHA', (e) => { e.run.head_branch = 'v0.2.122'; }],
  ['manual dispatch', (e) => { e.run.event = 'workflow_dispatch'; }],
  ['pull request', (e) => { e.run.event = 'pull_request'; }],
  ['fork head repository', (e) => { e.run.head_repository.full_name = 'attacker/very-happy'; }],
  ['different run repository', (e) => { e.run.repository.full_name = 'attacker/very-happy'; }],
  ['other workflow', (e) => { e.run.path = '.github/workflows/quality.yml'; }],
  ['workflow cancelled despite green jobs', (e) => { e.run.conclusion = 'cancelled'; }],
  ['workflow skipped despite green jobs', (e) => { e.run.conclusion = 'skipped'; }],
]) {
  test(`rejects ${label}`, () => {
    const evidence = structuredClone(fixture);
    mutate(evidence);
    assert.equal(check(evidence).state, 'failed');
  });
}
test('waits for the matching run while it is in progress', () => {
  const evidence = structuredClone(fixture);
  evidence.run.status = 'in_progress';
  evidence.run.conclusion = null;
  evidence.jobs = [];
  assert.equal(check(evidence).state, 'pending');
});
test('does not wait for a mismatched unfinished run', () => {
  const evidence = structuredClone(fixture);
  evidence.run.status = 'in_progress';
  evidence.run.event = 'pull_request';
  assert.equal(check(evidence).state, 'failed');
});
test('rejects missing release identity', () => {
  assert.equal(evaluateSmokeEvidence(fixture, { ...expected, sha: undefined }).state, 'failed');
});
