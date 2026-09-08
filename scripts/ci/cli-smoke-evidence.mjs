/** Pure validation of GitHub REST run/jobs JSON. Never execute downloaded code. */
export const REQUIRED_SMOKE_JOBS = ['linux', 'macos-14', 'windows-latest']
  .flatMap((platform) => [20, 24].map((node) => `smoke (${platform}, node ${node})`));
export const SMOKE_WORKFLOW_PATH = '.github/workflows/cli-smoke-test.yml';

export function evaluateSmokeEvidence({ run, jobs }, { sha, tag, repository }) {
  const failed = (reason) => ({ state: 'failed', reason });
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^v\d+\.\d+\.\d+$/.test(tag) || !repository) return failed('invalid expected release identity');
  if (!run || run.head_sha !== sha || run.head_branch !== tag || run.event !== 'push'
      || run.path !== SMOKE_WORKFLOW_PATH
      || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) {
    return failed('smoke run does not match this repository, tag, SHA and push workflow');
  }
  if (run.status !== 'completed') return { state: 'pending', reason: `run ${run.id} is ${run.status}` };
  if (run.conclusion !== 'success') return failed(`run ${run.id} concluded ${run.conclusion}`);
  if (!Number.isInteger(run.id) || !Number.isInteger(run.run_attempt) || !Array.isArray(jobs)) return failed('invalid run/jobs payload');
  for (const name of REQUIRED_SMOKE_JOBS) {
    const matching = jobs.filter((job) => job.name === name);
    if (matching.length !== 1) return failed(`${name}: expected one job, received ${matching.length}`);
    const job = matching[0];
    if (job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.head_sha !== sha) {
      return failed(`${name}: job belongs to a different run, attempt or SHA`);
    }
    if (job.status !== 'completed' || job.conclusion !== 'success') return failed(`${name}: ${job.status}/${job.conclusion}`);
  }
  return { state: 'passed', reason: `run ${run.id} attempt ${run.run_attempt}: all six smoke jobs passed` };
}
