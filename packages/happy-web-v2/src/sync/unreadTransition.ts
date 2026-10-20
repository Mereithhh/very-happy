/**
 * B-331: when a session earns the sidebar's 未读 dot, and when the dot shows.
 *
 * A one-shot run that finishes and exits used to never get a dot, through two
 * gates: marking required `presence === 'online'` (the turn's end and the
 * wrapper's exit usually land in the SAME applySessions batch), and the row
 * required `session.active` (so a mark set while online vanished the moment the
 * wrapper exited). That is exactly the run most worth a reminder.
 *
 *  - Marking: leaving work counts whether the session is still online or not —
 *    going offline mid-turn also means "the run is over, go look".
 *  - Showing: an offline session is NOT history; only a deliberate archive is
 *    (`archivedAt`, server-owned user intent, B-265). That is what B-312's
 *    `active` gate meant to keep out of the archived list.
 */
import type { Session } from './storageTypes';

type TransitionSession = Pick<Session, 'thinking' | 'presence' | 'agentState'>;

function hasPendingRequests(session: TransitionSession): boolean {
    const requests = session.agentState?.requests;
    return !!requests && Object.keys(requests).length > 0;
}

/** `prev` was working (thinking or waiting on a permission) and `next` no longer is. */
export function finishedWork(prev: TransitionSession, next: TransitionSession): boolean {
    const wasActive = prev.thinking === true || hasPendingRequests(prev);
    if (!wasActive) return false;
    if (next.presence !== 'online') return true;
    return next.thinking !== true && !hasPendingRequests(next);
}

/** Whether the sidebar paints the unread dot for this session row. */
export function showsUnreadDot(session: Pick<Session, 'id' | 'archivedAt'> | null | undefined, unreadIds: ReadonlySet<string>): boolean {
    return !!session && unreadIds.has(session.id) && session.archivedAt == null;
}
