/**
 * B-940b — what an exiting wrapper does with the messages it received but
 * never handed to Claude Code (still in its queue, parked for the next launch,
 * a session message held behind Claude Code's own turn, a pull in hand).
 *
 * Before: nothing. The B-679 exit cursor already sat above them, so the next
 * wrapper did not replay them, and no tombstone was sent — the sender saw
 * `delivered` and the Web showed nothing wrong (QA-T R65 ③ P2).
 *
 * Now:
 *   - `offline` (SIGTERM: `sessions stop`, daemon restart / upgrade,
 *     shutdown): the ones with a known seq ride on the exit stamp
 *     (`exitCursor.redeliver`) and the next wrapper routes exactly those
 *     again — same stored record, so a session message stays non-user and
 *     the owner's stays the owner's. The rest is tombstoned (`restarted`).
 *   - `archive` (crash, archive / kill): there is no next wrapper to run them
 *     — tombstoned (`aborted`), so the Web shows them as not delivered.
 *   - `hibernate` only happens with an empty queue; `superseded` hands the
 *     session to a successor that scans for undelivered input itself.
 */
import type { SessionExitIntent } from './sessionExitLifecycle';
import type { ExitRedelivery } from '@/utils/reconnectSession';
import type { QueueDiscardReason } from '@/utils/MessageQueue2';

export type ExitUndeliveredPlan = {
    redeliver: ExitRedelivery[];
    tombstone: string[];
    reason: QueueDiscardReason;
};

export function planExitUndelivered(
    intent: SessionExitIntent,
    localIds: readonly string[],
    client: { handOverUndelivered(localIds: readonly string[]): { redeliver: ExitRedelivery[]; unreplayable: string[] } },
): ExitUndeliveredPlan {
    const unique = [...new Set(localIds.filter((id) => typeof id === 'string' && id.length > 0))];
    if (unique.length === 0 || intent === 'hibernate' || intent === 'superseded') {
        return { redeliver: [], tombstone: [], reason: 'aborted' };
    }
    if (intent === 'offline') {
        const { redeliver, unreplayable } = client.handOverUndelivered(unique);
        return { redeliver, tombstone: unreplayable, reason: 'restarted' };
    }
    return { redeliver: [], tombstone: unique, reason: 'aborted' };
}
