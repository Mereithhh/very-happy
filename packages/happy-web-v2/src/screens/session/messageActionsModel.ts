import { normalizeClaudeOutboundMode } from '@/sync/permissionModeOutbound';
import type { Session } from '@/sync/storageTypes';
import type { UserTextMessage } from '@/sync/typesMessage';
import { getSessionForkSource, type ForkSource } from '@/utils/sessionFork';

export type RewindTarget = { source: ForkSource; messageId?: string; pointId: string };
export type RewindUnavailable = 'unsupported' | 'missingPoint' | 'attachments' | 'pending' | 'running';
export function getRewindTarget(session: Session | null | undefined, message: UserTextMessage, hasAttachments: boolean, running: boolean): RewindTarget | RewindUnavailable {
    if (!session || !['claude', 'codex'].includes(session.metadata?.flavor ?? 'claude')) return 'unsupported';
    const source = getSessionForkSource(session);
    if (!source) return 'unsupported';
    if (hasAttachments) return 'attachments';
    if (message.inputState || message.cancelReason || message.seq == null) return 'pending';
    if (running) return 'running';
    const pointId = source.kind === 'codex' ? message.codexItemId : message.claudeUuid;
    if (!pointId) return 'missingPoint';
    return { source, messageId: message.id, pointId };
}
export function appendMessageQuote(draft: string, text: string): string {
    const quote = text.split('\n').map((line) => `> ${line}`).join('\n');
    return `${draft.trimEnd()}${draft.trim() ? '\n\n' : ''}${quote}\n\n`;
}

export function rewindPermissionMode(kind: 'claude' | 'codex', mode: string | null | undefined): string {
    if (kind === 'claude') return normalizeClaudeOutboundMode(mode ?? null) ?? 'default';
    return mode && ['default', 'read-only', 'safe-yolo', 'yolo'].includes(mode) ? mode : 'read-only';
}
