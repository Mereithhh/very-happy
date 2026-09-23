/**
 * B-486: web terminals that run WITHOUT tmux (the direct-pty fallback).
 *
 * The cross-device terminal list is tmux truth (`list-sessions`), so a
 * machine without tmux — or one where `new-session` failed — used to open a
 * working shell that never appeared in the pushed list. The web's optimistic
 * create row then expired after its 60 s TTL and the terminal "vanished" from
 * the sidebar while the shell kept running (Chuhui, 2026-09-23, SageMaker
 * HyperPod image without tmux).
 *
 * A direct shell lives exactly as long as its pty in the daemon, so the
 * daemon's own session map is the membership truth for these rows. They are
 * marked `direct: true` so the web can say what they are: not reconnectable
 * after a daemon restart, no tmux-side title/agent probing.
 *
 * Pure; unit-tested.
 */

/** What the manager remembers about a live direct-pty session. */
export interface DirectTerminalInfo {
    cwd: string;
    createdAt: number;
    /** Title: the last OSC title the shell / app set, or the user's rename. */
    title?: string;
    /** The user renamed it — OSC titles no longer overwrite it. */
    manual?: boolean;
    /** Terminal tags (validated by the caller). */
    tags?: string[];
}

/** The subset of a list item this module produces (structurally a TerminalListItem). */
export interface DirectTerminalItem {
    id: string;
    title?: string;
    tags: string[];
    manual?: boolean;
    cwd: string;
    createdAt: number;
    activityAt?: number;
    direct: true;
}

/**
 * List rows for the live direct-pty sessions that tmux does not already list.
 * An id tmux knows is never duplicated (tmux stays authoritative for it).
 * Ordered by creation so the output is stable across ticks.
 */
export function directTerminalItems(
    sessions: Iterable<{ id: string; direct?: DirectTerminalInfo; lastOutputAt?: number }>,
    tmuxIds: ReadonlySet<string>,
): DirectTerminalItem[] {
    const out: DirectTerminalItem[] = [];
    for (const s of sessions) {
        if (!s.direct || tmuxIds.has(s.id)) continue;
        const title = (s.direct.title ?? '').trim();
        out.push({
            id: s.id,
            ...(title ? { title } : {}),
            tags: s.direct.tags ?? [],
            ...(s.direct.manual ? { manual: true } : {}),
            cwd: s.direct.cwd,
            createdAt: s.direct.createdAt,
            ...(s.lastOutputAt ? { activityAt: s.lastOutputAt } : {}),
            direct: true,
        });
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
