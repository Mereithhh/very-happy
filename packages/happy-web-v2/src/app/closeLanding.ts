/**
 * B-933: remember where an archive/close flow is about to land you, so the
 * landing page does not act on the user's behalf.
 *
 * Incident (B-932): ⌘W archived a session, the web jumped to the next session
 * in the same place (B-111 `nextSessionPathAfterClose`), and that page's
 * B-587 open-wake resumed it at once. The next ⌘W then archived a session the
 * user had not looked at yet (the long-lived daily-report session).
 *
 * The landing is a SHOW, not an OPEN: `useHibernationAutoWake` skips its
 * open-wake for a session reached this way (sending a message or the banner's
 * 「唤醒」 still wake it). Pure module state, no store — the mark is written
 * right before the navigate and read when the screen sees the new id.
 */

/** How long after the mark the landing screen may still claim it. */
export const CLOSE_LANDING_WINDOW_MS = 3_000;

let lastLanding: { sessionId: string; at: number } | null = null;

/** Record the route an archive/close flow is about to navigate to. Non-session routes clear the mark. */
export function markCloseLanding(path: string, now: number = Date.now()): void {
    const match = /^\/session\/([^/?#]+)/.exec(path);
    lastLanding = match ? { sessionId: decodeURIComponent(match[1]), at: now } : null;
}

/** Was `sessionId` just reached by an archive/close landing (not opened by the user)? */
export function isCloseLanding(sessionId: string, now: number = Date.now()): boolean {
    return !!lastLanding && lastLanding.sessionId === sessionId && now - lastLanding.at >= 0 && now - lastLanding.at <= CLOSE_LANDING_WINDOW_MS;
}

export function resetCloseLandingForTest(): void {
    lastLanding = null;
}
