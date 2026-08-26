import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workflowDir = new URL('../../.github/workflows/', import.meta.url);
const workflows = Object.fromEntries(
  readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, readFileSync(new URL(name, workflowDir), 'utf8')]),
);
const dockerfile = readFileSync(new URL('../../Dockerfile.server', import.meta.url), 'utf8');
const dockerignore = readFileSync(new URL('../../.dockerignore', import.meta.url), 'utf8');
const deployScript = readFileSync(new URL('./deploy-hwsg.sh', import.meta.url), 'utf8');
const remoteServerDeployScript = readFileSync(new URL('./deploy-server-remote.sh', import.meta.url), 'utf8');
const blueGreenDeployScript = readFileSync(new URL('./deploy-blue-green-remote.sh', import.meta.url), 'utf8');
const daemonUpdateScript = readFileSync(new URL('../update-daemon.sh', import.meta.url), 'utf8');

const errors = [];
for (const [name, source] of Object.entries(workflows)) {
  if (/\bpull_request_target\s*:|\bworkflow_run\s*:/.test(source)) {
    errors.push(`${name}: privileged fork-code trigger is forbidden`);
  }
  if (/pull_request\s*:/.test(source) && !/permissions:\s*\n\s+contents:\s+read/.test(source)) {
    errors.push(`${name}: pull_request workflow must keep contents: read permissions`);
  }
  for (const line of source.split(/\r?\n/)) {
    const action = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/)?.[1];
    if (!action || action.startsWith('./')) continue;
    if (action.startsWith('docker://')) {
      if (!/@sha256:[a-f0-9]{64}$/.test(action)) {
        errors.push(`${name}: container action ${action} must use an immutable sha256 digest`);
      }
      continue;
    }
    const ref = action.slice(action.lastIndexOf('@') + 1);
    if (!/^[a-f0-9]{40}$/.test(ref)) {
      errors.push(`${name}: external action ${action} must use a full 40-character commit SHA`);
    }
  }
}

for (const name of ['quality.yml', 'cli-smoke-test.yml']) {
  const source = workflows[name] ?? '';
  if (/runs-on:[^\n]*(?:self-hosted|vars\.LINUX_RUNNER)/.test(source)) {
    errors.push(`${name}: public quality and smoke jobs must never select private runners`);
  }
}

if (!/secret-scan:[\s\S]*?runs-on: ubuntu-latest/.test(workflows['quality.yml'] ?? '')
  || !/gates:[\s\S]*?runs-on: ubuntu-latest/.test(workflows['quality.yml'] ?? '')) {
  errors.push('quality.yml: secret scan and package gates must always use ubuntu-latest');
}
if (!/smoke-linux:[\s\S]*?runs-on: ubuntu-latest/.test(workflows['cli-smoke-test.yml'] ?? '')
  || !/smoke-macos:[\s\S]*?runs-on: macos-14/.test(workflows['cli-smoke-test.yml'] ?? '')) {
  errors.push('cli-smoke-test.yml: Linux and macOS smoke must use GitHub-hosted runners');
}

if (!/server-container-smoke:[\s\S]*if: github\.event_name == 'pull_request'[\s\S]*runs-on: ubuntu-latest/.test(
  workflows['quality.yml'] ?? '',
)) {
  errors.push('quality.yml: container smoke must run only for PRs on ubuntu-latest');
}

const secretScanJob = (workflows['quality.yml'] ?? '').match(
  /\n  secret-scan:\n([\s\S]*?)(?=\n  [a-zA-Z0-9_-]+:\n|$)/,
)?.[1] ?? '';
if (!secretScanJob.includes('runs-on: ubuntu-latest')
  || !/fetch-depth: 0[\s\S]*scan-secrets\.sh --ci/.test(secretScanJob)) {
  errors.push('quality.yml: introduced-commit secret scan must stay hosted with full history available');
}
const secretScanScript = readFileSync(new URL('./scan-secrets.sh', import.meta.url), 'utf8');
if (!/GITLEAKS_VERSION="8\.30\.0"/.test(secretScanScript)
  || !/GITLEAKS_LINUX_X64_SHA256="[a-f0-9]{64}"/.test(secretScanScript)
  || !/--redact=100/.test(secretScanScript)) {
  errors.push('scan-secrets.sh: scanner version, checksum, and full redaction must stay pinned');
}

for (const name of ['deploy-hwsg.yml', 'publish.yml', 'runner-probe.yml']) {
  if (/pull_request\s*:/.test(workflows[name] ?? '')) {
    errors.push(`${name}: privileged workflow must never accept pull_request`);
  }
}

