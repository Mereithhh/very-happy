import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { gitDiffCommand, parseGitUnifiedDiff, quoteShellArg, shellFlavorFor, type ReviewRow } from './gitDiff';
import {
    buildAnchor,
    commentRowIndex,
    composeDiffCommentsMessage,
    hashLines,
    parseDiffComments,
    reanchorComment,
    reanchorFile,
    type DiffComment,
} from './diffComments';

const DIFF = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,4 +1,5 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' const d = 5;',
    '--- not a header, a deleted line',
    '@@ -10,2 +11,2 @@ function tail() {',
    ' x();',
    '-y();',
    '+z();',
    '\\ No newline at end of file',
    '',
].join('\n');

function comment(over: Partial<DiffComment> & Pick<DiffComment, 'startLine' | 'endLine' | 'lines'>): DiffComment {
    return {
        id: 'c1', filePath: 'src/a.ts', side: 'new', before: null, after: null,
        hash: hashLines(over.lines), body: 'fix this', stale: false, createdAt: 1, updatedAt: 1, ...over,
    };
}

function newRows(lines: string[], start = 1): ReviewRow[] {
    return lines.map((text, i) => ({ type: 'ctx' as const, text, oldNo: start + i, newNo: start + i }));
}

describe('parseGitUnifiedDiff', () => {
    it('numbers both sides and keeps hunk headers, ignoring file headers and no-newline markers', () => {
        const { rows, binary } = parseGitUnifiedDiff(DIFF);
        expect(binary).toBe(false);
        expect(rows.map((r) => [r.type, r.oldNo, r.newNo, r.text])).toEqual([
            ['hunk', null, null, '@@ -1,4 +1,5 @@'],
            ['ctx', 1, 1, 'const a = 1;'],
            ['del', 2, null, 'const b = 2;'],
            ['add', null, 2, 'const b = 3;'],
            ['add', null, 3, 'const c = 4;'],
            ['ctx', 3, 4, 'const d = 5;'],
            // inside a hunk, "---" is a deletion, not a file header
            ['del', 4, null, '-- not a header, a deleted line'],
            ['hunk', null, null, '@@ -10,2 +11,2 @@ function tail() {'],
            ['ctx', 10, 11, 'x();'],
            ['del', 11, null, 'y();'],
            ['add', null, 12, 'z();'],
        ]);
    });

    it('flags binary diffs', () => {
        expect(parseGitUnifiedDiff('diff --git a/x b/x\nBinary files a/x and b/x differ\n').binary).toBe(true);
    });

    it('parses an untracked file diffed against the null device', () => {
        const { rows } = parseGitUnifiedDiff('diff --git a/n.ts b/n.ts\nnew file mode 100644\nindex 0000000..1\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n');
        expect(rows.map((r) => [r.type, r.newNo, r.text])).toEqual([['hunk', null, '@@ -0,0 +1,2 @@'], ['add', 1, 'a'], ['add', 2, 'b']]);
    });
});

describe('gitDiffCommand', () => {
    const NASTY = ['a&calc.txt', 'a|b.txt', '100%PATH%.txt', 'a^b.txt', '中文 文件.ts', 'with space.ts', "it's.ts", 'a$(id)`x`.ts', 'a!b.ts'];

    it('passes the cwd-relative status path as a literal pathspec', () => {
        expect(gitDiffCommand('../src/a b.ts', { untracked: false, flavor: 'posix' })).toEqual({ ok: true, command: "git -c core.quotepath=false diff --no-color --no-ext-diff HEAD -- ':(literal)../src/a b.ts'" });
    });

    it('untracked files use --no-index against the null device of that platform', () => {
        expect(gitDiffCommand('../n.ts', { untracked: true, flavor: 'posix' })).toEqual({ ok: true, command: "git -c core.quotepath=false diff --no-color --no-ext-diff --no-index -- /dev/null '../n.ts'" });
        expect(gitDiffCommand('n.ts', { untracked: true, flavor: 'cmd' })).toEqual({ ok: true, command: 'git -c core.quotepath=false diff --no-color --no-ext-diff --no-index -- NUL "n.ts"' });
    });

    it('POSIX quoting round-trips every nasty name through a real /bin/sh unchanged', () => {
        for (const name of NASTY) {
            const q = quoteShellArg(name, 'posix');
            expect(q.ok).toBe(true);
            const out = execFileSync('/bin/sh', ['-c', `printf '%s' ${(q as { arg: string }).arg}`], { encoding: 'utf8' });
            expect(out).toBe(name);
        }
    });

    it('cmd quoting keeps & | ^ inside double quotes and caret-escapes % and ! outside them', () => {
        const q = (v: string) => quoteShellArg(v, 'cmd');
        expect(q('a&calc.txt')).toEqual({ ok: true, arg: '"a&calc.txt"' });
        expect(q('a|b.txt')).toEqual({ ok: true, arg: '"a|b.txt"' });
        expect(q('a^b.txt')).toEqual({ ok: true, arg: '"a^b.txt"' });
        expect(q('100%PATH%.txt')).toEqual({ ok: true, arg: '"100"^%"PATH"^%".txt"' });
        expect(q('a!b.ts')).toEqual({ ok: true, arg: '"a"^!"b.ts"' });
        expect(q('中文 文件.ts')).toEqual({ ok: true, arg: '"中文 文件.ts"' });
        expect(q('with space.ts')).toEqual({ ok: true, arg: '"with space.ts"' });
        // every cmd metacharacter that is NOT caret-escaped sits inside a quoted span
        for (const name of NASTY) {
            const r = q(name);
            if (!r.ok) continue;
            const outsideQuotes = r.arg.replace(/"[^"]*"/g, '');
            expect(outsideQuotes).toMatch(/^(\^[%!])*$/);
        }
    });

    it('refuses what it cannot quote safely instead of guessing', () => {
        expect(quoteShellArg('a"b.ts', 'cmd')).toEqual({ ok: false, reason: 'quote' });
        expect(quoteShellArg('a\nb.ts', 'posix')).toEqual({ ok: false, reason: 'control' });
        expect(gitDiffCommand('a&b.ts', { untracked: false, flavor: null })).toEqual({ ok: false, reason: 'unknown-platform' });
        expect(gitDiffCommand('中文 a.ts', { untracked: false, flavor: null })).toEqual({ ok: true, command: 'git -c core.quotepath=false diff --no-color --no-ext-diff HEAD -- ":(literal)中文 a.ts"' });
    });

    it('maps platforms to shells', () => {
        expect(shellFlavorFor('win32')).toBe('cmd');
        expect(shellFlavorFor('darwin')).toBe('posix');
        expect(shellFlavorFor('linux')).toBe('posix');
        expect(shellFlavorFor(undefined)).toBeNull();
    });
});

