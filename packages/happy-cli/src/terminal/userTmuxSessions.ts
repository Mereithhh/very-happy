/**
 * B-273: the machine's OWN tmux sessions (everything that is not a `vh-*`
 * web terminal), so the web can offer "attach an existing tmux session".
 * Pure helpers only — the daemon supplies the `list-sessions` output and
 * the socket; nothing here touches tmux.
 *
 * Why sessions are addressed by `#{session_id}` (`$N`) and never by name:
 * tmux ≥3.2 SANITIZES session names instead of rejecting them, so `:`, `.`,
 * `$`, spaces and quotes all survive into a name — and a `-t '=a:b'` target
 * is then parsed as "session a, window b" (verified 2026-09-02 on 3.7b;
 * `$N` targets resolve unambiguously on 3.2a and 3.7b).
 */
import { shellescape } from '@/utils/shellescape';

export const USER_SESSION_FIELD_SEP = '\x1f';

/** `pane_current_path` is deliberately LAST: a directory name may contain
 *  0x1f (verified), so the tail is rejoined instead of shifting fields. The
 *  session NAME cannot (tmux rejects/visifies control characters). */
export const USER_SESSIONS_FORMAT = [
    '#{session_id}',
    '#{session_name}',
    '#{session_windows}',
    '#{session_attached}',
    '#{session_activity}',
    '#{session_created}',
    '#{pane_current_command}',
    '#{pane_current_path}',
].join(USER_SESSION_FIELD_SEP);

export interface UserTmuxSession {
    /** tmux `#{session_id}`, e.g. `$3` — stable for the server's lifetime. */
    id: string;
    name: string;
    windows: number;
    /** Some client (a local terminal) is attached right now. */
    attached: boolean;
    /** ms epoch. */
    activityAt?: number;
    createdAt?: number;
    /** Active pane of the current window — display only. */
    command?: string;
    cwd?: string;
}

export const TMUX_SESSION_ID_RE = /^\$\d{1,9}$/;

export const TMUX_SESSION_NAME_MAX = 128;

/** Defence in depth (tmux already refuses control characters in names). */
export function isSafeTmuxSessionName(name: unknown): name is string {
    if (typeof name !== 'string') return false;
    if (name.length === 0 || name.length > TMUX_SESSION_NAME_MAX) return false;
    // eslint-disable-next-line no-control-regex
    return !/[\x00-\x1f\x7f]/.test(name);
}

/** Web-terminal namespace — never offered for attach, never listed. */
export function isVhSessionName(name: string): boolean {
    return name.startsWith('vh-');
}

/** Parse one `list-sessions -F USER_SESSIONS_FORMAT` line. Pure. */
export function parseUserSessionLine(line: string): UserTmuxSession | undefined {
    if (!line) return undefined;
    const parts = line.split(USER_SESSION_FIELD_SEP);
    if (parts.length < 8) return undefined;
    const [id, name, windows, attached, activity, created, command] = parts;
    if (!TMUX_SESSION_ID_RE.test(id) || !isSafeTmuxSessionName(name)) return undefined;
    const cwd = parts.slice(7).join(USER_SESSION_FIELD_SEP);
    const num = (v: string) => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
    return {
        id,
        name,
        windows: Math.max(0, Math.floor(num(windows) ?? 0)),
        attached: (num(attached) ?? 0) > 0,
        activityAt: activity ? (num(activity) ?? 0) * 1000 || undefined : undefined,
        createdAt: created ? (num(created) ?? 0) * 1000 || undefined : undefined,
        command: command.trim() || undefined,
        cwd: cwd || undefined,
    };
}

export const USER_SESSIONS_MAX = 50;

/** Parse the whole output: drop `vh-*`, newest activity first, capped. */
export function parseUserSessions(stdout: string, max: number = USER_SESSIONS_MAX): UserTmuxSession[] {
    const out: UserTmuxSession[] = [];
    for (const line of stdout.split('\n')) {
        const s = parseUserSessionLine(line);
        if (!s || isVhSessionName(s.name)) continue;
        out.push(s);
    }
    out.sort((a, b) => (b.activityAt ?? 0) - (a.activityAt ?? 0));
    return out.slice(0, max);
}

/**
 * The line typed into a fresh vh-* pane to attach the user's session inside
 * it. `TMUX=` (empty) is what disables tmux's nesting guard (verified —
 * `-e TMUX=` at create time cannot: tmux re-injects TMUX into every pane).
 * Leading space keeps it out of `HIST_IGNORE_SPACE` shell histories. `-S` is
 * required only when the daemon runs on a non-default socket (tests): once
 * TMUX is cleared the inner client would otherwise fall back to the default
 * server. `$N` is literal inside single quotes in sh/bash/zsh/fish.
 */
export function attachStartupCommand(sessionId: string, socket?: string): string {
    if (!TMUX_SESSION_ID_RE.test(sessionId)) throw new Error(`not a tmux session id: ${sessionId}`);
    const sock = socket ? ` -S ${shellescape(socket)}` : '';
    return ` TMUX= tmux${sock} attach-session -t ${shellescape(sessionId)}`;
}
