// B-691 prerequisite: land-pr must never delete a local branch or worktree.
// `gh pr merge --delete-branch` deletes the local branch too — and with it the
// linked worktree that has it checked out (team workers share this repository),
// which removed active workers' worktrees right after their PRs landed.
// Runs the real script against a fake `gh` / `git` on PATH and records calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'land-pr.sh');

function run(headRepo) {
    const bin = mkdtempSync(join(tmpdir(), 'land-pr-test-'));
    const log = join(bin, 'calls.log');
    writeFileSync(join(bin, 'gh'), `#!/bin/bash
echo "gh $*" >> "${log}"
case "$*" in
  "repo view"*) echo o/r ;;
  *"--jq .head.sha"*) echo 0123456789abcdef ;;
  *"--jq .mergeable_state"*) echo clean ;;
  "run list"*) echo 100 ;;
  *"--json status"*) echo completed ;;
  *"--json workflowName,conclusion"*) echo "Quality Gates success" ;;
  *"--json conclusion"*) echo success ;;
  "pr merge"*) echo "✓ Squashed and merged pull request" ;;
  *"--jq .merge_commit_sha"*) echo fedcba9876543210 ;;
  *"--jq .state"*) echo closed ;;
  *"--jq .head.ref"*) echo team/B-1-fix ;;
  *"--jq .head.repo.full_name"*) echo ${headRepo} ;;
  *) echo "" ;;
esac
`);
    writeFileSync(join(bin, 'git'), `#!/bin/bash\necho "git $*" >> "${log}"\n`);
    writeFileSync(join(bin, 'sleep'), '#!/bin/bash\n');
    for (const f of ['gh', 'git', 'sleep']) chmodSync(join(bin, f), 0o755);
    const result = spawnSync('bash', [script, '7'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    rmSync(bin, { recursive: true, force: true });
    return { result, calls };
}

test('merges without --delete-branch and deletes only the remote branch', () => {
    const { result, calls } = run('o/r');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const merge = calls.filter(c => c.startsWith('gh pr merge'));
    assert.deepEqual(merge, ['gh pr merge 7 --squash']);
    assert.ok(calls.includes('gh api -X DELETE repos/o/r/git/refs/heads/team/B-1-fix'));
    assert.deepEqual(calls.filter(c => c.startsWith('git ')), []); // never touches local branches or worktrees
    assert.match(result.stdout, /local branch and worktrees untouched/);
});

test('leaves a fork head branch alone', () => {
    const { result, calls } = run('someone/fork');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(calls.some(c => c.includes('-X DELETE')), false);
});
