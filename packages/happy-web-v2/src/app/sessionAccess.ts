/**
 * B-619: what the current account may do with a session. Pure; the only
 * place the web decides owner / driver / viewer, so every gate (composer,
 * permission card, header menu, sidebar row menu, yolo enforcement) reads
 * the same answer. Mirrors the server's resolveSessionAccess — the server
 * is the authority, this only shapes the UI.
 */
import type { Session } from '@/sync/storageTypes';

export type SessionAccess = 'owner' | 'operator' | 'driver' | 'viewer';

export function sessionAccess(session: Pick<Session, 'share'> | null | undefined): SessionAccess {
    const share = session?.share;
    if (!share) return 'owner';
    if (share.role === 'driver') return share.operate === true ? 'operator' : 'driver';
    return 'viewer';
}

export function isSharedWithMe(session: Pick<Session, 'share'> | null | undefined): boolean {
    return !!session?.share;
}

/** The composer / send path a grantee gets. Owners keep the full AgentInput. */
export function canSendAsGrantee(session: Pick<Session, 'share'> | null | undefined): boolean {
    const access = sessionAccess(session);
    return access === 'driver' || access === 'operator';
}

/**
 * B-867: a grantee holding the operator tier (role driver + operate). The
 * server broker is the authority; this only decides which controls render
 * and whether sessionRPC routes through `operator-rpc` instead of refusing.
 */
export function canOperate(session: Pick<Session, 'share'> | null | undefined): boolean {
    return sessionAccess(session) === 'operator';
}
