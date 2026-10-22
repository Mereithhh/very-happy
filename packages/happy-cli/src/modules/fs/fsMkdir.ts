/**
 * B-755 `fs-mkdir`: create a new working folder for a project ("新建工作目录").
 *
 * Narrower than the rest of the file RPCs on purpose — it writes:
 *  - the raw input may not contain a `..` segment (`invalid-path`);
 *  - the folder must lie strictly inside the daemon user's home, and so must
 *    the real path of its closest existing ancestor, so a symlink cannot carry
 *    it out of home (`outside-home`);
 *  - an existing path is never reused or changed (`exists`) — the web offers
 *    to pick it instead;
 *  - no privilege change: `mkdir -p` as the daemon user, nothing else.
 * `gitInit` runs `git init` inside the new folder; a git failure keeps the
 * folder and reports `git: false`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';

export const FS_MKDIR_CAPABILITY_VERSION = 1;

export interface FsMkdirResponse {
    path: string;
    created: true;
    git: boolean;
}

const within = (root: string, path: string) => {
    const rel = relative(root, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** The absolute folder `input` names, or a stable error code. Pure. */
export function mkdirTarget(input: unknown, homeDir: string): string {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new Error('invalid-path');
    const raw = input.trim();
    if (raw.split(/[\\/]+/).includes('..')) throw new Error('invalid-path');
    const path = raw === '~' ? homeDir : raw.startsWith('~/') ? join(homeDir, raw.slice(2)) : raw;
    if (!isAbsolute(path)) throw new Error('invalid-path');
    const normalized = join(path, '.').replace(new RegExp(`\\${sep}+$`), '') || sep;
    if (!within(homeDir, normalized)) throw new Error('outside-home');
    return normalized;
}

async function closestExisting(path: string): Promise<string> {
    for (let current = path; ; current = dirname(current)) {
        try { await stat(current); return current; } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) throw error;
        }
    }
}

export async function fsMkdir(
    input: unknown,
    options: { gitInit?: boolean } = {},
    homeDir: string = homedir(),
    gitInit: (directory: string) => Promise<unknown> = directory => promisify(execFile)('git', ['init', '-q', directory], { timeout: 20_000 }),
): Promise<FsMkdirResponse> {
    const path = mkdirTarget(input, homeDir);
    const realHome = await realpath(homeDir).catch(() => homeDir);
    try {
        const anchor = await closestExisting(path);
        if (anchor === path) throw new Error('exists');
        const realAnchor = await realpath(anchor);
        if (realAnchor !== realHome && !within(realHome, realAnchor)) throw new Error('outside-home');
        if (!(await stat(anchor)).isDirectory()) throw new Error('not-a-directory');
        await mkdir(path, { recursive: true });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') throw new Error('permission-denied');
        if (code === 'EEXIST') throw new Error('exists');
        if (code === 'ENOTDIR') throw new Error('not-a-directory');
        throw error instanceof Error ? error : new Error('fs-failed');
    }
    const git = options.gitInit === true ? await gitInit(path).then(() => true, () => false) : false;
    return { path, created: true, git };
}
