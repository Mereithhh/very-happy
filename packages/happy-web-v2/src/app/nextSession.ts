/**
 * nextSession — where to land after closing (archiving) a session (B-111).
 *
 * "Next" = the most recently active VISIBLE session other than the one just
 * closed: active only (an archive flow must not land you on another archived
 * row), hidden sessions excluded (assistant meta / terminal mirrors — the
 * same predicate every list uses), recency by activeAt. Deliberately NOT the
 * sidebar's exact visual order: that order lives inside the Sidebar component
 * (manual pins / grouping modes) and reproducing it here would couple three
 * imperative call sites to component state — "your most recent other
 * conversation" is the stable, predictable landing spot.
 *
 * Pure; unit-tested.
 */
import type { Session } from '@/sync/storageTypes';
import { isHiddenSession } from '@/assistant/assistantSession';

export function pickNextSessionId(
    sessions: ReadonlyArray<Session>,
    closedId: string,
): string | null {
    let best: Session | null = null;
    for (const s of sessions) {
        if (!s || s.id === closedId) continue;
        if (!s.active) continue;
        if (isHiddenSession(s)) continue;
        if (!best || (s.activeAt ?? 0) > (best.activeAt ?? 0)) best = s;
    }
    return best?.id ?? null;
}
