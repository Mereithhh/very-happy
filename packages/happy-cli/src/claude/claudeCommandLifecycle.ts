/**
 * Which user messages a Stop made disappear before the model read them
 * (B-631; approach from Orca, src/main/claude/claude-command-lifecycle.ts and
 * claude-structured-control-actions.ts).
 *
 * Every user message the wrapper hands to the Query carries a uuid when the
 * web gave it one (B-528 prompts, B-631 steers). Claude Code 2.1.296 emits a
 * top-level `command_lifecycle` frame for every uuid-stamped command
 * (`command_uuid`, `state`: queued → started → completed | cancelled |
 * discarded | refused; capability `msg_lifecycle_v1`), and an interrupt's
 * receipt lists the commands it swept (`cancelled`, with
 * `interrupt_cancel_queued_v1`) or left (`still_queued`,
 * `interrupt_receipt_v1`). Measured 2026-10-19
 * (skills/tmp/vh-orca-lessons/b631-scratch/probe).
 *
 * A terminal state for a command that never `started` is a verdict: the model
 * never read it, and the web should see the B-332 tombstone instead of a
 * message that looks answered. This covers a steer queued behind the running
 * turn as much as a prompt the wrapper pushed while a pre-empting steer's
 * turn was still running — a Stop with cancel_queued sweeps both. After
 * `started`, `cancelled` only says the turn it was in ended (an interrupt, a
 * hard failure) — the model may have read it, the web already shows that
 * Stop, so it is settled silently (Orca: "any end is doubt"). Commands
 * without a uuid emit no lifecycle at all, and older CLIs emit none: a
 * message that is never settled is simply never reported.
 */

export const CLAUDE_COMMAND_LIFECYCLE_STATES = ['queued', 'started', 'completed', 'cancelled', 'discarded', 'refused'] as const;
export type ClaudeCommandLifecycleState = typeof CLAUDE_COMMAND_LIFECYCLE_STATES[number];
export type ClaudeCommandLifecycle = { uuid: string; state: ClaudeCommandLifecycleState };

/** The lifecycle a frame carries, or null for every other frame. */
export function readClaudeCommandLifecycle(frame: unknown): ClaudeCommandLifecycle | null {
    const m = frame as { type?: unknown; subtype?: unknown; command_uuid?: unknown; state?: unknown } | null;
    if (!m) return null;
    // 2.1.296 emits it as its own top-level type; a system subtype of the same
    // name is accepted too, should a later CLI fold it in.
    const isLifecycle = m.type === 'command_lifecycle' || (m.type === 'system' && m.subtype === 'command_lifecycle');
    if (!isLifecycle || typeof m.command_uuid !== 'string' || m.command_uuid.length === 0) return null;
    const state = CLAUDE_COMMAND_LIFECYCLE_STATES.find((candidate) => candidate === m.state);
    return state ? { uuid: m.command_uuid, state } : null;
}

export type ClaudeInterruptReceipt = { still_queued?: unknown; cancelled?: unknown } | null | undefined;

const uuidList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];

/** Capability a CLI advertises on system/init when `interrupt({cancelQueued:true})` is honored. */
export const INTERRUPT_CANCEL_QUEUED_CAPABILITY = 'interrupt_cancel_queued_v1';

/** A CLI without lifecycle frames never settles anything; the tracked set must not grow with the session. */
const PENDING_MAX = 256;
const REPORTED_MAX = 512;

/** Capability a CLI advertises on system/init when it emits `command_lifecycle` frames. */
export const MSG_LIFECYCLE_CAPABILITY = 'msg_lifecycle_v1';

/**
 * B-634 ②: a uuid-stamped message the Query ended without ever confirming —
 * no `started` (the model never read it) and no terminal verdict either: the
 * process died, or the Query was torn down, with it still in the pipe.
 */
export type ClaudeUnconfirmedCommand<P> = { uuid: string; payload: P };

