import { spawn } from 'node:child_process';
import { access, constants, lstat, readlink, unlink, rm, readFile, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { projectPath } from '@/projectPath';
import { autoUpdateInstallArgs } from './autoUpdate';
import { parseExactVersion } from './cliUpdate';
import { globalPrefixForPackage } from './installLocation';

export type NpmResult = { code: number | null; stdout: string; stderr?: string; terminationConfirmed?: boolean };
export interface NpmProcessDependencies {
    spawn: typeof spawn;
    killGroup: (pid: number) => void;
    platform: string;
    timeoutMs: number;
    terminationGraceMs: number;
}
const processDefaults: NpmProcessDependencies = {
    spawn, killGroup: (pid) => { process.kill(-pid, 'SIGKILL'); }, platform: process.platform,
    timeoutMs: 10 * 60_000, terminationGraceMs: 5_000,
};
export const runNpmProcess = (args: string[], deps: NpmProcessDependencies = processDefaults): Promise<NpmResult> => new Promise((resolveResult) => {
    let stdout = ''; let stderr = ''; let timedOut = false; let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let treeKilled = false;
    const done = (result: NpmResult) => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(grace); resolveResult(result);
    };
    if (args.some((arg) => !/^[A-Za-z0-9@=.,+/_-]+$/.test(arg))) { done({code: null, stdout, stderr: 'Invalid npm argument'}); return; }
    const child = deps.platform === 'win32'
        ? deps.spawn('cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], { stdio: ['ignore', 'pipe', 'pipe'] })
        : deps.spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    timer = setTimeout(() => {
        timedOut = true;
        grace = setTimeout(() => done({code: null, stdout, stderr, terminationConfirmed: false}), deps.terminationGraceMs);
        if (!child.pid) return;
        if (deps.platform === 'win32') {
            // cmd.exe owns npm.cmd -> node -> install hooks; killing only cmd leaves npm writing.
            const killer = deps.spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            killer.on('error', () => undefined);
            killer.on('close', (code) => { treeKilled = code === 0; });
        } else {
            try { deps.killGroup(child.pid); treeKilled = true; } catch { /* uncertain: keep the update fence closed */ }
        }
    }, deps.timeoutMs);
    child.stdout?.on('data', (data) => { stdout = (stdout + String(data)).slice(-8192); });
    child.stderr?.on('data', (data) => { stderr = (stderr + String(data)).slice(-8192); });
    child.on('error', () => done({code: null, stdout, stderr, terminationConfirmed: !timedOut}));
    child.on('close', (code) => done({code: timedOut ? null : code, stdout, stderr, terminationConfirmed: !timedOut || treeKilled}));
});
export const runNpm = (args: string[]) => runNpmProcess(args);

export interface InstallDependencies {
    npm: typeof runNpm;
    fs: Pick<typeof import('node:fs/promises'), 'lstat' | 'readlink' | 'unlink' | 'rm' | 'readFile' | 'symlink'> & { access?: typeof access };
    platform: string;
    /**
     * B-489: the package this daemon runs from. When set, the install targets its
     * prefix and success means THIS package now carries the target version. Unset
     * keeps npm's default prefix (used by callers that are not the daemon).
     */
    runningPackageDir?: string;
}
const defaults: InstallDependencies = {
    npm: runNpm, fs: { lstat, readlink, unlink, rm, readFile, symlink, access }, platform: process.platform,
    runningPackageDir: projectPath(),
};

/**
 * B-489: outcomes beyond an npm exit code. `manual` = we will not install
 * because we cannot install into the running copy; `failed` = npm said yes but
 * the running copy did not change. Both are reported to the Web, never as
 * `installed`.
 */
export type InstallLocationProblem = 'install_location_unverified' | 'install_location_not_writable';
export type InstallOutcome = number | null | 'blocked' | { manual: InstallLocationProblem } | { failed: 'installed_elsewhere' };

async function runningVersion(deps: InstallDependencies): Promise<string | null> {
    if (!deps.runningPackageDir) return null;
    try {
        const manifest = JSON.parse(await deps.fs.readFile(join(deps.runningPackageDir, 'package.json'), 'utf8'));
        return manifest?.name === 'very-happy-cli' && typeof manifest.version === 'string' ? manifest.version : null;
    } catch { return null; }
}

/** After npm exits 0: did the package this daemon runs from actually become `version`? */
async function verifyRunningCopy(code: number | null, version: string, deps: InstallDependencies): Promise<InstallOutcome> {
    if (code !== 0 || !deps.runningPackageDir) return code;
    return await runningVersion(deps) === version ? 0 : { failed: 'installed_elsewhere' };
}

async function writable(path: string, deps: InstallDependencies): Promise<boolean> {
    if (!deps.fs.access) return true;
    try { await deps.fs.access(path, constants.W_OK); return true; } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
}

/** Never infer ownership from a substring in a symlink target. */
export function ownedCliLink(link: string, target: string, packageDir: string): boolean {
    const resolved = resolve(dirname(link), target);
    return resolved.startsWith(join(packageDir, 'bin') + sep);
}

/** One bounded repair inside one logical attempt, with no shell or arbitrary path removal. */
export async function installCliSafely(version: string, deps: InstallDependencies = defaults): Promise<InstallOutcome> {
    const parsed = parseExactVersion(version);
    if (!parsed) throw new Error('Invalid exact CLI version');
    // Windows npm uses shims, not the Unix symlinks addressed by this repair,
    // and a different global layout; keep npm's prefix but still verify the result.
    if (deps.platform === 'win32') {
        const result = await deps.npm(autoUpdateInstallArgs(parsed.exact));
        return result.terminationConfirmed === false ? 'blocked' : verifyRunningCopy(result.code, parsed.exact, deps);
    }
    // B-489: install into the tree this daemon runs from, not npm's default.
    let pinnedPrefix: string | undefined;
    if (deps.runningPackageDir) {
        const running = globalPrefixForPackage(deps.runningPackageDir);
        const runningStat = running ? await deps.fs.lstat(deps.runningPackageDir).catch(() => null) : null;
        if (!running || !runningStat?.isDirectory() || runningStat.isSymbolicLink() || !await runningVersion(deps)) {
            return { manual: 'install_location_unverified' };
        }
        for (const path of [dirname(deps.runningPackageDir), deps.runningPackageDir, join(running, 'bin')]) {
            if (!await writable(path, deps)) return { manual: 'install_location_not_writable' };
        }
        pinnedPrefix = running;
    }
    const prefixArgs = pinnedPrefix ? [`--prefix=${pinnedPrefix}`] : [];
    const args = autoUpdateInstallArgs(parsed.exact, pinnedPrefix);
    const rootResult = await deps.npm(['root', '-g', ...prefixArgs]);
    if (rootResult.terminationConfirmed === false) return 'blocked';
    const prefixResult = await deps.npm(['prefix', '-g', ...prefixArgs]);
    if (prefixResult.terminationConfirmed === false) return 'blocked';
    const root = rootResult.stdout.trim();
    const prefix = prefixResult.stdout.trim();
    if (rootResult.code !== 0 || prefixResult.code !== 0 || !isAbsolute(root) || !isAbsolute(prefix)
        || basename(root) !== 'node_modules' || resolve(prefix) === '/' || root.includes('\n') || prefix.includes('\n')) {
        throw new Error('Cannot verify global npm paths; use manual install');
    }
    if (resolve(root) !== resolve(prefix, 'lib/node_modules')) throw new Error('Unexpected npm root/prefix relationship');
    const packageDir = join(root, 'very-happy-cli');
    if (deps.runningPackageDir && resolve(packageDir) !== resolve(deps.runningPackageDir)) {
        return { manual: 'install_location_unverified' };
    }
    const packageStat = await deps.fs.lstat(packageDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
    });
    if (packageStat && (!packageStat.isDirectory() || packageStat.isSymbolicLink())) {
        throw new Error('Refusing to modify a linked or non-directory CLI package');
    }
    if (packageStat) {
        const manifest = JSON.parse(await deps.fs.readFile(join(packageDir, 'package.json'), 'utf8'));
        if (manifest.name !== 'very-happy-cli') throw new Error('Cannot verify installed CLI package identity');
    }
    const ownLinks: Array<{link: string; target: string}> = [];
    for (const name of ['very-happy', 'very-happy-mcp']) {
        const link = join(prefix, 'bin', name);
        const stat = await deps.fs.lstat(link).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (!stat) continue;
        if (!stat.isSymbolicLink() || !ownedCliLink(link, await deps.fs.readlink(link), packageDir)) {
            throw new Error('CLI bin is owned by another installation; use manual recovery');
        }
        ownLinks.push({link, target: await deps.fs.readlink(link)});
    }
    // Validate every path before the first mutation.
    let result: number | null = null;
    let safeToRestore = true;
    try {
        for (const {link} of ownLinks) await deps.fs.unlink(link);
        const first = await deps.npm(args);
        if (first.terminationConfirmed === false) { safeToRestore = false; return 'blocked'; }
        result = first.code;
        if (first.code === 0 || first.code === null) return await verifyRunningCopy(first.code, parsed.exact, deps);
        // A network/registry failure is not evidence of a damaged tree.
        if (!/\b(?:EEXIST|ENOTEMPTY)\b/.test(first.stderr ?? '')) return first.code;
        const failedStat = await deps.fs.lstat(packageDir).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (failedStat && (!packageStat || !failedStat.isDirectory() || failedStat.isSymbolicLink())) {
            throw new Error('Refusing to remove an unverified CLI package');
        }
        if (failedStat) await deps.fs.rm(packageDir, { recursive: true, force: true });
        const second = await deps.npm(args);
        result = second.code;
        if (second.terminationConfirmed === false) { safeToRestore = false; return 'blocked'; }
        return await verifyRunningCopy(result, parsed.exact, deps);
    } finally {
        if (result !== 0 && safeToRestore) {
            for (const {link, target} of ownLinks) {
                // Restore only our missing old link, only while its entry still exists.
                const entry = await deps.fs.lstat(resolve(dirname(link), target)).catch(() => null);
                const current = await deps.fs.lstat(link).catch(() => null);
                if (entry?.isFile() && !current) await deps.fs.symlink(target, link).catch(() => undefined);
            }
        }
    }
}
