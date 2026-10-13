import { describe, expect, it } from 'vitest';
import type { GitFileStatus, GitStatusFiles } from '@/sync/gitStatusFiles';
import { gitDiffCommand } from '../diffComments/gitDiff';
import {
    DELETED_CID,
    parseWorktreeIds,
    worktreeIdBatches,
    WORKTREE_ID_BATCH,
    diffRowsHash,
    estimateSectionBodyPx,
    isViewedCurrent,
    parseViewedMap,
    pruneViewed,
    reviewFileList,
    REVIEW_VIEWED_MAX_PER_SESSION,
} from './reviewAllModel';

const f = (fullPath: string, status: GitFileStatus['status'], linesAdded: number, linesRemoved: number, isStaged = false): GitFileStatus => ({
    fileName: fullPath.split('/').pop()!, filePath: '', fullPath, status, isStaged, linesAdded, linesRemoved,
});
const status = (unstaged: GitFileStatus[], staged: GitFileStatus[] = []): GitStatusFiles => ({
    unstagedFiles: unstaged, stagedFiles: staged, branch: 'main', totalStaged: staged.length, totalUnstaged: unstaged.length,
});

describe('reviewFileList', () => {
    it('dedupes staged+unstaged like the Changes list and sums their numstat', () => {
        const list = reviewFileList(status([f('a.ts', 'modified', 2, 1), f('n.md', 'untracked', 0, 0)], [f('a.ts', 'modified', 3, 0, true)]));
        expect(list.map((x) => [x.path, x.added, x.removed, x.sig])).toEqual([
            ['a.ts', 5, 1, 'modified:5:1'], ['n.md', 0, 0, 'untracked:0:0'],
        ]);
        expect(reviewFileList(null)).toEqual([]);
    });
});

describe('viewed marks', () => {
    const rows = [{ type: 'add' as const, text: 'x', oldNo: null, newNo: 1 }];
    it('hold while the signature (and, once loaded, the content hash) is unchanged', () => {
        const hash = diffRowsHash(rows);
        const entry = { sig: 'modified:1:0', hash, at: 1 };
        expect(isViewedCurrent(entry, 'modified:1:0', null)).toBe(true);
        expect(isViewedCurrent(entry, 'modified:1:0', hash)).toBe(true);
        expect(isViewedCurrent(entry, 'modified:2:0', hash)).toBe(false);
        expect(isViewedCurrent(entry, 'modified:1:0', diffRowsHash([{ ...rows[0], text: 'y' }]))).toBe(false);
        expect(isViewedCurrent(undefined, 'modified:1:0', null)).toBe(false);
        // marked while collapsed (no hash): only the signature can be checked
        expect(isViewedCurrent({ sig: 'modified:1:0', hash: null, at: 1 }, 'modified:1:0', hash)).toBe(true);
    });
    it('the hash distinguishes an added line from a removed one with the same text', () => {
        expect(diffRowsHash(rows)).not.toBe(diffRowsHash([{ type: 'del', text: 'x', oldNo: 1, newNo: null }]));
    });
    it('parses defensively and keeps the newest N', () => {
        expect(parseViewedMap('nope')).toEqual({});
        expect(parseViewedMap('[]')).toEqual({});
        expect(parseViewedMap(JSON.stringify({ a: { sig: 's', hash: null, at: 1 }, b: { sig: 1 }, '': { sig: 's', hash: null, at: 2 } })))
            .toEqual({ a: { sig: 's', hash: null, at: 1 } });
        const many = Object.fromEntries(Array.from({ length: REVIEW_VIEWED_MAX_PER_SESSION + 5 }, (_, i) => [`p${i}`, { sig: 's', hash: 'h', at: i }]));
        const parsed = parseViewedMap(JSON.stringify(many));
        expect(Object.keys(parsed)).toHaveLength(REVIEW_VIEWED_MAX_PER_SESSION);
        expect(parsed.p0).toBeUndefined();
    });
    it('prunes marks for files that are no longer changed', () => {
        const map = { a: { sig: 's', hash: null, at: 1 }, gone: { sig: 's', hash: null, at: 1 } };
        expect(Object.keys(pruneViewed(map, reviewFileList(status([f('a', 'modified', 1, 0)]))))).toEqual(['a']);
    });
});

