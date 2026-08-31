/**
 * tmux socket discipline for every daemon-side tmux client call.
 *
 * Incident 2026-08-31 (00:42 and 01:35): the happy-cli tmux suites isolated
 * their test server only via TMUX_TMPDIR. A tmux client prefers the socket
 * named in an inherited `$TMUX` (present whenever tests run inside a web
 * terminal) and ignores TMUX_TMPDIR, so the suites' sessions landed on the
 * daemon's real server and their `tmux kill-server` wiped every vh-* terminal
 * on mac-office. Two rules now hold for all tmux invocations we own:
 *
 *  1. The client env never carries `TMUX` / `TMUX_PANE` — the daemon must
 *     talk to the server it was configured for, not the one it was launched
 *     from.
 *  2. When `VH_TMUX_SOCKET` is set, every argv starts with `-S <socket>`.
 *     Production leaves it unset (default server); tests set it to a private
 *     socket so isolation no longer depends on which variables tmux honours.
 */

export const VH_TMUX_SOCKET_ENV = 'VH_TMUX_SOCKET';

/** `['-S', socket]` when a private socket is configured, else `[]`. */
export function tmuxSocketFlags(env: NodeJS.ProcessEnv = process.env): string[] {
    const socket = env[VH_TMUX_SOCKET_ENV];
    return socket ? ['-S', socket] : [];
}

/** Prefix a tmux argv with the socket selector (rule 2). */
export function tmuxArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
    return [...tmuxSocketFlags(env), ...args];
}

/** Strip the inherited client-side tmux variables from an env object (rule 1). */
export function scrubTmuxClientEnv<T extends Record<string, string | undefined>>(env: T): T {
    delete env.TMUX;
    delete env.TMUX_PANE;
    return env;
}
