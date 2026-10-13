/**
 * B-587 — idle agent hibernation, web side (spec
 * `specs/2026-10-idle-agent-hibernation.md` §5). Pure: no store / network.
 *
 * A hibernated session is an OFFLINE session (active=false, not archived)
 * whose last wrapper stamped `metadata.hibernation` on the way out. Only new
 * CLIs write the stamp, so nothing here ever fires against an old CLI — the
 * gate is the data itself plus the session capability (AGENTS #14).
 */
import type { Session } from '@/sync/storageTypes';

/** Session capability: the wrapper checks in for hibernation and honours keepAwake. */
export const HIBERNATION_CAPABILITY = 'agent-hibernation-v1';
/** A stamp older than the last heartbeat by more than this is stale (downgraded CLI resumed it). */
export const HIBERNATION_STAMP_SLACK_MS = 5 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
/** Machine-page choices (0 = off). */
export const HIBERNATION_IDLE_CHOICES_MS: readonly number[] = [0, 1 * HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS, 24 * HOUR_MS];

export type HibernationSession = Pick<Session, 'active' | 'archivedAt' | 'metadata'> & { activeAt?: number };

export interface HibernationStamp {
    at: number;
}

export function readHibernationStamp(metadata: unknown): HibernationStamp | null {
    const raw = (metadata as { hibernation?: unknown } | null | undefined)?.hibernation;
    if (!raw || typeof raw !== 'object') return null;
    const { at } = raw as { at?: unknown };
    if (typeof at !== 'number' || !Number.isFinite(at)) return null;
    return { at };
}

/** Offline because its wrapper hibernated (restorable; wakes on open / send). */
export function isHibernated(session: HibernationSession | null | undefined): boolean {
    if (!session || session.active || session.archivedAt != null) return false;
    const stamp = readHibernationStamp(session.metadata);
    if (!stamp) return false;
    // An old CLI that resumed a hibernated session never clears the stamp; once
    // that process has heartbeat past it, the stamp no longer describes the row.
    if (typeof session.activeAt === 'number' && session.activeAt > stamp.at + HIBERNATION_STAMP_SLACK_MS) return false;
    return true;
}

export function supportsKeepAwake(metadata: { capabilities?: string[] } | null | undefined): boolean {
    return Array.isArray(metadata?.capabilities) && metadata!.capabilities!.includes(HIBERNATION_CAPABILITY);
}

/** daemonState capability + current setting; null = this daemon cannot hibernate (old CLI / stale field). */
export function readMachineHibernation(daemonState: unknown): { idleMs: number } | null {
    const state = daemonState as { startedAt?: unknown; agentHibernation?: { idleMs?: unknown; rpcAvailable?: unknown; detectedAt?: unknown } } | null | undefined;
    const h = state?.agentHibernation;
    if (!h || h.rpcAvailable !== true || typeof h.idleMs !== 'number' || typeof h.detectedAt !== 'number') return null;
    // Same trust rule as every daemonState capability: written by THIS daemon run.
    if (typeof state?.startedAt === 'number' && h.detectedAt < state.startedAt) return null;
    return { idleMs: h.idleMs };
}

/**
 * Auto-wake dedupe: one automatic attempt per hibernation (session + stamp),
 * never a retry loop — a failure is left to the banner's Retry.
 */
export function autoWakeKey(sessionId: string, session: HibernationSession | null | undefined): string | null {
    if (!isHibernated(session)) return null;
    return `${sessionId}:${readHibernationStamp(session!.metadata)!.at}`;
}

export function shouldAutoWake(input: {
    sessionId: string;
    session: HibernationSession | null | undefined;
    machineOnline: boolean;
    restoreBusy: boolean;
    attempted: ReadonlySet<string>;
    /** When the user opened this session on this screen (route change). */
    openedAt: number;
}): string | null {
    const key = autoWakeKey(input.sessionId, input.session);
    if (!key || !input.machineOnline || input.restoreBusy || input.attempted.has(key)) return null;
    // Opening wakes; hibernating WHILE on screen does not — otherwise a tab
    // left open would keep its session awake forever. The next send wakes it.
    if (readHibernationStamp(input.session!.metadata)!.at > input.openedAt) return null;
    return key;
}