describe('buildAnchor', () => {
    const { rows } = parseGitUnifiedDiff(DIFF);
    it('captures text, contiguous neighbours and hash for a new-side range', () => {
        const a = buildAnchor(rows, 'new', 3, 2)!;
        expect(a).toMatchObject({ side: 'new', startLine: 2, endLine: 3, lines: ['const b = 3;', 'const c = 4;'], before: 'const a = 1;', after: 'const d = 5;' });
        expect(a.hash).toBe(hashLines(['const b = 3;', 'const c = 4;']));
    });
    it('uses HEAD numbering on the old side', () => {
        expect(buildAnchor(rows, 'old', 2, 2)).toMatchObject({ lines: ['const b = 2;'], before: 'const a = 1;', after: 'const d = 5;' });
    });
    it('rejects ranges that cross a hunk gap', () => {
        expect(buildAnchor(rows, 'new', 4, 11)).toBeNull();
    });
    it('does not take a neighbour across a hunk gap', () => {
        expect(buildAnchor(rows, 'new', 11, 11)).toMatchObject({ before: null, after: 'z();' });
    });
});

describe('reanchorComment', () => {
    it('stays put when the text at the original lines still matches', () => {
        const c = comment({ startLine: 2, endLine: 2, lines: ['b'] });
        expect(reanchorComment(c, newRows(['a', 'b', 'c']))).toMatchObject({ startLine: 2, endLine: 2, stale: false, before: 'a', after: 'c' });
    });

    it('follows the code when lines are inserted above (drift)', () => {
        const c = comment({ startLine: 2, endLine: 3, lines: ['b', 'c'], before: 'a', after: 'd' });
        const r = reanchorComment(c, newRows(['new1', 'new2', 'a', 'b', 'c', 'd']));
        expect(r).toMatchObject({ startLine: 4, endLine: 5, stale: false });
    });

    it('prefers the duplicate whose neighbours match over the nearer one', () => {
        const c = comment({ startLine: 2, endLine: 2, lines: ['}'], before: 'return x;', after: '' });
        const r = reanchorComment(c, newRows(['}', 'foo();', 'return x;', '}', '']));
        expect(r).toMatchObject({ startLine: 4, stale: false });
    });

    it('breaks a neighbour tie by distance to the old position', () => {
        const c = comment({ startLine: 5, endLine: 5, lines: ['x'] });
        expect(reanchorComment(c, newRows(['x', 'a', 'b', 'c', 'd', 'e', 'x'])).startLine).toBe(7);
    });

    it('marks stale and keeps the last position when the text is gone', () => {
        const c = comment({ startLine: 2, endLine: 2, lines: ['b'], before: 'a' });
        expect(reanchorComment(c, newRows(['a', 'B', 'c']))).toEqual({ startLine: 2, endLine: 2, before: 'a', after: null, stale: true });
    });

    it('recovers from stale once the text is back', () => {
        const c = comment({ startLine: 2, endLine: 2, lines: ['b'], stale: true });
        expect(reanchorComment(c, newRows(['a', 'z', 'b'])).stale).toBe(false);
    });

    it('does not match a window that crosses a hunk gap', () => {
        const rows: ReviewRow[] = [...newRows(['b'], 1), ...newRows(['c'], 10)];
        expect(reanchorComment(comment({ startLine: 1, endLine: 2, lines: ['b', 'c'] }), rows).stale).toBe(true);
    });

    it('reanchorFile only returns comments of that file that changed', () => {
        const same = comment({ id: 'same', startLine: 1, endLine: 1, lines: ['a'], after: 'b' });
        const moved = comment({ id: 'moved', startLine: 1, endLine: 1, lines: ['b'], after: null });
        const other = comment({ id: 'other', filePath: 'x.ts', startLine: 1, endLine: 1, lines: ['zzz'] });
        const changed = reanchorFile([same, moved, other], 'src/a.ts', newRows(['a', 'b']));
        expect(changed.map((c) => [c.id, c.startLine])).toEqual([['moved', 2]]);
    });

    it('commentRowIndex finds the row of the last commented line on its side', () => {
        const { rows } = parseGitUnifiedDiff(DIFF);
        expect(rows[commentRowIndex({ side: 'old', endLine: 2 }, rows)!].text).toBe('const b = 2;');
        expect(commentRowIndex({ side: 'new', endLine: 99 }, rows)).toBeNull();
    });
});

