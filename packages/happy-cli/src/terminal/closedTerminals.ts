/**
 * Closed-terminal records (B-084) — pure list operations, no I/O.
 *
 * When a web terminal ends (user close via kill-terminal RPC, or the tmux
 * session exiting on its own), the daemon appends a small record here and
 * ships the list inside daemonState.closedTerminals (next to webTerminals),
 * so the web can show "已结束终端" in the sidebar's archive view — with the
 * cwd, which makes a one-click "new terminal in the same directory" (and thus
 * `claude --resume`) possible.
 *
 * Rules, all enforced by these pure functions (unit-tested):
 *   - newest first, ordered by closedAt;
 *   - one record per terminal id (ids are random at creation, so a repeat
 *     close of the same id is the same terminal — newest record wins);
 *   - capped at CLOSED_TERMINALS_MAX (oldest dropped) so the daemonState
 *     payload stays bounded (~20 × a short object);
 *   - a record never coexists with a LIVE terminal of the same id
 *     (pruneClosedAgainstLive) — self-heals the rare false close recorded
 *     off a transient tmux list glitch.
 */

export interface ClosedTerminalRecord {
    /** Terminal id (tmux session was `vh-<id>`). */
    id: string;
    /** Last known cross-device title (@vh_title) at close time. */
    title?: string;
    /** Last known pane cwd — enables "reopen in the same directory". */
    cwd?: string;
    /** When the close was observed (ms epoch). */
    closedAt: number;
}

/** Hard cap on retained records (bounds the daemonState payload). */
export const CLOSED_TERMINALS_MAX = 20;

/**
 * Append one record: dedupe by id (the new record replaces any older one for
 * the same terminal), keep newest-first by closedAt, cap at `max`.
 */
export function appendClosedTerminal(
    list: ClosedTerminalRecord[],
    record: ClosedTerminalRecord,
    max: number = CLOSED_TERMINALS_MAX,
): ClosedTerminalRecord[] {
    const out = [record, ...list.filter((r) => r.id !== record.id)];
    out.sort((a, b) => b.closedAt - a.closedAt);
    return out.slice(0, max);
}

/**
 * Drop records whose id is present in the LIVE terminal list again. A closed
 * record must never shadow a living terminal: the only way this happens is a
 * transient `tmux list-sessions` failure being read as "everything closed" —
 * the next successful tick calls this and the false records disappear.
 * Returns the SAME array reference when nothing changed (cheap change check).
 */
export function pruneClosedAgainstLive(
    list: ClosedTerminalRecord[],
    liveIds: ReadonlySet<string>,
): ClosedTerminalRecord[] {
    const out = list.filter((r) => !liveIds.has(r.id));
    return out.length === list.length ? list : out;
}

/**
 * Tolerant load of a persisted (or otherwise untrusted) value into a valid
 * record list: non-arrays → [], malformed items dropped, then the same
 * ordering/dedupe/cap invariants as append.
 */
export function sanitizeClosedTerminals(
    raw: unknown,
    max: number = CLOSED_TERMINALS_MAX,
): ClosedTerminalRecord[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: ClosedTerminalRecord[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const { id, title, cwd, closedAt } = item as Record<string, unknown>;
        if (typeof id !== 'string' || id.length === 0 || typeof closedAt !== 'number') continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
            id,
            title: typeof title === 'string' ? title : undefined,
            cwd: typeof cwd === 'string' ? cwd : undefined,
            closedAt,
        });
    }
    out.sort((a, b) => b.closedAt - a.closedAt);
    return out.slice(0, max);
}
