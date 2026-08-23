import { readFileSync, readdirSync } from 'node:fs';

const workflowDir = new URL('../../.github/workflows/', import.meta.url);
const workflows = Object.fromEntries(
  readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, readFileSync(new URL(name, workflowDir), 'utf8')]),
);

const errors = [];
for (const [name, source] of Object.entries(workflows)) {
  if (/\bpull_request_target\s*:|\bworkflow_run\s*:/.test(source)) {
    errors.push(`${name}: privileged fork-code trigger is forbidden`);
  }
  if (/pull_request\s*:/.test(source) && !/permissions:\s*\n\s+contents:\s+read/.test(source)) {
    errors.push(`${name}: pull_request workflow must keep contents: read permissions`);
  }
}

for (const name of ['quality.yml', 'cli-smoke-test.yml']) {
  const source = workflows[name] ?? '';
  const hostedPrExpression = "github.event_name == 'pull_request' && '[\"ubuntu-latest\"]'";
  if (!source.includes(hostedPrExpression)) {
    errors.push(`${name}: every PR code-execution job must select ubuntu-latest before private runner variables`);
  }
}

for (const name of ['deploy-hwsg.yml', 'publish.yml', 'runner-probe.yml']) {
  if (/pull_request\s*:/.test(workflows[name] ?? '')) {
    errors.push(`${name}: privileged workflow must never accept pull_request`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('Public PR isolation checks passed.');
