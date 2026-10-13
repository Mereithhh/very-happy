/**
 * B-563: where may the transcript's pending AskUserQuestion be answered?
 * Same rule PermissionCard renders by (pendingDockRequestIds), plus B-105:
 * a terminal mirror is read-only everywhere on the web.
 */
import { useSession } from '@/sync/storage';
import { isMirrorSession } from '@/assistant/assistantSession';
import { pendingDockRequestIds, transcriptQuestionPlacement, type TranscriptQuestionPlacement } from './permissionDock';

export function useTranscriptQuestionPlacement(sessionId: string | undefined, requestId: string | null): TranscriptQuestionPlacement {
    const session = useSession(sessionId ?? '');
    return transcriptQuestionPlacement({
        mirror: !!session && isMirrorSession(session),
        pendingIds: pendingDockRequestIds(session?.agentState?.requests, session?.agentState?.completedRequests),
        requestId,
    });
}
