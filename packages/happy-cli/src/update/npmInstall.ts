import { spawn } from 'node:child_process';
import { lstat, readlink, unlink, rm, readFile, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { autoUpdateInstallArgs } from './autoUpdate';
import { parseExactVersion } from './cliUpdate';

export type NpmResult = { code: number | null; stdout: string; stderr?: string };
export const runNpm = (args: string[]): Promise<NpmResult> => new Promise((done) => {
    let stdout = ''; let stderr = ''; let timedOut = false;
    if (args.some((arg) => !/^[A-Za-z0-9@=.,+/_-]+$/.test(arg))) { done({code: null, stdout, stderr: 'Invalid npm argument'}); return; }
    const child = process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], { stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10 * 60_000);
    child.stdout.on('data', (data) => { stdout = (stdout + String(data)).slice(-8192); });
    child.stderr.on('data', (data) => { stderr = (stderr + String(data)).slice(-8192); });
    child.on('error', () => { clearTimeout(timer); done({code: null, stdout, stderr}); });
    child.on('close', (code) => { clearTimeout(timer); done({code: timedOut ? null : code, stdout, stderr}); });
});

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
export async function installCliSafely(version: string, deps: InstallDependencies = defaults): Promise<number | null> {
    const parsed = parseExactVersion(version);
    if (!parsed) throw new Error('Invalid exact CLI version');
    const args = autoUpdateInstallArgs(parsed.exact);
    // Windows npm uses shims, not the Unix symlinks addressed by this repair.
    if (deps.platform === 'win32') return (await deps.npm(args)).code;
    const rootResult = await deps.npm(['root', '-g']);
    const prefixResult = await deps.npm(['prefix', '-g']);
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
    try {
        for (const {link} of ownLinks) await deps.fs.unlink(link);
        const first = await deps.npm(args);
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
        result = (await deps.npm(args)).code;
        return result;
    } finally {
        if (result !== 0) {
            for (const {link, target} of ownLinks) {
                // Restore only our missing old link, only while its entry still exists.
                const entry = await deps.fs.lstat(resolve(dirname(link), target)).catch(() => null);
                const current = await deps.fs.lstat(link).catch(() => null);
                if (entry?.isFile() && !current) await deps.fs.symlink(target, link).catch(() => undefined);
            }
        }
    }
}
