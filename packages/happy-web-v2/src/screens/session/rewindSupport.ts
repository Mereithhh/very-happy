import { ATTACHMENT_REUSE_CAPABILITY, CODEX_REWIND_CAPABILITY } from '@slopus/happy-wire';
import type { Session } from '@/sync/storageTypes';
import type { UserTextMessage } from '@/sync/typesMessage';
import type { TurnSendStatus } from './sendStatusModel';

/**
 * B-528 / B-961: who gets in-place edit / delete / retry on a prompt. Owner
 * only (session RPC; a grantee only reads, B-619), a server-confirmed prompt.
 * Claude: every wrapper with `conversation-rewind` (old ones answer "method
 * not found" and the row explains). Codex: only wrappers that advertise
 * `codex-rewind-v1` (AGENTS #14 — capabilities, never CLI versions).
 */
export function canRewindMessage(
    session: Pick<Session, 'metadata' | 'share'> | null | undefined,
    userMessage: Pick<UserTextMessage, 'seq'> | undefined,
    send: TurnSendStatus | null,
): boolean {
    if (!userMessage || send || typeof userMessage.seq !== 'number' || session?.share) return false;
    const flavor = session?.metadata?.flavor ?? 'claude';
    if (flavor === 'claude') return true;
    return flavor === 'codex' && session?.metadata?.capabilities?.includes(CODEX_REWIND_CAPABILITY) === true;
}

/**
 * B-961: a Codex prompt that is not the first of its turn (batched behind the
 * previous one, steered into it): Codex can only cut before a turn, so it is
 * edited / retried through the turn's first prompt.
 */
export function isCodexTurnFollower(
    session: Pick<Session, 'metadata'> | null | undefined,
    userMessage: Pick<UserTextMessage, 'localId'> | undefined,
): boolean {
    if (session?.metadata?.flavor !== 'codex' || !userMessage?.localId) return false;
    return session.metadata.codexTurnFollowers?.includes(userMessage.localId) === true;
}

/**
 * B-961: the prompt a retry on the latest reply resends — the newest user
 * prompt (newest-first list) that opens its turn. Null when there is none.
 */
export function latestRetryTarget<M extends { kind: string; localId?: string | null }>(
    session: Pick<Session, 'metadata'> | null | undefined,
    newestFirst: readonly M[],
): M | null {
    for (const message of newestFirst) {
        if (message.kind !== 'user-text') continue;
        if (isCodexTurnFollower(session, message as Pick<UserTextMessage, 'localId'>)) continue;
        return message;
    }
    return null;
}

/**
 * B-961b: a prompt with attachments is retried / edited only on wrappers that
 * can re-send them by reference (`attachment-reuse-v1`). An older wrapper
 * keeps hiding the actions — it would drop the files silently.
 */
export function supportsAttachmentReuse(
    session: Pick<Session, 'metadata'> | null | undefined,
): boolean {
    return session?.metadata?.capabilities?.includes(ATTACHMENT_REUSE_CAPABILITY) === true;
}

/** Retry resends the prompt's text and its original attachments (B-961b). */
export function canRetryMessage(canRewind: boolean, hasAttachments: boolean, text: string, attachmentsReusable = false): boolean {
    if (!canRewind || text.trim().length === 0) return false;
    return !hasAttachments || attachmentsReusable;
}
