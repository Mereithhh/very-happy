import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { evaluateSmokeEvidence } from './cli-smoke-evidence.mjs';

const { SHA: sha, RELEASE_TAG: tag, GITHUB_REPOSITORY: repository } = process.env;
if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !/^v\d+\.\d+\.\d+$/.test(tag ?? '')
    || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('invalid release identity');
const api = (path, paginate = false) => JSON.parse(execFileSync('gh', ['api', path, ...(paginate ? ['--paginate', '--slurp'] : [])], {
  encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
}));
const deadline = Date.now() + 35 * 60_000;
while (Date.now() < deadline) {
  const runs = api(`repos/${repository}/actions/workflows/cli-smoke-test.yml/runs?head_sha=${sha}&event=push&per_page=100`, true)
    .flatMap((page) => page.workflow_runs);
  // Select one tag run, never mix jobs from a Linux-only main push or manual run.
  const run = runs.filter((item) => item.head_sha === sha && item.event === 'push' && item.head_branch === tag)
    .sort((a, b) => b.id - a.id)[0];
  if (run) {
    const jobs = run.status === 'completed'
      ? api(`repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, true).flatMap((page) => page.jobs)
      : [];
    const verdict = evaluateSmokeEvidence({ run, jobs }, { sha, tag, repository });
    console.log(verdict.reason);
    if (verdict.state === 'passed') process.exit(0);
    if (verdict.state === 'failed') throw new Error('smoke evidence rejected; latest stays unchanged');
  } else console.log(`waiting for smoke tag ${tag} at ${sha}`);
  await setTimeout(30_000);
}
throw new Error('smoke did not finish in 35 minutes; latest stays unchanged');
