import { normalizeClaudeOutboundMode } from '@/sync/permissionModeOutbound';
import type { Session } from '@/sync/storageTypes';
import type { UserTextMessage } from '@/sync/typesMessage';
import { getSessionForkSource, type ForkSource } from '@/utils/sessionFork';

/** `pointId` is absent for prompts sent from the Web; forkFlow resolves it from the machine's transcript. */
export type RewindTarget = { source: ForkSource; messageId?: string; pointId?: string };
export type RewindUnavailable = 'unsupported' | 'attachments' | 'pending' | 'running';
export function getRewindTarget(session: Session | null | undefined, message: UserTextMessage, hasAttachments: boolean, running: boolean): RewindTarget | RewindUnavailable {
    if (!session || !['claude', 'codex'].includes(session.metadata?.flavor ?? 'claude')) return 'unsupported';
    const source = getSessionForkSource(session);
    if (!source) return 'unsupported';
    if (hasAttachments) return 'attachments';
    if (message.inputState || message.cancelReason || message.seq == null) return 'pending';
    if (running) return 'running';
    const pointId = source.kind === 'codex' ? message.codexItemId : message.claudeUuid;
    return { source, messageId: message.id, ...(pointId ? { pointId } : {}) };
}
function quoteLines(text: string): string {
    return text.split('\n').map((line) => `> ${line}`).join('\n');
}

export function appendMessageQuote(draft: string, text: string): string {
    const quote = quoteLines(text);
    return `${draft.trimEnd()}${draft.trim() ? '\n\n' : ''}${quote}\n\n`;
}

/**
 * B-577: the same quote block, put where the caret is (replacing any selected
 * draft text) instead of at the end. A blank line separates it from text on
 * either side; the caret lands on the blank line after it, ready for the reply.
 */
export function insertMessageQuoteAt(draft: string, text: string, start: number, end: number): { text: string; caret: number } {
    const from = Math.max(0, Math.min(start, end, draft.length));
    const to = Math.max(from, Math.min(Math.max(start, end), draft.length));
    const before = draft.slice(0, from);
    const after = draft.slice(to).replace(/^\n+/, '');
    const lead = !before.trim() ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const head = `${before.trim() ? before : ''}${lead}${quoteLines(text)}\n\n`;
    return { text: `${head}${after}`, caret: head.length };
}

export function rewindPermissionMode(kind: 'claude' | 'codex', mode: string | null | undefined): string {
    if (kind === 'claude') return normalizeClaudeOutboundMode(mode ?? null) ?? 'default';
    return mode && ['default', 'read-only', 'safe-yolo', 'yolo'].includes(mode) ? mode : 'read-only';
}