export function createClaudeCommandTracker<P = unknown>() {
    /** Uuid-stamped user messages the CLI has not settled: whether it reported `started`, and what was sent. */
    const pending = new Map<string, { started: boolean; payload?: P }>();
    /** Reported once, whichever of receipt / frame / cancel response said it first. */
    const reported = new Set<string>();

    const drop = (uuid: string): string | null => {
        pending.delete(uuid);
        if (reported.has(uuid)) return null;
        reported.add(uuid);
        if (reported.size > REPORTED_MAX) reported.delete(reported.values().next().value!);
        return uuid;
    };

    return {
        /** A uuid-stamped user message (prompt or steer) was handed to the Query. */
        track(uuid: string, payload?: P): void {
            if (!pending.has(uuid) && pending.size >= PENDING_MAX) pending.delete(pending.keys().next().value!);
            pending.set(uuid, { started: false, payload });
        },
        isTracked(uuid: string): boolean { return pending.has(uuid); },
        /** A lifecycle frame; returns the uuids now known to have never run. */
        observe(lifecycle: ClaudeCommandLifecycle): string[] {
            const entry = pending.get(lifecycle.uuid);
            if (!entry) return [];
            switch (lifecycle.state) {
                case 'queued': return [];
                case 'started': entry.started = true; return [];
                case 'completed': pending.delete(lifecycle.uuid); return [];
                default: {
                    if (entry.started) {
                        pending.delete(lifecycle.uuid);
                        return [];
                    }
                    const dropped = drop(lifecycle.uuid);
                    return dropped ? [dropped] : [];
                }
            }
        },
        /**
         * An interrupt's receipt: `cancelled` members we track never ran;
         * `still_queued` members we track are returned for the per-uuid
         * follow-up (`cancel_async_message`) a CLI without cancel_queued needs.
         */
        onInterruptReceipt(receipt: ClaudeInterruptReceipt): { dropped: string[]; stillQueued: string[] } {
            const dropped: string[] = [];
            for (const uuid of uuidList(receipt?.cancelled)) {
                if (!pending.has(uuid)) continue;
                const result = drop(uuid);
                if (result) dropped.push(result);
            }
            const stillQueued = uuidList(receipt?.still_queued).filter((uuid) => pending.has(uuid));
            return { dropped, stillQueued };
        },
        /** The answer to `cancel_async_message`: true = withdrawn before it ran; false = already dequeued, its lifecycle frames follow. */
        onCancelResponse(uuid: string, cancelled: boolean): string[] {
            if (!cancelled || !pending.has(uuid)) return [];
            const dropped = drop(uuid);
            return dropped ? [dropped] : [];
        },
        /**
         * B-634 ②: the Query is over — every tracked message that never
         * `started` and was not already reported, in the order it was sent.
         * Untracked afterwards; a later frame for one of them is ignored.
         */
        takeUnconfirmed(): ClaudeUnconfirmedCommand<P>[] {
            const out: ClaudeUnconfirmedCommand<P>[] = [];
            for (const [uuid, entry] of pending) {
                if (entry.started || entry.payload === undefined || reported.has(uuid)) continue;
                out.push({ uuid, payload: entry.payload });
            }
            for (const { uuid } of out) pending.delete(uuid);
            return out;
        },
        clear(): void { pending.clear(); },
    };
}

/**
 * B-634 ②: what to do with messages a Query ended without confirming.
 * - The launcher's abort (Stop, exit, switch to local) ended it: the user
 *   ended the work, so they are tombstoned (B-332 `aborted`) — the web must
 *   not show them as answered.
 * - Otherwise the Query died under them (process exit, transport fault):
 *   the first one is sent once more into the next Query (parked, like a
 *   mode-change relaunch), provided nothing else is parked and it was not
 *   sent again before; the rest — and a second failure — are tombstoned.
 *   Once, so a message that kills the process every time cannot loop.
 */
export function planUnconfirmedCommands<P>(
    commands: readonly ClaudeUnconfirmedCommand<P>[],
    context: { aborted: boolean; parkFree: boolean; redelivered: ReadonlySet<string> },
): { redeliver: ClaudeUnconfirmedCommand<P> | null; tombstone: string[] } {
    if (context.aborted || !context.parkFree) return { redeliver: null, tombstone: commands.map((c) => c.uuid) };
    const index = commands.findIndex((c) => !context.redelivered.has(c.uuid));
    if (index < 0) return { redeliver: null, tombstone: commands.map((c) => c.uuid) };
    return {
        redeliver: commands[index],
        tombstone: commands.filter((_, i) => i !== index).map((c) => c.uuid),
    };
}

/**
 * B-853: a message the launcher handed to a Query whose input had already
 * closed (`onUndeliveredMessage`). It never reached Claude Code, so unlike an
 * unconfirmed command it has not had its first chance yet: it is parked for
 * the next launch — already finalized, replayed verbatim — unless the session
 * is leaving remote mode or the park slot is taken; then null, and the caller
 * tombstones it (B-332) so the web shows it as not delivered.
 */
export function planUndeliveredMessage<M extends { mode: unknown }>(
    message: M,
    context: { parkFree: boolean; exiting: boolean },
): (M & { finalized: true }) | null {
    if (context.exiting || !context.parkFree) return null;
    return { ...message, finalized: true };
}
