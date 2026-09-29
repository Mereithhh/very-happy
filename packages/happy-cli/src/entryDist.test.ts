import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import packageJson from '../package.json';

/**
 * B-512 review: `--version` is the bundle smoke test every daemon's handover
 * preflight runs (old daemons hard-code it). It must fail on a half-installed
 * tree, so it runs against the REAL built dist (`pnpm test` builds first).
 */
const PKG = join(__dirname, '..');
const DIST = join(PKG, 'dist');
const hasDist = existsSync(join(DIST, 'index.mjs'));
// Copies live under the package (gitignored tmp/) so bare imports still
// resolve through packages/happy-cli/node_modules.
const scratch = join(PKG, 'tmp', 'b512-entry-dist-test');
const home = mkdtempSync(join(tmpdir(), 'vh-b512-home-'));

function runEntry(distDir: string, arg: string) {
    return spawnSync(process.execPath, ['--no-warnings', join(distDir, 'index.mjs'), arg], {
        env: { ...process.env, HAPPY_HOME_DIR: home },
        encoding: 'utf8',
        timeout: 60_000,
    });
}

function brokenCopy(name: string, drop: RegExp): string {
    const dir = join(scratch, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    cpSync(DIST, dir, { recursive: true });
    const removed = readdirSync(dir).filter((f) => drop.test(f));
    expect(removed.length).toBeGreaterThan(0);
    for (const f of removed) rmSync(join(dir, f));
    return dir;
}

describe.skipIf(!hasDist)('built entry --version is the bundle self-check (B-512)', () => {
    afterAll(() => {
        rmSync(scratch, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    });

    it('prints exactly the version line on an intact bundle', () => {
        const r = runEntry(DIST, '--version');
        expect(r.status).toBe(0);
        expect(r.stdout).toBe(`very-happy version: ${packageJson.version}\n`);
    });

    it('--self-check is an alias with a summary line', () => {
        const r = runEntry(DIST, '--self-check');
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/^self-check: \d+ modules loaded in \d+ms\nvery-happy version: /);
    });

    it('fails when a lazily loaded chunk is missing (half-installed tree)', () => {
        const dir = brokenCopy('no-main', /^main-.*\.mjs$/);
        const r = runEntry(dir, '--version');
        expect(r.status).not.toBe(0);
        expect(r.stdout).not.toContain('very-happy version:');
        expect(r.stderr).toContain('failed to load main');
    });

    it('fails when the self-check chunk itself is missing', () => {
        const dir = brokenCopy('no-selfcheck', /^selfCheck-.*\.mjs$/);
        const r = runEntry(dir, '--version');
        expect(r.status).not.toBe(0);
        expect(r.stdout).not.toContain('very-happy version:');
    });
}, 120_000);
