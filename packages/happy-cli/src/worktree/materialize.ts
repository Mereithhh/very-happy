/**
 * B-585 copy / link materialization into a fresh worktree.
 *
 * Containment is checked on REAL paths at both ends: a source that is (or sits
 * behind) a symlink must resolve inside the source checkout, and the
 * destination's parent must resolve inside the worktree — a tracked symlinked
 * directory in the new checkout must not redirect a write outside it.
 */
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, stat, symlink } from 'node:fs/promises';
import { dirname, join, relative, sep, isAbsolute } from 'node:path';
import { globSegmentToRegExp, hasGlob, isSafeRelativePattern } from './config';

export const COPY_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const COPY_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const COPY_MAX_FILES = 200;
const GLOB_MAX_MATCHES = 1000;

export interface SkippedPath { path: string; reason: string }
export interface CopyResult { copied: string[]; skipped: SkippedPath[] }
export interface LinkResult { linked: string[]; skipped: SkippedPath[] }

/** `child` equals or lies under `parent` (both already real/absolute). */
export function isInside(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..');
}

/** Expand one pattern under `root` into repo-relative `/` paths (no `**`). */
export async function expandPattern(root: string, pattern: string): Promise<string[]> {
    if (!isSafeRelativePattern(pattern)) return [];
    let current: string[] = [''];
    for (const segment of pattern.split('/')) {
        const next: string[] = [];
        for (const base of current) {
            if (!hasGlob(segment)) { next.push(base ? `${base}/${segment}` : segment); continue; }
            const regex = globSegmentToRegExp(segment);
            let names: string[] = [];
            try { names = await readdir(join(root, ...base.split('/').filter(Boolean))); } catch { continue; }
            for (const name of names.sort()) {
                // A leading-dot name only matches a pattern that spells the dot (gitignore-like).
                if (name.startsWith('.') && !segment.startsWith('.')) continue;
                if (name === '.git') continue;
                if (regex.test(name)) next.push(base ? `${base}/${name}` : name);
                if (next.length >= GLOB_MAX_MATCHES) break;
            }
        }
        current = next;
        if (current.length === 0) break;
    }
    return current.filter(Boolean);
}

async function realOrNull(path: string): Promise<string | null> {
    try { return await realpath(path); } catch { return null; }
}

/** Nearest existing ancestor's real path (the destination dir may not exist yet). */
async function realExistingAncestor(path: string): Promise<string | null> {
    let current = path;
    for (let i = 0; i < 64; i++) {
        const real = await realOrNull(current);
        if (real) return real;
        const parent = dirname(current);
        if (parent === current) return null;
        current = parent;
    }
    return null;
}

