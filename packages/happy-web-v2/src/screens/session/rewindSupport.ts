import { CODEX_REWIND_CAPABILITY } from '@slopus/happy-wire';
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

/** Retry resends the prompt's text only — a prompt with attachments would lose them. */
export function canRetryMessage(canRewind: boolean, hasAttachments: boolean, text: string): boolean {
    return canRewind && !hasAttachments && text.trim().length > 0;
}