describe('layout + command', () => {
    it('placeholder height is bounded', () => {
        expect(estimateSectionBodyPx({ added: 0, removed: 0 })).toBe(160);
        expect(estimateSectionBodyPx({ added: 10_000, removed: 0 })).toBe(600);
    });
    it('ignore-whitespace adds -w to tracked and untracked diffs only when asked', () => {
        expect(gitDiffCommand('a.ts', { untracked: false, flavor: 'posix', ignoreWhitespace: true }))
            .toEqual({ ok: true, command: "git -c core.quotepath=false diff --no-color --no-ext-diff -w HEAD -- ':(literal)a.ts'" });
        expect(gitDiffCommand('n.md', { untracked: true, flavor: 'posix', ignoreWhitespace: true }))
            .toEqual({ ok: true, command: "git -c core.quotepath=false diff --no-color --no-ext-diff -w --no-index -- /dev/null 'n.md'" });
        expect(gitDiffCommand('a.ts', { untracked: false, flavor: 'posix' }))
            .toEqual({ ok: true, command: "git -c core.quotepath=false diff --no-color --no-ext-diff HEAD -- ':(literal)a.ts'" });
    });
});

describe('working-tree content ids (review 中3)', () => {
    const H1 = 'a'.repeat(40);
    const H2 = 'b'.repeat(40);
    it('a same-size edit invalidates the mark through the content id', () => {
        const entry = { sig: 'modified:1:1', hash: null, at: 1, cid: H1 };
        expect(isViewedCurrent(entry, 'modified:1:1', null, H1)).toBe(true);
        expect(isViewedCurrent(entry, 'modified:1:1', null, H2)).toBe(false);
        expect(isViewedCurrent(entry, 'modified:1:1', null, undefined)).toBe(true);   // ids not known yet
        expect(isViewedCurrent({ sig: 'modified:1:1', hash: null, at: 1 }, 'modified:1:1', null, H2)).toBe(true); // old mark, no cid
        expect(parseViewedMap(JSON.stringify({ a: { sig: 's', hash: null, at: 1, cid: 7 } }))).toEqual({});
    });
    it('batches hash-object over quoted FILE NAMES (no :(literal) — not a pathspec), skipping deletions', () => {
        const files = [
            { path: "it's.ts", status: 'modified' as const }, { path: 'gone.ts', status: 'deleted' as const },
            { path: '-dash.md', status: 'untracked' as const }, { path: 'bad\nname', status: 'modified' as const },
        ];
        expect(worktreeIdBatches(files, 'posix')).toEqual([{ command: "git hash-object -- 'it'\\''s.ts' '-dash.md'", paths: ["it's.ts", '-dash.md'] }]);
        expect(worktreeIdBatches([{ path: 'a&b.ts', status: 'modified' }], 'cmd')[0].command).toBe('git hash-object -- "a&b.ts"');
        const many = Array.from({ length: WORKTREE_ID_BATCH + 1 }, (_, i) => ({ path: `f${i}`, status: 'modified' as const }));
        expect(worktreeIdBatches(many, 'posix').map((b) => b.paths.length)).toEqual([WORKTREE_ID_BATCH, 1]);
        expect(DELETED_CID).toBe('deleted');
    });
    it('trusts the output only when it lines up one id per path', () => {
        expect(parseWorktreeIds(`${H1}\n${H2}\n`, ['a', 'b'])).toEqual({ a: H1, b: H2 });
        expect(parseWorktreeIds(`${H1}\n`, ['a', 'b'])).toBeNull();
        expect(parseWorktreeIds('fatal: x\n', ['a'])).toBeNull();
    });
});
