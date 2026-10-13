/**
 * B-583/B-584: git / gh command strings for the session `bash` RPC. Pure.
 *
 * The RPC takes ONE command string (no argv, no stdin) and runs it through the
 * machine's default shell — /bin/sh on POSIX, `cmd.exe` on Windows — so every
 * argument goes through the flavor-aware `quoteShellArg` (B-554) and every
 * path is a `:(literal)` pathspec after `--`. There is deliberately no way to
 * build a force push here (spec: no --force in any form).
 */
import { quoteShellArg, type QuoteFailure, type ShellFlavor } from '../diffComments/gitDiff';
import { parseStatusSummaryV2 } from '@/sync/git-parsers/parseStatusV2';

export type BuildFailure = QuoteFailure | 'newline' | 'too-long' | 'empty' | 'no-remote';
export type Built = { ok: true; command: string } | { ok: false; reason: BuildFailure };

const GIT = 'git -c core.quotepath=false';
/** cmd.exe's command-line limit is 8191; keep head-room for the wrapper. */
const CMD_MAX = 7000;
// Everything below 0x20 except \t and \n, plus DEL.
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_TAB_NL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

function arg(value: string, flavor: ShellFlavor | null): { ok: true; arg: string } | { ok: false; reason: BuildFailure } {
    return quoteShellArg(value, flavor);
}

