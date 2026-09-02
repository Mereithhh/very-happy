import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCliRelease,
  evaluateWebRelease,
  extractReleases,
  normalizeVersion,
  parseLiveReleaseSha,
  parseSkipReason,
} from './check-release.mjs';

const SOURCE = `
export const CHANGELOG_RELEASES = [
  {
    id: '2026-09-02-b',
    date: '2026-09-02',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.97',
    titleKey: 'x',
  },
  {
    id: '2026-09-02-a',
    date: '2026-09-02',
    titleKey: 'y',
  },
  {
    id: '2026-08-31',
    cliVersion: '0.2.90',
  },
];
export function changelogCliNotices(machines, release) { return release.cliVersion; }
`;

test('reads the live release SHA from the public entry asset name', () => {
  const sha = 'a'.repeat(40);
  assert.equal(parseLiveReleaseSha(`<script src="/assets/index-B8ZUnOJn-${sha}.js">`), sha);
  assert.equal(parseLiveReleaseSha('<script src="/assets/index-B8ZUnOJn.js">'), null);
  assert.equal(parseLiveReleaseSha(''), null);
});

test('extracts release ids and cliVersions in file order', () => {
  assert.deepEqual(extractReleases(SOURCE), [
    { id: '2026-09-02-b', cliVersion: '0.2.97' },
    { id: '2026-09-02-a', cliVersion: null },
    { id: '2026-08-31', cliVersion: '0.2.90' },
  ]);
});

test('web: passes when nothing user-facing shipped', () => {
  const releases = extractReleases(SOURCE);
  const verdict = evaluateWebRelease({
    commits: ['a1\tdocs: runbook', 'b2\tchore(ci): bump action'],
    liveReleases: releases,
    targetReleases: releases,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.facing.length, 0);
});

test('web: fails when user-facing commits ship without a new changelog head', () => {
  const releases = extractReleases(SOURCE);
  const verdict = evaluateWebRelease({
    commits: ['a1\tfeat(web): stack unseen releases (#146)', 'b2\ttest: cover it'],
    liveReleases: releases,
    targetReleases: releases,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.facing.length, 1);
  assert.match(verdict.reason, /2026-09-02-b/);
});

test('web: passes when the target adds a release the live build lacks', () => {
  const live = extractReleases(SOURCE).slice(1);
  const target = extractReleases(SOURCE);
  const verdict = evaluateWebRelease({ commits: ['a1\tfix(cli): auth recycle'], liveReleases: live, targetReleases: target });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.added, ['2026-09-02-b']);
});

test('cli: requires an entry with the exact cliVersion only when CLI commits are user-facing', () => {
  const releases = extractReleases(SOURCE);
  assert.equal(evaluateCliRelease({ version: '0.2.97', commits: ['a1\tfeat(cli): x'], releases }).ok, true);
  assert.equal(evaluateCliRelease({ version: '0.2.98', commits: ['a1\tchore(cli): bump deps'], releases }).ok, true);
  const fail = evaluateCliRelease({ version: '0.2.98', commits: ['a1\tfix(cli): daemon crash'], releases });
  assert.equal(fail.ok, false);
  assert.match(fail.reason, /cliVersion '0\.2\.98'/);
});

test('annotated tag message can carry an audited skip', () => {
  assert.equal(parseSkipReason('v0.2.99\n\n[changelog-skip: internal hotfix, no user-visible change]'), 'internal hotfix, no user-visible change');
  assert.equal(parseSkipReason('v0.2.99'), null);
  assert.equal(parseSkipReason(null), null);
  assert.equal(normalizeVersion('v0.2.99'), '0.2.99');
});
