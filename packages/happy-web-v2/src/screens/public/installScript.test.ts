import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptPath = new URL('../../../public/install.sh', import.meta.url);
const tempDirs: string[] = [];

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
}

function fixture(options: { node?: string; arch?: string; npmVersion?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'very-happy-install-'));
  tempDirs.push(root);
  const bin = join(root, 'bin');
  const calls = join(root, 'calls.log');
  const mkdir = spawnSync('/bin/mkdir', ['-p', bin]);
  expect(mkdir.status).toBe(0);
  executable(join(bin, 'node'), `
case "$1" in
  -p)
    case "$2" in
      process.versions.node) printf '%s\\n' '${options.node ?? '22.19.0'}' ;;
      process.arch) printf '%s\\n' '${options.arch ?? 'arm64'}' ;;
    esac ;;
  -e)
    case "$2" in
      *'new URL'*)
        case "$3 $4" in
          *http://relay.example.com*) exit 1 ;;
          *) exit 0 ;;
        esac ;;
      *) exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac`);
  executable(join(bin, 'npm'), `
if [ "$1" = view ]; then
  printf '%s\\n' '${options.npmVersion ?? '0.2.61'}'
  exit 0
fi
printf 'npm %s\\n' "$*" >> "$VH_TEST_CALLS"`);
  executable(join(bin, 'very-happy'), `
printf 'very-happy %s\\n' "$*" >> "$VH_TEST_CALLS"
if [ "$1" = --version ]; then printf '%s\\n' 'very-happy version: 0.2.61'; fi`);
  return { root, bin, calls };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('public first-machine bootstrap', () => {
  it('is valid POSIX shell and documents its non-destructive boundary', () => {
    expect(spawnSync('/bin/sh', ['-n', scriptPath.pathname]).status).toBe(0);
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).toContain('very-happy-cli@$CLI_VERSION');
    expect(source).toContain('not end-to-end encrypted');
    expect(source).toContain('run "$VH_BIN" doctor');
    expect(source).toContain('run "$VH_BIN" auth login');
    expect(source).toContain('run "$VH_BIN" daemon start');
    expect(source).toContain('very-happy daemon stop && very-happy daemon start');
    expect(source).not.toMatch(/\bsudo\b.*(?:npm|apt|brew)/);
    expect(source).not.toContain('install-terminal-hooks');
  });

  it('pins the resolved npm version and runs doctor, approval, then daemon startup', () => {
    const f = fixture();
    const result = spawnSync('/bin/sh', [scriptPath.pathname], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${f.bin}:/usr/bin:/bin`, VH_TEST_CALLS: f.calls },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(f.calls, 'utf8').trim().split('\n')).toEqual([
      'npm install --global --no-fund --no-audit very-happy-cli@0.2.61',
      'very-happy --version',
      'very-happy doctor',
      'very-happy auth login',
      'very-happy daemon start',
    ]);
    expect(result.stdout).toContain('non-persistent direct-shell fallback');
  });

  it('supports an offline no-mutation dry run and explicit skipped steps', () => {
    const f = fixture();
    const result = spawnSync('/bin/sh', [scriptPath.pathname, '--dry-run', '--no-auth', '--no-daemon'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${f.bin}:/usr/bin:/bin`,
        VH_TEST_CALLS: f.calls,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('+ npm install --global --no-fund --no-audit very-happy-cli@<published-version>');
    expect(result.stdout).toContain('+ very-happy --version');
    expect(result.stdout).toContain('Skipping authentication (--no-auth).');
    expect(result.stdout).toContain('Skipping daemon startup (--no-daemon).');
    expect(result.stdout).toContain('Preview complete; no local changes were made.');
    expect(result.stdout).not.toContain('Very Happy is ready on this machine.');
    expect(() => readFileSync(f.calls, 'utf8')).toThrow();
  });

  it('fails closed on an unsupported Node runtime before npm install', () => {
    const f = fixture({ node: '20.18.0' });
    executable(join(f.bin, 'node'), `
case "$1" in
  -p) printf '%s\\n' '20.18.0' ;;
  -e) exit 1 ;;
esac`);
    const result = spawnSync('/bin/sh', [scriptPath.pathname], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${f.bin}:/usr/bin:/bin`, VH_TEST_CALLS: f.calls },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unsupported Node.js 20.18.0');
    expect(() => readFileSync(f.calls, 'utf8')).toThrow();
  });

  it('rejects unsupported architectures and unsafe or mismatched custom endpoints', () => {
    const unsupported = fixture({ arch: 'ia32' });
    const archResult = spawnSync('/bin/sh', [scriptPath.pathname], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${unsupported.bin}:/usr/bin:/bin`, VH_TEST_CALLS: unsupported.calls },
    });
    expect(archResult.status).not.toBe(0);
    expect(archResult.stderr).toContain('unsupported CPU architecture ia32');

    const mismatched = fixture();
    const mismatchedResult = spawnSync('/bin/sh', [scriptPath.pathname], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${mismatched.bin}:/usr/bin:/bin`, VH_TEST_CALLS: mismatched.calls, HAPPY_SERVER_URL: 'https://relay.example.com' },
    });
    expect(mismatchedResult.status).not.toBe(0);
    expect(mismatchedResult.stderr).toContain('must be configured together');

    const insecure = fixture();
    const insecureResult = spawnSync('/bin/sh', [scriptPath.pathname], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${insecure.bin}:/usr/bin:/bin`,
        VH_TEST_CALLS: insecure.calls,
        HAPPY_SERVER_URL: 'http://relay.example.com',
        HAPPY_WEBAPP_URL: 'http://relay.example.com',
      },
    });
    expect(insecureResult.status).not.toBe(0);
    expect(insecureResult.stderr).toContain('custom endpoints must use HTTPS');
  });
});
