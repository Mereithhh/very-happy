/**
 * B-619: what the current account may do with a session. Pure; the only
 * place the web decides owner / driver / viewer, so every gate (composer,
 * permission card, header menu, sidebar row menu, yolo enforcement) reads
 * the same answer. Mirrors the server's resolveSessionAccess — the server
 * is the authority, this only shapes the UI.
 */
import type { Session } from '@/sync/storageTypes';

export type SessionAccess = 'owner' | 'driver' | 'viewer';

export function sessionAccess(session: Pick<Session, 'share'> | null | undefined): SessionAccess {
    const share = session?.share;
    if (!share) return 'owner';
    return share.role === 'driver' ? 'driver' : 'viewer';
}

export function isSharedWithMe(session: Pick<Session, 'share'> | null | undefined): boolean {
    return !!session?.share;
}

/** The composer / send path a grantee gets. Owners keep the full AgentInput. */
export function canSendAsGrantee(session: Pick<Session, 'share'> | null | undefined): boolean {
    return sessionAccess(session) === 'driver';
}
