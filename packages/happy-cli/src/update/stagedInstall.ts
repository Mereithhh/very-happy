/**
 * B-817 — install a new CLI next to the running one, then swap the directory.
 *
 * `npm i -g` reifies in place: measured on 0.2.184 → 0.2.185 the whole package
 * directory (scripts/, dist/, package.json, the bundled Claude binary) was
 * absent for ~4.3 s of a 13 s install, and `installCliSafely` unlinks the
 * `very-happy` / `very-happy-mcp` bins for the entire npm run. Anything a turn
 * touches in that window fails: a `very-happy …` call from the agent's Bash
 * tool, the SessionStart hook forwarder on a compaction, a wrapper's lazy chunk
 * import. That window is what the "machine idle" gate protected, and it is why
 * a machine that is never idle never updated.
 *
 * Here npm writes into a private prefix inside the same `node_modules` and the
 * live tree changes with two `rename(2)` calls, so at every instant the live
 * path holds one complete version. The bins are never unlinked: their relative
 * targets (`../lib/node_modules/very-happy-cli/bin/…`) are verified to exist in
 * the new tree before the swap. Old hashed `dist/` chunks are copied into the
 * new tree, so a wrapper started on the old bundle can still lazily import its
 * own chunks afterwards (the same rule as the Web keeping old hashed assets).
 *
 * Anything this path cannot prove safe is `deferred`: the controller then waits
 * for a genuinely idle machine and the classic in-place install.
 */