/** Free text that may span lines (commit message, PR body). */
function multilineArg(value: string, flavor: ShellFlavor | null): { ok: true; arg: string } | { ok: false; reason: BuildFailure } {
    const text = value.replace(/\r\n?/g, '\n');
    if (!text.includes('\n')) return arg(text, flavor);
    // POSIX single quotes keep a literal newline; cmd/unknown cannot carry one.
    if (flavor !== 'posix') return { ok: false, reason: 'newline' };
    if (CONTROL_EXCEPT_TAB_NL.test(text)) return { ok: false, reason: 'control' };
    return { ok: true, arg: `'${text.replace(/'/g, `'\\''`)}'` };
}

/**
 * Environment for one command chain. Credential/gh prompts fail fast instead
 * of hanging until the timeout (there is no TTY behind the RPC).
 */
export function withEnv(flavor: ShellFlavor | null, vars: Record<string, string>, command: string): string {
    const entries = Object.entries(vars);
    if (entries.length === 0) return command;
    if (flavor === 'cmd') return `${entries.map(([k, v]) => `set "${k}=${v}"`).join(' && ')} && ${command}`;
    return `export ${entries.map(([k, v]) => `${k}=${v}`).join(' ')} && ${command}`;
}

/** The same command without our non-interactive env prefix — for copying into a terminal. */
export function humanCommand(command: string): string {
    const prefixes = [
        /^export (?:[A-Z_]+=\w+ ?)+&& /,
        /^c="[^"]*" && /,
        /^export GIT_SSH_COMMAND="[^"]*" && /,
        /^set "[A-Z_]+=\w+" && /,
    ];
    let out = command;
    for (let changed = true; changed;) {
        changed = false;
        for (const re of prefixes) {
            const next = out.replace(re, '');
            if (next !== out) { out = next; changed = true; }
        }
    }
    return out;
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0' };
const GH_ENV = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };

/** `git commit -m …` arguments: one -m on POSIX, one -m per paragraph on cmd. */
export function commitMessageArgs(message: string, flavor: ShellFlavor | null): Built {
    const text = message.replace(/\r\n?/g, '\n').trim();
    if (!text) return { ok: false, reason: 'empty' };
    if (flavor === 'posix' || !text.includes('\n')) {
        const m = multilineArg(text, flavor);
        return m.ok ? { ok: true, command: `-m ${m.arg}` } : m;
    }
    // cmd: git joins several -m with a blank line, so paragraphs survive;
    // a newline INSIDE a paragraph cannot be expressed.
    const parts: string[] = [];
    for (const paragraph of text.split(/\n\s*\n/)) {
        const p = paragraph.trim();
        if (!p) continue;
        if (p.includes('\n')) return { ok: false, reason: 'newline' };
        const q = arg(p, flavor);
        if (!q.ok) return q;
        parts.push(`-m ${q.arg}`);
    }
    return { ok: true, command: parts.join(' ') };
}

export type CommitFile = {
    /** cwd-relative path as `git status` reported it */
    path: string;
    /** rename source — committed (as a removal) together with `path` */
    oldPath?: string;
    /** removed from the index already: `git add` would reject the pathspec */
    stagedDelete?: boolean;
};

function literal(path: string, flavor: ShellFlavor | null) {
    return arg(`:(literal)${path}`, flavor);
}

export type CommitBuilt = { ok: true; command: string; /** cmd only: list too long, fell back to `add -A` */ allFallback: boolean } | { ok: false; reason: BuildFailure };

/**
 * Always an explicit path list — a snapshot of what the dialog showed, so a
 * file the agent creates/edits while the dialog is open is not swept in
 * (review P2-1). `commit -- <paths>` implies `--only`, so other staged
 * entries stay staged. Only when cmd.exe's length limit is hit AND every file
 * is selected does it fall back to `add -A` (the UI says so).
 */
export function buildCommitCommand(opts: { files: CommitFile[]; all: boolean; message: string; flavor: ShellFlavor | null }): CommitBuilt {
    const msg = commitMessageArgs(opts.message, opts.flavor);
    if (!msg.ok) return msg;
    if (opts.files.length === 0) return { ok: false, reason: 'empty' };
    const addArgs: string[] = [];
    const commitArgs: string[] = [];
    const seen = new Set<string>();
    for (const f of opts.files) {
        for (const p of [f.path, f.oldPath]) {
            if (!p || seen.has(p)) continue;
            seen.add(p);
            const q = literal(p, opts.flavor);
            if (!q.ok) return q;
            commitArgs.push(q.arg);
            if (p === f.path && !f.stagedDelete) addArgs.push(q.arg);
        }
    }
    const add = addArgs.length ? `${GIT} add -A -- ${addArgs.join(' ')} && ` : '';
    const command = withEnv(opts.flavor, GIT_ENV, `${add}${GIT} commit ${msg.command} -- ${commitArgs.join(' ')}`);
    if (opts.flavor !== 'cmd' || command.length <= CMD_MAX) return { ok: true, command, allFallback: false };
    if (!opts.all) return { ok: false, reason: 'too-long' };
    return { ok: true, command: withEnv(opts.flavor, GIT_ENV, `${GIT} add -A && ${GIT} commit ${msg.command}`), allFallback: true };
}

/** Split `origin/feat/x` into remote + branch using the known remote names (longest match). */
export function splitUpstream(upstream: string, remotes: string[]): { remote: string; branch: string } | null {
    const match = [...remotes].sort((a, b) => b.length - a.length).find((r) => upstream.startsWith(`${r}/`));
    if (match) return { remote: match, branch: upstream.slice(match.length + 1) };
    const i = upstream.indexOf('/');
    return i > 0 ? { remote: upstream.slice(0, i), branch: upstream.slice(i + 1) } : null;
}

export type PushTarget = {
    remote: string;
    /** remote branch the push writes — ALWAYS the local branch name */
    branch: string;
    /** `-u`: the current upstream is missing or has a different name */
    setUpstream: boolean;
    /** current upstream (e.g. `origin/main`) when it differs from the target; shown in the dialog */
    divergentUpstream: string | null;
};

/**
 * Where a push goes. The target is the same-named branch on the remote, never
 * "whatever the upstream is": `git worktree add -b x path origin/main` leaves
 * `x` tracking `origin/main`, and pushing to the upstream there would
 * fast-forward the remote default branch (review P0). Remote: the upstream's
 * when it has the same name, else `origin`, else the upstream's, else the only one.
 */
export function pushTarget(probe: Pick<GitProbe, 'branch' | 'upstream' | 'remotes'>): PushTarget | null {
    if (!probe.branch) return null;
    const names = probe.remotes.map((r) => r.name);
    const split = probe.upstream ? splitUpstream(probe.upstream, names) : null;
    const tracksSame = !!split && split.branch === probe.branch;
    const remote = tracksSame ? split!.remote
        : names.includes('origin') ? 'origin'
        : split?.remote ?? (names.length === 1 ? names[0] : null);
    if (!remote) return null;
    return { remote, branch: probe.branch, setUpstream: !tracksSame, divergentUpstream: split && !tracksSame ? probe.upstream : null };
}

/**
 * Never `--force`/`-f`/`--force-with-lease`/`+refspec`: a rejected push is
 * handed to the agent (or the user's terminal), not overridden here.
 * SSH runs in BatchMode (appended to the user's own ssh command, not
 * replacing it) so a passphrase/host-key prompt fails fast instead of hanging.
 */
export function buildPushCommand(opts: { target: PushTarget | null; flavor: ShellFlavor | null }): Built {
    const t = opts.target;
    if (!t) return { ok: false, reason: 'no-remote' };
    const r = arg(t.remote, opts.flavor);
    if (!r.ok) return r;
    const ref = arg(`HEAD:refs/heads/${t.branch}`, opts.flavor);
    if (!ref.ok) return ref;
    const push = `git push${t.setUpstream ? ' -u' : ''} ${r.arg} ${ref.arg}`;
    if (opts.flavor === 'posix') {
        return { ok: true, command: `export GIT_TERMINAL_PROMPT=0 && c="\${GIT_SSH_COMMAND:-$(git config --get core.sshCommand || true)}" && export GIT_SSH_COMMAND="\${c:-ssh} -o BatchMode=yes" && ${push}` };
    }
    return { ok: true, command: withEnv(opts.flavor, GIT_ENV, push) };
}

/** Push output that means "authenticate in a terminal first". */
export function isAuthFailure(output: string): boolean {
    return /Permission denied \(publickey|Host key verification failed|could not read (Username|Password)|terminal prompts disabled|Authentication failed|passphrase|BatchMode/i.test(output);
}

export function buildPrCreateCommand(opts: { title: string; body: string; draft: boolean; flavor: ShellFlavor | null }): Built {
    const title = opts.title.replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (!title) return { ok: false, reason: 'empty' };
    const t = arg(title, opts.flavor);
    if (!t.ok) return t;
    const b = multilineArg(opts.body.trim(), opts.flavor);
    if (!b.ok) return b;
    const command = `gh pr create --title ${t.arg} --body ${b.arg}${opts.draft ? ' --draft' : ''}`;
    return { ok: true, command: withEnv(opts.flavor, GH_ENV, command) };
}

export const GH_AUTH_STATUS_COMMAND = 'gh auth status';

export function prViewCommand(flavor: ShellFlavor | null): string {
    return withEnv(flavor, GH_ENV, 'gh pr view --json number,state,isDraft,url,title,statusCheckRollup');
}

/** Failed-step logs of one Actions run; POSIX keeps only the tail so the 1MB exec buffer never trips. */
export function runLogCommand(runId: string, flavor: ShellFlavor | null): Built {
    if (!/^\d{1,20}$/.test(runId)) return { ok: false, reason: 'quote' };
    const base = withEnv(flavor, GH_ENV, `gh run view ${runId} --log-failed`);
    return { ok: true, command: flavor === 'posix' ? `${base} 2>&1 | tail -c 12000` : base };
}

// ── probe: branch, upstream, remotes, default branch, last commit ──────────

const MARK = (name: string) => `@@vh:${name}@@`;

export function buildProbeCommand(flavor: ShellFlavor | null): Built {
    const sep = flavor === 'cmd' ? ' & ' : ' ; ';
    const nul = flavor === 'cmd' ? 'NUL' : '/dev/null';
    const fmt = arg('--format=%(refname) %(symref)', flavor);
    const pattern = arg('refs/remotes/*/HEAD', flavor);
    const log = arg('--format=%B', flavor);
    if (!fmt.ok) return fmt;
    if (!pattern.ok) return pattern;
    if (!log.ok) return log;
    const parts = [
        `echo ${MARK('status')}`,
        `${GIT} status --porcelain=v2 --branch --untracked-files=no 2>${nul}`,
        `echo ${MARK('remotes')}`,
        `git remote -v 2>${nul}`,
        `echo ${MARK('heads')}`,
        `git for-each-ref ${fmt.arg} ${pattern.arg} 2>${nul}`,
        `echo ${MARK('last')}`,
        `git log -1 ${log.arg} 2>${nul}`,
        `echo ${MARK('end')}`,
    ];
    return { ok: true, command: parts.join(sep) };
}

export type RemoteEntry = { name: string; url: string };

export type GitProbe = {
    /** null = detached HEAD / not a repo */
    branch: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
    remotes: RemoteEntry[];
    /** remote name → its default branch (from refs/remotes/<r>/HEAD) */
    defaultBranches: Record<string, string>;
    lastCommitMessage: string;
};

function sections(stdout: string): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    let current: string | null = null;
    for (const raw of stdout.replace(/\r\n?/g, '\n').split('\n')) {
        const marker = /^@@vh:([a-z]+)@@\s*$/.exec(raw.trim());
        if (marker) {
            current = marker[1];
            out[current] = [];
            continue;
        }
        if (current) out[current].push(raw);
    }
    return out;
}

export function parseRemotesV(lines: string[]): RemoteEntry[] {
    const seen = new Map<string, string>();
    for (const line of lines) {
        const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)\s*$/.exec(line.trim());
        if (m && (m[3] === 'fetch' || !seen.has(m[1]))) seen.set(m[1], m[2]);
    }
    return [...seen].map(([name, url]) => ({ name, url }));
}

export function parseProbe(stdout: string): GitProbe | null {
    const s = sections(stdout);
    if (!s.status || !s.end) return null;
    const summary = parseStatusSummaryV2(s.status.join('\n'));
    const head = summary.branch.head;
    const branch = head && head !== '(detached)' ? head : null;
    const defaultBranches: Record<string, string> = {};
    for (const line of s.heads ?? []) {
        const m = /^refs\/remotes\/(.+)\/HEAD\s+refs\/remotes\/(.+)$/.exec(line.trim());
        if (m && m[2].startsWith(`${m[1]}/`)) defaultBranches[m[1]] = m[2].slice(m[1].length + 1);
    }
    return {
        branch,
        upstream: summary.branch.upstream ?? null,
        ahead: summary.branch.ahead ?? 0,
        behind: summary.branch.behind ?? 0,
        remotes: parseRemotesV(s.remotes ?? []),
        defaultBranches,
        lastCommitMessage: (s.last ?? []).join('\n').trim(),
    };
}

/** Default branch of the remote a push would go to. */
export function defaultBranchFor(probe: GitProbe): string | null {
    const remote = pushTarget(probe)?.remote;
    return (remote && probe.defaultBranches[remote]) || null;
}

/** Push needs a second confirmation (spec §2). */
export function isProtectedBranch(branch: string | null, defaultBranch: string | null): boolean {
    if (!branch) return false;
    return branch === defaultBranch || branch === 'main' || branch === 'master';
}

/**
 * Branch has commits the remote does not: no same-named upstream yet, or
 * ahead of it. (ahead/behind against a differently named upstream says
 * nothing about the push target.)
 */
export function needsPush(probe: Pick<GitProbe, 'branch' | 'upstream' | 'ahead' | 'remotes'>): boolean {
    const t = pushTarget(probe);
    return !!t && (t.setUpstream || probe.ahead > 0);
}

/** Same-named upstream has commits we don't: pushing would be rejected — pull first. */
export function remoteAhead(probe: Pick<GitProbe, 'branch' | 'upstream' | 'behind' | 'remotes'>): boolean {
    const t = pushTarget(probe);
    return !!t && !t.setUpstream && probe.behind > 0;
}

// ── POSIX background job: start returns at once, poll reads the exit code ──

export const JOB_OUTPUT_CAP = 65536;

export function buildJobStart(body: string): string {
    // Dirs are removed when the web reads the result; ones whose poll was
    // abandoned (dialog closed, deadline) are swept here after a day.
    return `find "\${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'vh-git.*' -mtime +0 -exec rm -rf {} + 2>/dev/null; d=$(mktemp -d "\${TMPDIR:-/tmp}/vh-git.XXXXXX") || exit 97; ( ( ${body} ); echo $? >"$d/rc.tmp"; mv "$d/rc.tmp" "$d/rc" ) >"$d/out" 2>&1 </dev/null & echo "@@vh-job $d"`;
}

export function parseJobStart(stdout: string): string | null {
    const m = /^@@vh-job (\/[^\n'"`$\\]*\/vh-git\.[A-Za-z0-9]+)\s*$/m.exec(stdout);
    return m ? m[1] : null;
}

export function buildJobPoll(dir: string): Built {
    const q = quoteShellArg(dir, 'posix');
    if (!q.ok) return q;
    return {
        ok: true,
        command: `d=${q.arg}; if [ -f "$d/rc" ]; then echo "@@vh-done $(cat "$d/rc") $(wc -c <"$d/out")"; tail -c ${JOB_OUTPUT_CAP} "$d/out"; rm -rf "$d"; elif [ -d "$d" ]; then echo "@@vh-running"; else echo "@@vh-gone"; fi`,
    };
}

export type JobPoll =
    | { state: 'running' }
    | { state: 'gone' }
    | { state: 'done'; exitCode: number; output: string; truncated: boolean };

export function parseJobPoll(stdout: string): JobPoll | null {
    const nl = stdout.indexOf('\n');
    const first = (nl === -1 ? stdout : stdout.slice(0, nl)).trim();
    if (first === '@@vh-running') return { state: 'running' };
    if (first === '@@vh-gone') return { state: 'gone' };
    const m = /^@@vh-done\s+(-?\d+)\s+(\d+)$/.exec(first);
    if (!m) return null;
    const output = nl === -1 ? '' : stdout.slice(nl + 1);
    return { state: 'done', exitCode: Number(m[1]), output, truncated: Number(m[2]) > JOB_OUTPUT_CAP };
}

// ── changes list → commit candidates ───────────────────────────────────────

export type CommitCandidate = CommitFile & { status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' };

/**
 * One row per path (staged and unstaged entries merged). A path that is only
 * in the staged list as a deletion is gone from the index already, so it is
 * committed but not `git add`ed (that pathspec would fail).
 */
export function commitCandidates(status: {
    stagedFiles: { fullPath: string; status: CommitCandidate['status']; oldPath?: string }[];
    unstagedFiles: { fullPath: string; status: CommitCandidate['status']; oldPath?: string }[];
} | null): CommitCandidate[] {
    if (!status) return [];
    const byPath = new Map<string, CommitCandidate>();
    const unstaged = new Set(status.unstagedFiles.map((f) => f.fullPath));
    for (const f of [...status.unstagedFiles, ...status.stagedFiles]) {
        const prev = byPath.get(f.fullPath);
        if (prev) {
            if (!prev.oldPath && f.oldPath) prev.oldPath = f.oldPath;
            continue;
        }
        byPath.set(f.fullPath, {
            path: f.fullPath,
            status: f.status,
            ...(f.oldPath ? { oldPath: f.oldPath } : {}),
            ...(f.status === 'deleted' && !unstaged.has(f.fullPath) ? { stagedDelete: true } : {}),
        });
    }
    return [...byPath.values()];
}
