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
 * B-774 (QA4 O2 / QA5 O5): the jump stays inside the closed session's own
 * place. A team conversation lands on its team page — never on another
 * member's, another team's or an unrelated conversation; a project session
 * picks only from the same project (else the project page); a session in no
 * project picks only from sessions in no project and no team. A session shared
 * with this account is never a landing spot. Unknown placement (projects not
 * loaded) lands on '/'.
 *
 * Pure; unit-tested.
 */
import type { Session } from '@/sync/storageTypes';
import { isHiddenSession } from '@/assistant/assistantSession';
import type { SessionPlacement } from './sessionPlacement';

export function pickNextSessionId(
    sessions: ReadonlyArray<Session>,
    closedId: string,
    inScope: (s: Session) => boolean = () => true,
): string | null {
    let best: Session | null = null;
    for (const s of sessions) {
        if (!s || s.id === closedId) continue;
        if (!s.active) continue;
        if (isHiddenSession(s)) continue;
        if (s.share) continue;
        if (!inScope(s)) continue;
        if (!best || (s.activeAt ?? 0) > (best.activeAt ?? 0)) best = s;
    }
    return best?.id ?? null;
}

export function nextPathAfterClose(
    sessions: ReadonlyArray<Session>,
    closedId: string,
    ctx: {
        /** null while the project list is unknown (loading / failed). */
        placementOf: ((sessionId: string) => SessionPlacement) | null;
        teamHref: (teamId: string) => string;
        projectHref: (projectId: string) => string;
    },
): string {
    if (!ctx.placementOf) return '/';
    const placementOf = ctx.placementOf;
    const closed = placementOf(closedId);
    if (closed.teamId) return ctx.teamHref(closed.teamId);
    const next = pickNextSessionId(sessions, closedId, (s) => {
        const p = placementOf(s.id);
        return !p.teamId && p.projectId === closed.projectId;
    });
    if (next) return `/session/${next}`;
    return closed.projectId ? ctx.projectHref(closed.projectId) : '/';
}
