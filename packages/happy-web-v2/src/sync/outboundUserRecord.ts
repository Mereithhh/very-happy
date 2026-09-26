import type { MessageModeMeta } from './messageMeta';
import type { RawRecord } from './typesRaw';

/**
 * The user `RawRecord` the web sends for typed input — shared by the direct
 * send path (`sync.sendMessage`) and the server-side prompt queue (B-509), so
 * a prompt the wrapper dispatches from the queue later is byte-for-byte the
 * record the user would have sent by hand at that moment (minus the tab-local
 * `queuedAt` / `delivery` stamps, which only describe a live send).
 */
export type OutboundUserRecordInput = {
    text: string;
    sentFrom: string;
    appendSystemPrompt?: string;
    modeMeta: MessageModeMeta;
    delivery?: 'queue' | 'steer';
    displayText?: string;
    queuedAt?: number;
};

export function buildOutboundUserRecord(input: OutboundUserRecordInput): RawRecord {
    const { modeMeta } = input;
    return {
        role: 'user',
        content: {
            type: 'text',
            text: input.text,
        },
        meta: {
            sentFrom: input.sentFrom,
            ...(input.appendSystemPrompt !== undefined ? { appendSystemPrompt: input.appendSystemPrompt } : {}),
            ...(modeMeta.permissionMode !== undefined ? { permissionMode: modeMeta.permissionMode } : {}),
            ...(modeMeta.model !== undefined ? { model: modeMeta.model } : {}),
            ...(modeMeta.effort !== undefined ? { effort: modeMeta.effort } : {}),
            ...(input.delivery === 'steer' ? { delivery: input.delivery } : {}),
            ...(input.displayText ? { displayText: input.displayText } : {}),
            ...(input.queuedAt !== undefined ? { queuedAt: input.queuedAt } : {}),
        },
    };
}

/** Read a queued record back for display / editing (null = not a user text record). */
export function readOutboundUserRecord(record: unknown): { text: string; modeMeta: MessageModeMeta } | null {
    if (!record || typeof record !== 'object') return null;
    const candidate = record as { role?: unknown; content?: { type?: unknown; text?: unknown }; meta?: Record<string, unknown> };
    if (candidate.role !== 'user' || candidate.content?.type !== 'text' || typeof candidate.content.text !== 'string') return null;
    const meta = candidate.meta ?? {};
    const modeMeta: MessageModeMeta = {};
    if (typeof meta.permissionMode === 'string') modeMeta.permissionMode = meta.permissionMode as MessageModeMeta['permissionMode'];
    if ('model' in meta && (typeof meta.model === 'string' || meta.model === null)) modeMeta.model = meta.model;
    if ('effort' in meta && (typeof meta.effort === 'string' || meta.effort === null)) modeMeta.effort = meta.effort;
    return { text: candidate.content.text, modeMeta };
}
