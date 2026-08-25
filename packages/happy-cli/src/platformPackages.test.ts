import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const unpacker = require('../scripts/unpack-tools.cjs') as {
  PLATFORM_PACKAGES: Record<string, string>;
  getPlatformDir(platform?: string, arch?: string): string;
  getPlatformPackageName(platformDir?: string): string;
  getArchivesDir(toolsDir: string, platformDir: string, resolver: (id: string, options: { paths: string[] }) => string): string;
};

const targets = [
  { id: 'arm64-darwin', os: 'darwin', cpu: 'arm64' },
  { id: 'x64-darwin', os: 'darwin', cpu: 'x64' },
  { id: 'arm64-linux', os: 'linux', cpu: 'arm64' },
  { id: 'x64-linux', os: 'linux', cpu: 'x64' },
  { id: 'arm64-win32', os: 'win32', cpu: 'arm64' },
  { id: 'x64-win32', os: 'win32', cpu: 'x64' },
] as const;

const cliRoot = fileURLToPath(new URL('..', import.meta.url));
const platformRoot = fileURLToPath(new URL('../../happy-cli-tools', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const cliPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('platform tool packages', () => {
  it('maps every supported OS/CPU pair to one exact optional dependency', () => {
    const lockfile = readFileSync(`${repoRoot}/pnpm-lock.yaml`, 'utf8');
    expect(cliPackage.files).not.toContain('tools/archives');
    expect(Object.keys(cliPackage.optionalDependencies)).toHaveLength(targets.length);

    for (const target of targets) {
      const name = `very-happy-tools-${target.id}`;
      expect(unpacker.getPlatformDir(target.os, target.cpu)).toBe(target.id);
      expect(unpacker.getPlatformPackageName(target.id)).toBe(name);
      expect(unpacker.PLATFORM_PACKAGES[target.id]).toBe(name);
      expect(cliPackage.optionalDependencies[name]).toBe(cliPackage.version);
      // pnpm filters workspace projects by the host os/cpu while regenerating
      // the lockfile, so keep this assertion: CI's frozen install must retain
      // every optional target, not only the machine that last touched the lock.
      expect(lockfile).toContain(`      ${name}:`);
    }
  });

  it('publishes only the two archives needed by each declared platform', () => {
    for (const target of targets) {
      const packageDir = `${platformRoot}/${target.id}`;
      const manifest = JSON.parse(readFileSync(`${packageDir}/package.json`, 'utf8'));
      expect(manifest).toMatchObject({
        name: `very-happy-tools-${target.id}`,
        os: [target.os],
        cpu: [target.cpu],
        version: cliPackage.version,
      });
      expect(readdirSync(`${packageDir}/archives`).sort()).toEqual([
        `difftastic-${target.id}.tar.gz`,
        `ripgrep-${target.id}.tar.gz`,
      ]);
      expect(readFileSync(`${packageDir}/THIRD_PARTY_LICENSES.txt`, 'utf8')).toContain('Difftastic');
      expect(readFileSync(`${packageDir}/THIRD_PARTY_LICENSES.txt`, 'utf8')).toContain('Ripgrep');
    }
  });

  it('resolves an installed package and fails clearly when optional packages are omitted', () => {
    const target = targets[0];
    const manifest = `${platformRoot}/${target.id}/package.json`;
    expect(unpacker.getArchivesDir(cliRoot, target.id, () => manifest)).toBe(`${platformRoot}/${target.id}/archives`);
    expect(() => unpacker.getArchivesDir(cliRoot, target.id, () => {
      throw new Error('not installed');
    })).toThrow(`very-happy-tools-${target.id}`);
    expect(() => unpacker.getArchivesDir(cliRoot, target.id, () => {
      throw new Error('not installed');
    })).toThrow('without --omit=optional');
  });

  it('publishes platform artifacts before the main CLI and smoke-packs only the current one', () => {
    const publishWorkflow = readFileSync(`${repoRoot}/.github/workflows/publish.yml`, 'utf8');
    const smokeWorkflow = readFileSync(`${repoRoot}/.github/workflows/cli-smoke-test.yml`, 'utf8');
    expect(publishWorkflow.indexOf('Publish platform tool packages to npm')).toBeLessThan(
      publishWorkflow.indexOf('Publish main CLI package to npm'),
    );
    expect(smokeWorkflow).toContain('getPlatformPackageName()');
    expect(smokeWorkflow).toContain('CLI_BYTES');
  });
});
