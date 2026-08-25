const ARCHIVE_ACTIVITY_HOLD_MS = 5_000;
const holds = new Map<string, number>();

/** Keep a stale in-flight activity event from resurrecting a row immediately
 * after the user archived it. The hold is deliberately short: a deliberate
 * resume later in the same tab must become visible normally. */
export function holdSessionInactive(sessionId: string, now = Date.now()): void {
  holds.set(sessionId, now + ARCHIVE_ACTIVITY_HOLD_MS);
}

export function releaseSessionInactive(sessionId: string): void {
  holds.delete(sessionId);
}

export function applySessionInactiveHold<T extends { id: string; active: boolean }>(
  session: T,
  now = Date.now(),
): T {
  const until = holds.get(session.id);
  if (until === undefined) return session;
  if (until <= now) {
    holds.delete(session.id);
    return session;
  }
  return session.active ? { ...session, active: false } : session;
}

export function resetSessionInactiveHoldsForTest(): void {
  holds.clear();
}
