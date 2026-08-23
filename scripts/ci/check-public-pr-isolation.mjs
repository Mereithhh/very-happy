import { readFileSync, readdirSync } from 'node:fs';

const workflowDir = new URL('../../.github/workflows/', import.meta.url);
const workflows = Object.fromEntries(
  readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, readFileSync(new URL(name, workflowDir), 'utf8')]),
);
const dockerfile = readFileSync(new URL('../../Dockerfile.server', import.meta.url), 'utf8');
const dockerignore = readFileSync(new URL('../../.dockerignore', import.meta.url), 'utf8');
const deployScript = readFileSync(new URL('./deploy-hwsg.sh', import.meta.url), 'utf8');

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

if (!/server-container-smoke:[\s\S]*if: github\.event_name == 'pull_request'[\s\S]*runs-on: ubuntu-latest/.test(
  workflows['quality.yml'] ?? '',
)) {
  errors.push('quality.yml: container smoke must run only for PRs on ubuntu-latest');
}

for (const name of ['deploy-hwsg.yml', 'publish.yml', 'runner-probe.yml']) {
  if (/pull_request\s*:/.test(workflows[name] ?? '')) {
    errors.push(`${name}: privileged workflow must never accept pull_request`);
  }
}

if (!/^CMD .*standalone\.ts migrate.*standalone\.ts serve/m.test(dockerfile)) {
  errors.push('Dockerfile.server: startup must migrate before serving');
}
if (!/^ENV DATA_DIR=\/data$/m.test(dockerfile) || !/^EXPOSE 3005$/m.test(dockerfile)) {
  errors.push('Dockerfile.server: public persistence and port contract changed');
}
if (!/^\*\*\/\.env$/m.test(dockerignore) || !/^\*\*\/\.env\.\*$/m.test(dockerignore)) {
  errors.push('.dockerignore: local environment and secret files must never enter server images');
}
if (!/^packages\/happy-server\/data$/m.test(dockerignore) || !/^packages\/happy-server\/\.pgdata$/m.test(dockerignore)) {
  errors.push('.dockerignore: local database directories must never enter server images');
}
if (/^COPY packages\/(happy-server|happy-web-v2) \.\/packages\//m.test(dockerfile)) {
  errors.push('Dockerfile.server: package directories must use whitelist COPY, never whole-directory COPY');
}
if (!/server-container-smoke:[\s\S]*smoke-server-container\.sh/.test(workflows['quality.yml'] ?? '')) {
  errors.push('quality.yml: executable container migration/persistence smoke is required');
}
if (!/docker inspect happy-server[\s\S]*\*migrate\*/.test(deployScript)) {
  errors.push('deploy-hwsg.sh: server deploy must fail closed without migration-on-start');
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('Public PR isolation checks passed.');