export async function copyIntoWorktree(sourceRoot: string, worktree: string, patterns: string[]): Promise<CopyResult> {
    const copied: string[] = [];
    const skipped: SkippedPath[] = [];
    const realSource = await realpath(sourceRoot);
    const realWorktree = await realpath(worktree);
    let total = 0;
    const seen = new Set<string>();
    for (const pattern of patterns) {
        if (!isSafeRelativePattern(pattern)) { skipped.push({ path: pattern, reason: 'unsafe-pattern' }); continue; }
        for (const rel of await expandPattern(realSource, pattern)) {
            if (seen.has(rel)) continue;
            seen.add(rel);
            if (rel.split('/').includes('.git')) { skipped.push({ path: rel, reason: 'git-internal' }); continue; }
            const source = join(realSource, ...rel.split('/'));
            let info;
            try { info = await lstat(source); } catch { continue; }
            const resolved = await realOrNull(source);
            if (!resolved || !isInside(realSource, resolved)) { skipped.push({ path: rel, reason: 'outside-repo' }); continue; }
            const target = info.isSymbolicLink() ? await stat(resolved).catch(() => null) : info;
            if (!target || !target.isFile()) { skipped.push({ path: rel, reason: 'not-a-file' }); continue; }
            if (target.size > COPY_MAX_FILE_BYTES) { skipped.push({ path: rel, reason: 'too-large' }); continue; }
            if (copied.length >= COPY_MAX_FILES) { skipped.push({ path: rel, reason: 'file-limit' }); continue; }
            if (total + target.size > COPY_MAX_TOTAL_BYTES) { skipped.push({ path: rel, reason: 'total-limit' }); continue; }
            const destination = join(realWorktree, ...rel.split('/'));
            // Tracked files are already checked out; never overwrite anything.
            if (await lstat(destination).then(() => true, () => false)) { skipped.push({ path: rel, reason: 'exists' }); continue; }
            const parentReal = await realExistingAncestor(dirname(destination));
            if (!parentReal || !isInside(realWorktree, parentReal)) { skipped.push({ path: rel, reason: 'outside-worktree' }); continue; }
            try {
                await mkdir(dirname(destination), { recursive: true });
                // Re-check after mkdir: the created chain must still resolve inside.
                const madeReal = await realpath(dirname(destination));
                if (!isInside(realWorktree, madeReal)) { skipped.push({ path: rel, reason: 'outside-worktree' }); continue; }
                await copyFile(resolved, destination, fsConstants.COPYFILE_EXCL);
                copied.push(rel);
                total += target.size;
            } catch (error) {
                skipped.push({ path: rel, reason: `copy-failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) });
            }
        }
    }
    return { copied, skipped };
}

/** POSIX: a dir symlink. Windows: a junction first (no privilege needed), then a dir symlink. */
export function linkTypeCandidates(platform: NodeJS.Platform): Array<'junction' | 'dir'> {
    return platform === 'win32' ? ['junction', 'dir'] : ['dir'];
}

export async function linkIntoWorktree(sourceRoot: string, worktree: string, entries: string[], platform: NodeJS.Platform = process.platform): Promise<LinkResult> {
    const linked: string[] = [];
    const skipped: SkippedPath[] = [];
    const realSource = await realpath(sourceRoot);
    const realWorktree = await realpath(worktree);
    for (const rel of entries) {
        if (!isSafeRelativePattern(rel) || hasGlob(rel)) { skipped.push({ path: rel, reason: 'unsafe-pattern' }); continue; }
        if (rel.split('/').includes('.git')) { skipped.push({ path: rel, reason: 'git-internal' }); continue; }
        try {
            const source = join(realSource, ...rel.split('/'));
            let info;
            try { info = await lstat(source); } catch { skipped.push({ path: rel, reason: 'missing' }); continue; }
            // The final segment must be a real directory, and the WHOLE path must
            // resolve inside the checkout: an intermediate symlinked segment
            // (`a -> ../outside`, entry `a/b`) would otherwise escape.
            if (info.isSymbolicLink() || !info.isDirectory()) { skipped.push({ path: rel, reason: 'not-a-directory' }); continue; }
            const resolved = await realOrNull(source);
            if (!resolved || !isInside(realSource, resolved) || resolved === realSource) { skipped.push({ path: rel, reason: 'outside-repo' }); continue; }
            const destination = join(realWorktree, ...rel.split('/'));
            if (await lstat(destination).then(() => true, () => false)) { skipped.push({ path: rel, reason: 'exists' }); continue; }
            const parentReal = await realExistingAncestor(dirname(destination));
            if (!parentReal || !isInside(realWorktree, parentReal)) { skipped.push({ path: rel, reason: 'outside-worktree' }); continue; }
            await mkdir(dirname(destination), { recursive: true });
            const madeReal = await realpath(dirname(destination));
            if (!isInside(realWorktree, madeReal)) { skipped.push({ path: rel, reason: 'outside-worktree' }); continue; }
            let done = false;
            let lastError = '';
            for (const type of linkTypeCandidates(platform)) {
                // Link to the REAL path that was checked, never the symlinked spelling.
                try { await symlink(resolved, destination, type); done = true; break; }
                catch (error) { lastError = error instanceof Error ? error.message : String(error); }
            }
            if (done) linked.push(rel);
            else skipped.push({ path: rel, reason: `link-failed: ${lastError}`.slice(0, 200) });
        } catch (error) {
            // Never let one entry abort initialization (the worktree already exists).
            skipped.push({ path: rel, reason: `link-failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) });
        }
    }
    return { linked, skipped };
}