import { constants } from 'node:fs';
import { access, copyFile, lstat, readFile, readdir, readlink, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { projectPath } from '@/projectPath';
import { autoUpdateInstallArgs } from './autoUpdate';
import { parseExactVersion } from './cliUpdate';
import { globalPrefixForPackage } from './installLocation';
import { ownedCliLink, runNpm, type InstallOutcome } from './npmInstall';

export type StagedInstallOutcome = InstallOutcome | { deferred: string };

export interface StagedInstallDependencies {
    npm: typeof runNpm;
    fs: {
        lstat: typeof lstat; readlink: typeof readlink; readFile: typeof readFile; readdir: typeof readdir;
        copyFile: typeof copyFile; rename: typeof rename; rm: typeof rm; access: typeof access;
    };
    platform: string;
    runningPackageDir?: string;
    now: () => number;
}
const defaults: StagedInstallDependencies = {
    npm: runNpm, fs: { lstat, readlink, readFile, readdir, copyFile, rename, rm, access }, platform: process.platform,
    runningPackageDir: projectPath(), now: Date.now,
};

const MANAGED_BINS = ['very-happy', 'very-happy-mcp'] as const;

async function manifest(dir: string, deps: StagedInstallDependencies): Promise<{ name?: unknown; version?: unknown; bin?: unknown } | null> {
    try { return JSON.parse(await deps.fs.readFile(join(dir, 'package.json'), 'utf8')); } catch { return null; }
}

async function isFile(path: string, deps: StagedInstallDependencies): Promise<boolean> {
    const stat = await deps.fs.lstat(path).catch(() => null);
    return !!stat?.isFile();
}

/** `./bin/x.mjs` → `bin/x.mjs`; anything escaping the package is rejected. */
function packageRelative(path: string): string | null {
    const normalized = relative('/pkg', resolve('/pkg', path));
    return normalized && !normalized.startsWith('..') && !normalized.startsWith(sep) ? normalized : null;
}

/** Same tree, same layout, nothing npm would have to relink — or why not. */
async function binsUnchanged(stagedDir: string, liveDir: string, prefix: string, deps: StagedInstallDependencies): Promise<string | null> {
    const staged = await manifest(stagedDir, deps);
    const bin = staged?.bin;
    if (!bin || typeof bin !== 'object') return 'staged_bin_map_unreadable';
    const names = Object.keys(bin as Record<string, unknown>).sort();
    if (names.join(',') !== [...MANAGED_BINS].sort().join(',')) return 'staged_bin_map_changed';
    for (const name of MANAGED_BINS) {
        const target = packageRelative(String((bin as Record<string, unknown>)[name]));
        if (!target || !await isFile(join(stagedDir, target), deps)) return 'staged_bin_missing';
        const link = join(prefix, 'bin', name);
        const stat = await deps.fs.lstat(link).catch(() => null);
        if (!stat?.isSymbolicLink()) return 'live_bin_not_linked';
        const linkTarget = await deps.fs.readlink(link);
        if (!ownedCliLink(link, linkTarget, liveDir)) return 'live_bin_not_owned';
        if (relative(liveDir, resolve(dirname(link), linkTarget)) !== target) return 'staged_bin_map_changed';
    }
    return null;
}

/** Copies every old `dist/` file the new build does not have. Returns how many. */
async function keepOldChunks(liveDir: string, stagedDir: string, deps: StagedInstallDependencies): Promise<number> {
    const live = await deps.fs.readdir(join(liveDir, 'dist')).catch(() => [] as string[]);
    const staged = new Set(await deps.fs.readdir(join(stagedDir, 'dist')).catch(() => [] as string[]));
    let kept = 0;
    for (const name of live) {
        if (staged.has(name) || basename(name) !== name) continue;
        const from = join(liveDir, 'dist', name);
        if (!await isFile(from, deps)) continue;
        await deps.fs.copyFile(from, join(stagedDir, 'dist', name), constants.COPYFILE_EXCL);
        kept++;
    }
    return kept;
}

export interface StagedInstallReport { outcome: StagedInstallOutcome; keptChunks?: number }

export async function installCliStaged(version: string, deps: StagedInstallDependencies = defaults): Promise<StagedInstallReport> {
    const parsed = parseExactVersion(version);
    if (!parsed) throw new Error('Invalid exact CLI version');
    // Windows cannot rename a directory whose files are open by running processes.
    if (deps.platform === 'win32') return { outcome: { deferred: 'staged_install_unsupported' } };
    const liveDir = deps.runningPackageDir;
    const prefix = liveDir ? globalPrefixForPackage(liveDir) : null;
    if (!liveDir || !prefix) return { outcome: { manual: 'install_location_unverified' } };
    const liveStat = await deps.fs.lstat(liveDir).catch(() => null);
    const live = await manifest(liveDir, deps);
    if (!liveStat?.isDirectory() || liveStat.isSymbolicLink() || live?.name !== 'very-happy-cli' || typeof live.version !== 'string') {
        return { outcome: { manual: 'install_location_unverified' } };
    }
    const root = dirname(liveDir);
    try { await deps.fs.access(root, constants.W_OK); await deps.fs.access(liveDir, constants.W_OK); } catch {
        return { outcome: { manual: 'install_location_not_writable' } };
    }
    // Both paths are ours by construction (fixed prefix + exact semver); npm's
    // arg allowlist rejects anything else before it runs.
    const stagePrefix = join(root, `.very-happy-cli-stage-${parsed.exact}`);
    const stagedDir = join(stagePrefix, 'lib', 'node_modules', 'very-happy-cli');
    const retiredDir = join(root, `.very-happy-cli-retired-${live.version}-${deps.now()}`);
    const cleanup = async (path: string) => { await deps.fs.rm(path, { recursive: true, force: true }).catch(() => undefined); };
    await cleanup(stagePrefix);
    let swapped = false;
    try {
        const result = await deps.npm(autoUpdateInstallArgs(parsed.exact, stagePrefix));
        if (result.terminationConfirmed === false) return { outcome: 'blocked' };
        if (result.code !== 0) return { outcome: result.code };
        const staged = await manifest(stagedDir, deps);
        if (staged?.name !== 'very-happy-cli' || staged.version !== parsed.exact) return { outcome: { deferred: 'staged_package_unverified' } };
        const binProblem = await binsUnchanged(stagedDir, liveDir, prefix, deps);
        if (binProblem) return { outcome: { deferred: binProblem } };
        const keptChunks = await keepOldChunks(liveDir, stagedDir, deps);
        // The only moment the live path is absent: between these two renames.
        await deps.fs.rename(liveDir, retiredDir);
        try {
            await deps.fs.rename(stagedDir, liveDir);
        } catch {
            await deps.fs.rename(retiredDir, liveDir);
            return { outcome: { deferred: 'staged_swap_failed' } };
        }
        swapped = true;
        const installed = await manifest(liveDir, deps);
        return { outcome: installed?.version === parsed.exact ? 0 : { failed: 'installed_elsewhere' }, keptChunks };
    } finally {
        await cleanup(stagePrefix);
        // Running processes keep their open/mapped files after the unlink (POSIX).
        if (swapped) {
            await cleanup(retiredDir);
            // npm's hidden lockfile still lists the old tree; npm rebuilds it from disk.
            await cleanup(join(root, '.package-lock.json'));
        }
    }
}
