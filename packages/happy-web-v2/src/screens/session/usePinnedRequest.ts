/**
 * B-563: is this pending request shown — and answerable — in the dock above the
 * composer? Same rule PermissionCard renders by: the id is in
 * agentState.requests and the session is not a read-only terminal mirror.
 * The transcript uses it to avoid a second actionable copy.
 */
import { useSession } from '@/sync/storage';
import { isMirrorSession } from '@/assistant/assistantSession';

export function usePinnedRequest(sessionId: string | undefined, requestId: string | null): boolean {
    const session = useSession(sessionId ?? '');
    if (!session || !requestId || isMirrorSession(session)) return false;
    return Object.prototype.hasOwnProperty.call(session.agentState?.requests ?? {}, requestId);
}
