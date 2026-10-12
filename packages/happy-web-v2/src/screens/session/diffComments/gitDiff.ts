/**
 * B-554: git diff for the changes panel — command building and unified-diff
 * parsing. Pure; the RPC lives in useGitFileDiff.ts.
 *
 * Paths come from `git status --porcelain=v2` run in the session cwd, which
 * reports them RELATIVE TO THAT CWD (`../x.ts` from a subdirectory — verified
 * on git 2.x), so the diff runs in the same cwd with the same path. The
 * `:(literal)` magic keeps a path that starts with `:` or contains glob
 * characters from being read as pathspec syntax.
 */

export type ReviewRow =
    | { type: 'hunk'; text: string; oldNo: null; newNo: null }
    | { type: 'add' | 'del' | 'ctx'; text: string; oldNo: number | null; newNo: number | null };

export type ParsedGitDiff = { rows: ReviewRow[]; binary: boolean };

/** Rendering cap — beyond this the view truncates with a notice. */
export const REVIEW_DIFF_MAX_ROWS = 5000;

const SAFE_PATH = /^[A-Za-z0-9_\-./@+ ,=~#]+$/;

/** Quote a pathspec so it survives both POSIX sh and (for ordinary paths) cmd.exe. */
export function quotePathspec(pathspec: string): string {
    if (SAFE_PATH.test(pathspec.replace(/^:\(literal\)/, ''))) return `"${pathspec}"`;
    return `'${pathspec.replace(/'/g, `'\\''`)}'`;
}

export function gitDiffCommand(cwdRelativePath: string): string {
    return `git -c core.quotepath=false diff --no-color --no-ext-diff HEAD -- ${quotePathspec(`:(literal)${cwdRelativePath}`)}`;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseGitUnifiedDiff(text: string): ParsedGitDiff {
    const rows: ReviewRow[] = [];
    let binary = false;
    let oldNo = 0;
    let newNo = 0;
    let oldLeft = 0;
    let newLeft = 0;
    for (const line of text.split('\n')) {
        if (oldLeft > 0 || newLeft > 0) {
            const sign = line[0];
            const body = line.slice(1);
            if (sign === '\\') continue; // "\ No newline at end of file"
            if (sign === '+') {
                rows.push({ type: 'add', text: body, oldNo: null, newNo: newNo++ });
                newLeft--;
                continue;
            }
            if (sign === '-') {
                rows.push({ type: 'del', text: body, oldNo: oldNo++, newNo: null });
                oldLeft--;
                continue;
            }
            if (sign === ' ' || line === '') {
                rows.push({ type: 'ctx', text: body, oldNo: oldNo++, newNo: newNo++ });
                oldLeft--;
                newLeft--;
                continue;
            }
            // Malformed counts: fall through and treat as a header line.
            oldLeft = 0;
            newLeft = 0;
        }
        const hunk = HUNK.exec(line);
        if (hunk) {
            oldNo = Number(hunk[1]);
            oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
            newNo = Number(hunk[3]);
            newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
            rows.push({ type: 'hunk', text: line, oldNo: null, newNo: null });
            continue;
        }
        if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') binary = true;
    }
    return { rows, binary };
}

/** Untracked file: every line is an addition. A trailing newline is not a line. */
export function rowsForNewFile(content: string): ReviewRow[] {
    if (content === '') return [];
    const lines = content.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.map((text, i) => ({ type: 'add' as const, text, oldNo: null, newNo: i + 1 }));
}