describe('composeDiffCommentsMessage', () => {
    it('groups by file, orders by line, and includes path, range, snippet and note', () => {
        const msg = composeDiffCommentsMessage([
            comment({ id: '1', filePath: 'z.ts', startLine: 3, endLine: 3, lines: ['zz'], body: 'last file' }),
            comment({ id: '2', filePath: 'a.ts', startLine: 9, endLine: 10, lines: ['l9', 'l10'], body: 'second' }),
            comment({ id: '3', filePath: 'a.ts', startLine: 2, endLine: 2, lines: ['l2'], body: 'first', stale: true }),
            comment({ id: '4', filePath: 'a.ts', side: 'old', startLine: 1, endLine: 1, lines: ['gone'], body: 'why removed' }),
            comment({ id: '5', filePath: 'b.ts', startLine: 1, endLine: 1, lines: ['x'], body: '   ' }),
        ], 'en');
        expect(msg).toBe([
            'Please address these review comments on the current diff (4 comments in 2 files):',
            '',
            '## a.ts',
            '',
            '1. L2 ⚠ stale: this code has changed; snippet is from when the comment was written',
            '```', 'l2', '```', 'Comment: first',
            '',
            '2. L9-10',
            '```', 'l9', 'l10', '```', 'Comment: second',
            '',
            '3. L1 (deleted lines, HEAD numbering)',
            '```', 'gone', '```', 'Comment: why removed',
            '',
            '## z.ts',
            '',
            '1. L3',
            '```', 'zz', '```', 'Comment: last file',
        ].join('\n'));
    });

    it('lengthens the fence past backtick runs inside the snippet and localizes to zh', () => {
        const msg = composeDiffCommentsMessage([comment({ startLine: 1, endLine: 1, lines: ['a ```` b'], body: '改' })], 'zh');
        expect(msg).toContain('\n`````\na ```` b\n`````\n批注: 改');
        expect(msg.startsWith('请根据下面的代码审阅批注修改（共 1 条，涉及 1 个文件')).toBe(true);
    });

    it('returns empty when nothing has a body', () => {
        expect(composeDiffCommentsMessage([comment({ startLine: 1, endLine: 1, lines: ['a'], body: '' })], 'en')).toBe('');
    });
});

describe('parseDiffComments', () => {
    it('drops malformed records and survives garbage', () => {
        const ok = comment({ startLine: 1, endLine: 1, lines: ['a'] });
        expect(parseDiffComments(JSON.stringify([ok, { ...ok, side: 'left' }, { ...ok, startLine: 0 }, null]))).toEqual([ok]);
        expect(parseDiffComments('{nope')).toEqual([]);
        expect(parseDiffComments(undefined)).toEqual([]);
    });
});

describe('touch sheet a11y helpers', () => {
    it('wraps Tab at both ends and pulls outside focus back into the dialog', async () => {
        const { trapFocusTarget, isActivationKey } = await import('./focusTrap');
        expect(trapFocusTarget(3, 2, false)).toBe(0);
        expect(trapFocusTarget(3, 0, true)).toBe(2);
        expect(trapFocusTarget(3, 1, false)).toBeNull();
        expect(trapFocusTarget(3, -1, false)).toBe(0);
        expect(trapFocusTarget(3, -1, true)).toBe(2);
        expect(trapFocusTarget(0, -1, false)).toBeNull();
        expect(['Enter', ' ', 'a'].map(isActivationKey)).toEqual([true, true, false]);
    });
});
