import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyIntoWorktree, expandPattern, isInside, linkIntoWorktree, linkTypeCandidates, COPY_MAX_FILES } from './materialize';

let base: string;
let repo: string;
let tree: string;
let outside: string;

beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'vh-wt-mat-')));
    repo = join(base, 'repo'); tree = join(base, 'tree'); outside = join(base, 'outside');
    for (const dir of [repo, tree, outside]) mkdirSync(dir);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('B-585 copy into worktree', () => {
    it('copies matching untracked files, never overwrites, skips dirs', async () => {
        writeFileSync(join(repo, '.env'), 'A=1');
        writeFileSync(join(repo, '.env.local'), 'B=2');
        mkdirSync(join(repo, '.envdir'));
        writeFileSync(join(tree, '.env.local'), 'tracked');
        mkdirSync(join(repo, 'apps/web'), { recursive: true });
        writeFileSync(join(repo, 'apps/web/.env'), 'C=3');
        const result = await copyIntoWorktree(repo, tree, ['.env*', 'apps/web/.env']);
        expect(result.copied.sort()).toEqual(['.env', 'apps/web/.env']);
        expect(readFileSync(join(tree, '.env.local'), 'utf8')).toBe('tracked');
        expect(result.skipped).toEqual(expect.arrayContaining([{ path: '.env.local', reason: 'exists' }, { path: '.envdir', reason: 'not-a-file' }]));
        expect(readFileSync(join(tree, 'apps/web/.env'), 'utf8')).toBe('C=3');
    });

    it('refuses a source symlink that resolves outside the repo', async () => {
        writeFileSync(join(outside, 'id_rsa'), 'secret');
        symlinkSync(join(outside, 'id_rsa'), join(repo, '.env'));
        const result = await copyIntoWorktree(repo, tree, ['.env']);
        expect(result.copied).toEqual([]);
        expect(result.skipped).toEqual([{ path: '.env', reason: 'outside-repo' }]);
        expect(existsSync(join(tree, '.env'))).toBe(false);
    });

    it('allows an in-repo symlink (copies the target bytes)', async () => {
        writeFileSync(join(repo, 'shared.env'), 'S=1');
        symlinkSync(join(repo, 'shared.env'), join(repo, '.env'));
        const result = await copyIntoWorktree(repo, tree, ['.env']);
        expect(result.copied).toEqual(['.env']);
        expect(lstatSync(join(tree, '.env')).isSymbolicLink()).toBe(false);
    });

    it('refuses a destination whose parent is a tracked symlink out of the worktree', async () => {
        mkdirSync(join(repo, 'config'));
        writeFileSync(join(repo, 'config/.env'), 'X=1');
        symlinkSync(outside, join(tree, 'config'));
        const result = await copyIntoWorktree(repo, tree, ['config/.env']);
        expect(result.copied).toEqual([]);
        expect(result.skipped[0]).toMatchObject({ path: 'config/.env', reason: 'outside-worktree' });
        expect(existsSync(join(outside, '.env'))).toBe(false);
    });

    it('rejects unsafe patterns and caps the file count', async () => {
        writeFileSync(join(base, 'secret'), 'x');
        expect((await copyIntoWorktree(repo, tree, ['../secret'])).skipped).toEqual([{ path: '../secret', reason: 'unsafe-pattern' }]);
        mkdirSync(join(repo, 'many'));
        for (let i = 0; i < COPY_MAX_FILES + 3; i++) writeFileSync(join(repo, 'many', `f${String(i).padStart(3, '0')}.env`), 'x');
        const result = await copyIntoWorktree(repo, tree, ['many/*.env']);
        expect(result.copied).toHaveLength(COPY_MAX_FILES);
        expect(result.skipped.filter((s) => s.reason === 'file-limit')).toHaveLength(3);
    });

    it('never matches dotfiles with a non-dot glob, nor .git', async () => {
        writeFileSync(join(repo, '.hidden'), 'x');
        writeFileSync(join(repo, 'visible'), 'x');
        mkdirSync(join(repo, '.git'));
        expect(await expandPattern(repo, '*')).toEqual(['visible']);
    });
});

describe('B-585 link into worktree', () => {
    it('links a real in-repo directory, skips missing / symlinked / existing', async () => {
        mkdirSync(join(repo, 'node_modules'));
        symlinkSync(outside, join(repo, 'vendor'));
        mkdirSync(join(repo, 'dist')); mkdirSync(join(tree, 'dist'));
        const result = await linkIntoWorktree(repo, tree, ['node_modules', 'vendor', 'dist', 'missing']);
        expect(result.linked).toEqual(['node_modules']);
        expect(lstatSync(join(tree, 'node_modules')).isSymbolicLink()).toBe(true);
        expect(result.skipped.map((s) => s.reason)).toEqual(['not-a-directory', 'exists', 'missing']);
    });

    it('prefers a junction on Windows', () => {
        expect(linkTypeCandidates('win32')).toEqual(['junction', 'dir']);
        expect(linkTypeCandidates('linux')).toEqual(['dir']);
    });

    it('isInside is segment-aware', () => {
        expect(isInside('/a/repo', '/a/repo/x')).toBe(true);
        expect(isInside('/a/repo', '/a/repo')).toBe(true);
        expect(isInside('/a/repo', '/a/repo-other/x')).toBe(false);
        expect(isInside('/a/repo', '/a')).toBe(false);
    });
});
