/**
 * B-554: git diff for the changes panel — command building and unified-diff
 * parsing. Pure; the RPC lives in useGitFileDiff.ts.
 *
 * Paths come from `git status --porcelain=v2` run in the session cwd, which
 * reports them RELATIVE TO THAT CWD (`../x.ts` from a subdirectory — verified
 * on git 2.x), so the diff runs in the same cwd with the same path.
 */

export type ReviewRow =
    | { type: 'hunk'; text: string; oldNo: null; newNo: null }
    | { type: 'add' | 'del' | 'ctx'; text: string; oldNo: number | null; newNo: number | null };

export type ParsedGitDiff = { rows: ReviewRow[]; binary: boolean };

/** Rendering cap — beyond this the view truncates with a notice. */
export const REVIEW_DIFF_MAX_ROWS = 5000;

/**
 * The `bash` RPC only takes a command string (no stdin, no argv), and runs it
 * through the MACHINE's default shell: /bin/sh on POSIX, `cmd.exe /d /s /c`
 * on Windows. Paths are therefore quoted for that exact shell (session
 * metadata `os` / machine metadata `platform`), never one-size-fits-both:
 * single quotes are literal characters in cmd, so `a&calc.txt` would run
 * `calc` there.
 */
export type ShellFlavor = 'posix' | 'cmd';
export type QuoteFailure = 'control' | 'quote' | 'unknown-platform';
export type QuotedArg = { ok: true; arg: string } | { ok: false; reason: QuoteFailure };

/** null = platform not known yet (metadata still syncing / very old CLI). */
export function shellFlavorFor(platform: string | null | undefined): ShellFlavor | null {
    if (!platform) return null;
    return platform === 'win32' ? 'cmd' : 'posix';
}

// Characters that mean nothing to sh AND cmd — safe inside plain double quotes on both.
const PORTABLE = /^[A-Za-z0-9_\-./@+ ,=~#:()\u0080-\uffff]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function quoteShellArg(value: string, flavor: ShellFlavor | null): QuotedArg {
    if (CONTROL.test(value)) return { ok: false, reason: 'control' };
    if (flavor === 'posix') return { ok: true, arg: `'${value.replace(/'/g, `'\\''`)}'` };
    if (flavor === 'cmd') {
        // Windows file names cannot contain `"`; refusing it keeps the quoting closed.
        if (value.includes('"')) return { ok: false, reason: 'quote' };
        // Inside "…" cmd treats & | < > ^ ( ) literally, but still expands
        // %VAR% (and !VAR! under delayed expansion). Leave the quotes for those
        // two and caret-escape them; the program's argv parser glues the
        // adjacent pieces ("a"^%"b" → a%b) back into one argument.
        const parts = value.split(/([%!])/).filter((p) => p !== '');
        if (parts.length === 0) return { ok: true, arg: '""' };
        return { ok: true, arg: parts.map((p) => (p === '%' || p === '!' ? `^${p}` : `"${p}"`)).join('') };
    }
    return PORTABLE.test(value) ? { ok: true, arg: `"${value}"` } : { ok: false, reason: 'unknown-platform' };
}

export type DiffCommand = { ok: true; command: string } | { ok: false; reason: QuoteFailure };

/**
 * Tracked file: diff against HEAD with a `:(literal)` pathspec (a leading `:`
 * or glob characters are not pathspec syntax). Untracked file: `--no-index`
 * against the null device — same RPC, same output cap, and unlike `readFile`
 * not subject to the CLI's cwd containment check, so `../x` works.
 */
export function gitDiffCommand(cwdRelativePath: string, opts: { untracked: boolean; flavor: ShellFlavor | null }): DiffCommand {
    const base = 'git -c core.quotepath=false diff --no-color --no-ext-diff';
    const target = quoteShellArg(opts.untracked ? cwdRelativePath : `:(literal)${cwdRelativePath}`, opts.flavor);
    if (!target.ok) return target;
    if (!opts.untracked) return { ok: true, command: `${base} HEAD -- ${target.arg}` };
    const nullDevice = opts.flavor === 'cmd' ? 'NUL' : '/dev/null';
    return { ok: true, command: `${base} --no-index -- ${nullDevice} ${target.arg}` };
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