if (!/^CMD .*standalone\.ts migrate.*standalone\.ts serve/m.test(dockerfile)) {
  errors.push('Dockerfile.server: startup must migrate before serving');
}
if (!/prisma format --schema=prisma\/schema\.prisma[\s\\]+&& cmp packages\/happy-server\/prisma\/schema\.prisma node_modules\/\.prisma\/client\/schema\.prisma/.test(dockerfile)) {
  errors.push('Dockerfile.server: packaged Prisma schema must be canonicalized and byte-match the generated Client');
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
if (!/SERVER_IMAGE:\?SERVER_IMAGE digest is required/.test(deployScript)
  || !/very-happy-server@sha256/.test(deployScript)
  || !/deploy-blue-green-remote\.sh/.test(deployScript)) {
  errors.push('deploy-hwsg.sh: server deploy must use the immutable GHCR digest and blue-green remote helper');
}
if (!/permissions:\s*\n\s+contents: read\s*\n\s+packages: write/.test(workflows['deploy-hwsg.yml'] ?? '')
  || !/test "\$GITHUB_REF" = refs\/heads\/main/.test(workflows['deploy-hwsg.yml'] ?? '')
  || !/docker\/build-push-action@[a-f0-9]{40}[\s\S]*file: Dockerfile\.server[\s\S]*push: true/.test(
    workflows['deploy-hwsg.yml'] ?? '',
  )
  || !/Promote verified image to latest[\s\S]*if: inputs\.target != 'publish'/.test(
    workflows['deploy-hwsg.yml'] ?? '',
  )) {
  errors.push('deploy-hwsg.yml: main-only complete server image publication to GHCR is required');
}
if (!/docker pull "\$IMAGE"/.test(remoteServerDeployScript)
  || !/node_modules\/\.prisma\/client\/schema\.prisma/.test(remoteServerDeployScript)
  || !/docker compose up -d --force-recreate happy-server/.test(remoteServerDeployScript)) {
  errors.push('deploy-server-remote.sh: pull, Prisma consistency check, and forced recreate are required');
}
if (/docker compose restart happy-server/.test(remoteServerDeployScript)) {
  errors.push('deploy-server-remote.sh: source-only container restart is forbidden');
}
if (!/docker pull "\$IMAGE"/.test(blueGreenDeployScript)
  || !/node_modules\/\.prisma\/client\/schema\.prisma/.test(blueGreenDeployScript)
  || !/groundwork\|shadow\|switch/.test(blueGreenDeployScript)
  || !/\/_vh\/release\/canary/.test(blueGreenDeployScript)
  || !/\/_vh\/release\/cancel/.test(blueGreenDeployScript)
  || !/write_active_upstream/.test(blueGreenDeployScript)
  || !/reload_caddy/.test(blueGreenDeployScript)) {
  errors.push('deploy-blue-green-remote.sh: immutable image, phased canary, drain rollback, and atomic Caddy switch are required');
}

const rewriteTestDir = mkdtempSync(join(tmpdir(), 'vh-compose-rewrite-'));
try {
  const composeFixture = join(rewriteTestDir, 'compose.yml');
  const oldDigest = `sha256:${'a'.repeat(64)}`;
  const newDigest = `sha256:${'b'.repeat(64)}`;
  writeFileSync(composeFixture, `services:\n  happy-server:\n    image: ghcr.io/mereithhh/very-happy-server@${oldDigest}\n    volumes:\n      - happy-data:/data\n      - /opt/happy/webapp:/repo/packages/happy-server/webapp:ro\n      - /opt/happy-src/packages/happy-server/sources:/repo/packages/happy-server/sources:ro\n      - /opt/happy-src/packages/happy-server/prisma/migrations:/repo/packages/happy-server/prisma/migrations:ro\n`);
  const rewrite = spawnSync('bash', [
    fileURLToPath(new URL('./deploy-server-remote.sh', import.meta.url)),
    '--rewrite-compose-test',
    composeFixture,
    `ghcr.io/mereithhh/very-happy-server@${newDigest}`,
  ], { encoding: 'utf8' });
  const rewritten = readFileSync(composeFixture, 'utf8');
  if (rewrite.status !== 0
    || !rewritten.includes(`image: ghcr.io/mereithhh/very-happy-server@${newDigest}`)
    || rewritten.includes('/opt/happy-src/')
    || rewritten.includes('/opt/happy/webapp:')) {
    errors.push(`deploy-server-remote.sh: digest-to-digest Compose rewrite failed: ${rewrite.stderr.trim()}`);
  }
} finally {
  rmSync(rewriteTestDir, { recursive: true, force: true });
}
if (!/npm view very-happy-cli@latest version/.test(daemonUpdateScript)
  || !/very-happy-cli@\$LATEST_VERSION/.test(daemonUpdateScript)
  || !/--allow-scripts=very-happy-cli,node-pty/.test(daemonUpdateScript)
  || !/version verification failed/.test(daemonUpdateScript)) {
  errors.push('update-daemon.sh: updater must resolve, allowlist, and verify an exact CLI version');
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('Public PR isolation checks passed.');
