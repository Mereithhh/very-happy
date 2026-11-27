/** B-980 pure rules for the model-answer feedback buttons (no React, no stores). */
import type { Session } from '@/sync/storageTypes';
import type { AgentTextMessage } from '@/sync/typesMessage';
import { readSessionAgentProfile } from '@/sync/agentProfiles';

export type ModelFeedbackRating = 'up' | 'down';
export type ModelFeedbackConfigView = { modelFeedback?: { enabled: boolean; scope: 'tagged' | 'all' } | null } | null;

/** Pure: whether this answer gets the buttons. */
export function showsModelFeedback(config: ModelFeedbackConfigView, message: Pick<AgentTextMessage, 'turnId' | 'modelRequestIds'>): boolean {
    const fb = config?.modelFeedback;
    if (!fb?.enabled || !message.turnId) return false;
    return fb.scope === 'all' || (message.modelRequestIds?.length ?? 0) > 0;
}

/** Pure: the submit body for a rating (ids the gateway joins on + what the session ran). */
export function modelFeedbackBody(session: Session | null | undefined, message: AgentTextMessage, sessionId: string, rating: ModelFeedbackRating, comment?: string) {
    const profile = readSessionAgentProfile(session?.metadata?.agentProfile);
    return {
        sessionId,
        turnId: message.turnId!,
        rating,
        ...(comment?.trim() ? { comment: comment.trim() } : {}),
        requestIds: message.modelRequestIds ?? [],
        model: message.meta?.model ?? profile?.model ?? session?.metadata?.currentModelCode ?? null,
        reportedModel: message.meta?.reportedModel ?? null,
        agent: session?.metadata?.flavor ?? null,
        accountProfile: profile ? { id: profile.id, label: profile.label, kind: profile.kind } : null,
        messageSeq: message.seq ?? null,
        answeredAt: message.createdAt,
    };
}

