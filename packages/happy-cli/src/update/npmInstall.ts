import { spawn } from 'node:child_process';
import { lstat, readlink, unlink, rm, readFile, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { autoUpdateInstallArgs } from './autoUpdate';
import { parseExactVersion } from './cliUpdate';

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
    fs: Pick<typeof import('node:fs/promises'), 'lstat' | 'readlink' | 'unlink' | 'rm' | 'readFile' | 'symlink'>;
    platform: string;
}
const defaults: InstallDependencies = { npm: runNpm, fs: { lstat, readlink, unlink, rm, readFile, symlink }, platform: process.platform };

/** Never infer ownership from a substring in a symlink target. */
export function ownedCliLink(link: string, target: string, packageDir: string): boolean {
    const resolved = resolve(dirname(link), target);
    return resolved.startsWith(join(packageDir, 'bin') + sep);
}

/** One bounded repair inside one logical attempt, with no shell or arbitrary path removal. */
export async function installCliSafely(version: string, deps: InstallDependencies = defaults): Promise<number | null | 'blocked'> {
    const parsed = parseExactVersion(version);
    if (!parsed) throw new Error('Invalid exact CLI version');
    const args = autoUpdateInstallArgs(parsed.exact);
    // Windows npm uses shims, not the Unix symlinks addressed by this repair.
    if (deps.platform === 'win32') {
        const result = await deps.npm(args);
        return result.terminationConfirmed === false ? 'blocked' : result.code;
    }
    const rootResult = await deps.npm(['root', '-g']);
    if (rootResult.terminationConfirmed === false) return 'blocked';
    const prefixResult = await deps.npm(['prefix', '-g']);
    if (prefixResult.terminationConfirmed === false) return 'blocked';
    const root = rootResult.stdout.trim();
    const prefix = prefixResult.stdout.trim();
    if (rootResult.code !== 0 || prefixResult.code !== 0 || !isAbsolute(root) || !isAbsolute(prefix)
        || basename(root) !== 'node_modules' || resolve(prefix) === '/' || root.includes('\n') || prefix.includes('\n')) {
        throw new Error('Cannot verify global npm paths; use manual install');
    }
    if (resolve(root) !== resolve(prefix, 'lib/node_modules')) throw new Error('Unexpected npm root/prefix relationship');
    const packageDir = join(root, 'very-happy-cli');
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
        if (first.code === 0 || first.code === null) return first.code;
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
        return result;
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
