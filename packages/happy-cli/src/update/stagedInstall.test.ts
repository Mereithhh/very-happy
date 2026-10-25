import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installCliStaged, type StagedInstallDependencies } from './stagedInstall';
import type { NpmResult } from './npmInstall';

const BIN = { 'very-happy': './bin/very-happy.mjs', 'very-happy-mcp': './bin/very-happy-mcp.mjs' };

function writePackage(dir: string, version: string, chunks: string[], bin: Record<string, string> = BIN) {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'very-happy-cli', version, bin }));
    for (const target of Object.values(bin)) writeFileSync(join(dir, target), `// ${version}`);
    writeFileSync(join(dir, 'dist', 'index.mjs'), `// index ${version}`);
    for (const chunk of chunks) writeFileSync(join(dir, 'dist', chunk), `// ${chunk} ${version}`);
}

describe('installCliStaged (B-817)', () => {
    let prefix: string; let live: string; let root: string;
    beforeEach(() => {
        prefix = mkdtempSync(join(tmpdir(), 'b817-staged-'));
        root = join(prefix, 'lib', 'node_modules');
        live = join(root, 'very-happy-cli');
        writePackage(live, '0.2.184', ['api-OLD111.mjs', 'shared-SAME00.mjs']);
        mkdirSync(join(prefix, 'bin'));
        for (const [name, target] of Object.entries(BIN)) symlinkSync(join('..', 'lib', 'node_modules', 'very-happy-cli', target), join(prefix, 'bin', name));
        writeFileSync(join(root, '.package-lock.json'), '{}');
    });
    afterEach(() => { rmSync(prefix, { recursive: true, force: true }); });

    /** Fake npm: writes the new version into whatever --prefix it is given, like `npm i -g --prefix`. */
    function deps(overrides: Partial<StagedInstallDependencies> = {}, onNpm?: (args: string[]) => NpmResult | void): StagedInstallDependencies & { npm: ReturnType<typeof vi.fn> } {
        const npm = vi.fn(async (args: string[]): Promise<NpmResult> => {
            const custom = onNpm?.(args);
            if (custom) return custom;
            const target = args.find((arg) => arg.startsWith('--prefix='))!.slice('--prefix='.length);
            // npm must never be pointed at the live prefix by this path.
            expect(target).not.toBe(prefix);
            writePackage(join(target, 'lib', 'node_modules', 'very-happy-cli'), '0.2.185', ['api-NEW222.mjs', 'shared-SAME00.mjs']);
            mkdirSync(join(target, 'bin'), { recursive: true });
            return { code: 0, stdout: '' };
        });
        return { npm, fs: { ...fsp }, platform: 'linux', runningPackageDir: live, now: () => 42, ...overrides } as never;
    }

    it('swaps in the new tree, keeps old chunks, never touches the bins, and cleans up', async () => {
        const d = deps();
        const report = await installCliStaged('0.2.185', d);
        expect(report.outcome).toBe(0);
        expect(JSON.parse(readFileSync(join(live, 'package.json'), 'utf8')).version).toBe('0.2.185');
        // the old wrapper's lazily imported chunk still resolves; the new build wins where names collide
        expect(readFileSync(join(live, 'dist', 'api-OLD111.mjs'), 'utf8')).toContain('0.2.184');
        expect(readFileSync(join(live, 'dist', 'api-NEW222.mjs'), 'utf8')).toContain('0.2.185');
        expect(readFileSync(join(live, 'dist', 'shared-SAME00.mjs'), 'utf8')).toContain('0.2.185');
        expect(readFileSync(join(live, 'dist', 'index.mjs'), 'utf8')).toContain('0.2.185');
        expect(report.keptChunks).toBe(1);
        // bins were never unlinked and resolve into the new tree
        expect(readlinkSync(join(prefix, 'bin', 'very-happy'))).toBe(join('..', 'lib', 'node_modules', 'very-happy-cli', './bin/very-happy.mjs'));
        expect(readFileSync(join(prefix, 'bin', 'very-happy'), 'utf8')).toContain('0.2.185');
        // only the live package remains; stage, retired and the stale hidden lockfile are gone
        expect(readdirSync(root).sort()).toEqual(['very-happy-cli']);
        expect(d.npm).toHaveBeenCalledWith(['i', '-g', `--prefix=${join(root, '.very-happy-cli-stage-0.2.185')}`, '--allow-scripts=very-happy-cli,node-pty', 'very-happy-cli@0.2.185']);
    });

    it('the live path is replaced by rename only after the staged tree is verified', async () => {
        const calls: string[] = [];
        const d = deps({ fs: { ...fsp, rename: vi.fn(async (from: string, to: string) => { calls.push(`${from} -> ${to}`); return fsp.rename(from, to); }) } as never });
        await installCliStaged('0.2.185', d);
        expect(calls).toEqual([
            `${live} -> ${join(root, '.very-happy-cli-retired-0.2.184-42')}`,
            `${join(root, '.very-happy-cli-stage-0.2.185', 'lib', 'node_modules', 'very-happy-cli')} -> ${live}`,
        ]);
    });

    it('defers when the new version changes the bin map; the live tree is untouched', async () => {
        const d = deps({}, (args) => {
            const target = args.find((arg) => arg.startsWith('--prefix='))!.slice('--prefix='.length);
            writePackage(join(target, 'lib', 'node_modules', 'very-happy-cli'), '0.2.185', [], { ...BIN, 'very-happy-x': './bin/x.mjs' });
            return { code: 0, stdout: '' };
        });
        expect((await installCliStaged('0.2.185', d)).outcome).toEqual({ deferred: 'staged_bin_map_changed' });
        expect(JSON.parse(readFileSync(join(live, 'package.json'), 'utf8')).version).toBe('0.2.184');
        expect(readdirSync(root).sort()).toEqual(['.package-lock.json', 'very-happy-cli']);
    });

    it('defers when a bin moved inside the package', async () => {
        const d = deps({}, (args) => {
            const target = args.find((arg) => arg.startsWith('--prefix='))!.slice('--prefix='.length);
            writePackage(join(target, 'lib', 'node_modules', 'very-happy-cli'), '0.2.185', [], { ...BIN, 'very-happy': './bin/moved.mjs' });
            return { code: 0, stdout: '' };
        });
        expect((await installCliStaged('0.2.185', d)).outcome).toEqual({ deferred: 'staged_bin_map_changed' });
    });

    it('defers when a live bin is missing (npm would have to create it)', async () => {
        rmSync(join(prefix, 'bin', 'very-happy-mcp'));
        expect((await installCliStaged('0.2.185', deps())).outcome).toEqual({ deferred: 'live_bin_not_linked' });
        expect(JSON.parse(readFileSync(join(live, 'package.json'), 'utf8')).version).toBe('0.2.184');
    });

    it('an npm failure reports its exit code and leaves the live tree and stage clean', async () => {
        const d = deps({}, () => ({ code: 1, stdout: '', stderr: 'ETARGET' }));
        expect((await installCliStaged('0.2.185', d)).outcome).toBe(1);
        expect(JSON.parse(readFileSync(join(live, 'package.json'), 'utf8')).version).toBe('0.2.184');
        expect(existsSync(join(root, '.very-happy-cli-stage-0.2.185'))).toBe(false);
    });

    it('unconfirmed npm termination is blocked', async () => {
        const d = deps({}, () => ({ code: null, stdout: '', terminationConfirmed: false }));
        expect((await installCliStaged('0.2.185', d)).outcome).toBe('blocked');
    });

    it('rolls the old tree back when the second rename fails', async () => {
        let n = 0;
        const d = deps({ fs: { ...fsp, rename: vi.fn(async (from: string, to: string) => { if (++n === 2) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); return fsp.rename(from, to); }) } as never });
        expect((await installCliStaged('0.2.185', d)).outcome).toEqual({ deferred: 'staged_swap_failed' });
        expect(JSON.parse(readFileSync(join(live, 'package.json'), 'utf8')).version).toBe('0.2.184');
        expect(readdirSync(root).sort()).toEqual(['.package-lock.json', 'very-happy-cli']);
    });

    it('a version npm did not actually install is unverified, not installed', async () => {
        const d = deps({}, (args) => {
            const target = args.find((arg) => arg.startsWith('--prefix='))!.slice('--prefix='.length);
            writePackage(join(target, 'lib', 'node_modules', 'very-happy-cli'), '0.2.184', []);
            return { code: 0, stdout: '' };
        });
        expect((await installCliStaged('0.2.185', d)).outcome).toEqual({ deferred: 'staged_package_unverified' });
    });

    it('refuses layouts it cannot prove: Windows, unknown prefix, symlinked package', async () => {
        expect((await installCliStaged('0.2.185', deps({ platform: 'win32' }))).outcome).toEqual({ deferred: 'staged_install_unsupported' });
        expect((await installCliStaged('0.2.185', deps({ runningPackageDir: join(prefix, 'elsewhere', 'very-happy-cli') }))).outcome).toEqual({ manual: 'install_location_unverified' });
        const linked = join(dirname(prefix), `${prefix.split('/').pop()}-linked`);
        mkdirSync(join(linked, 'lib', 'node_modules'), { recursive: true });
        symlinkSync(live, join(linked, 'lib', 'node_modules', 'very-happy-cli'));
        try {
            expect((await installCliStaged('0.2.185', deps({ runningPackageDir: join(linked, 'lib', 'node_modules', 'very-happy-cli') }))).outcome).toEqual({ manual: 'install_location_unverified' });
        } finally { rmSync(linked, { recursive: true, force: true }); }
        await expect(installCliStaged('latest', deps())).rejects.toThrow('Invalid exact CLI version');
    });
});
