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

import { sanitizeTagList } from './liveTerminals';

export interface ClosedTerminalRecord {
    /** Terminal id (tmux session was `vh-<id>`). */
    id: string;
    /** Last known cross-device title (@vh_title) at close time. */
    title?: string;
    /** Last known pane cwd — enables "reopen in the same directory". */
    cwd?: string;
    /** Terminal mirror (B-105): shadow session of the claude that ran inside
     *  this terminal, if any — the archive view links "查看结构化历史" to it
     *  (the mirror is otherwise hidden everywhere, M-4). */
    mirrorSessionId?: string;
    /** B-149: the claude conversation that ran in this terminal, when known
     *  (resolved from the mirror session's metadata, never guessed from cwd).
     *  Present → the archive row can offer "continue": a new terminal in `cwd`
     *  whose startup command is `claude --resume <claudeSessionId>`. */
    claudeSessionId?: string;
    /** B-149: how the terminal ended. `closed` = a running daemon observed it
     *  (web kill, shell exit, machine-side kill-session). `daemon-gap` = it was
     *  alive in the persisted snapshot but gone when the daemon came back, i.e.
     *  the daemon or the whole machine restarted under it — the case that used
     *  to leave no record at all. Absent on records from older daemons; readers
     *  treat absent as `closed`. */
    reason?: ClosedTerminalReason;
    /** B-265: tags (@vh_tags) and manual-rename flag at close time, restored
     *  verbatim by `restore-terminal`. Absent on records from older daemons. */
    tags?: string[];
    manual?: boolean;
    /** B-273: the user tmux session (name) this terminal was attached to;
     *  restore re-attaches instead of opening an empty shell. */
    attachTmux?: string;
    /** B-287: pane geometry when last seen alive — a restore recreates the
     *  session at this size so claude's first paint is not reflowed later. */
    cols?: number;
    rows?: number;
    /** When the close was observed (ms epoch). For a `daemon-gap` record there
     *  was nobody to observe it, so it carries the last time the terminal was
     *  seen ALIVE instead — which is what the archive should show anyway. */
    closedAt: number;
}

/** See `ClosedTerminalRecord.reason`. */
export type ClosedTerminalReason = 'closed' | 'daemon-gap';

/** Hard cap on retained records (bounds the daemonState payload). Raised from
 *  20 to 40 with B-149: one reboot can tombstone a whole working set at once
 *  (2026-08-23: 22 terminals), and at 20 that single event would evict every
 *  pre-existing record. */
export const CLOSED_TERMINALS_MAX = 40;

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
        const { id, title, cwd, mirrorSessionId, claudeSessionId, reason, closedAt, tags, manual, attachTmux } = item as Record<string, unknown>;
        if (typeof id !== 'string' || id.length === 0 || typeof closedAt !== 'number') continue;
        if (seen.has(id)) continue;
        seen.add(id);
        const tagList = sanitizeTagList(tags);
        out.push({
            id,
            title: typeof title === 'string' ? title : undefined,
            cwd: typeof cwd === 'string' ? cwd : undefined,
            mirrorSessionId: typeof mirrorSessionId === 'string' ? mirrorSessionId : undefined,
            claudeSessionId: typeof claudeSessionId === 'string' ? claudeSessionId : undefined,
            reason: reason === 'daemon-gap' || reason === 'closed' ? reason : undefined,
            ...(tagList !== undefined ? { tags: tagList } : {}),
            ...(manual === true ? { manual: true } : {}),
            ...(typeof attachTmux === 'string' && attachTmux ? { attachTmux } : {}),
            closedAt,
        });
    }
    out.sort((a, b) => b.closedAt - a.closedAt);
    return out.slice(0, max);
}
