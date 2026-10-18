/**
 * B-629: pi-acp (0.0.33, dist/index.js) has no ACP frame for pi's own provider retries,
 * automatic compaction, unsupported extension dialogs or `notify` calls — it sends each as an
 * `agent_message_chunk`, which our mapper would glue into the assistant's answer ("Retrying
 * (attempt 1/3…)" inside the reply). These are the exact strings it emits, recognized whole so
 * the runner can show them as service lines instead (Orca shows pi retries as an activity row,
 * src/main/pi/rpc-retry-activity.ts). A `notify` chunk carries `_meta.piAcp.notify`.
 */

export type AcpNoticeKind = 'retry' | 'retry-end' | 'compaction' | 'compaction-end' | 'unsupported' | 'notify';

export type AcpNotice = { kind: AcpNoticeKind; text: string; level?: string };

const PI_ACP_RETRY = /^Retrying(?: \(attempt \d+\/\d+, waiting \d+s\))?\.\.\.$/;
const PI_ACP_RETRY_END = 'Retry finished, resuming.';
const PI_ACP_COMPACTION = 'Context nearing limit, running automatic compaction...';
const PI_ACP_COMPACTION_END = 'Automatic compaction finished; context was summarized to continue the session.';
const PI_ACP_UNSUPPORTED = /^Pi (input|editor) UI request is not supported in ACP yet; cancelling it\.$/;

function notifyMeta(meta: unknown): { level?: string } | null {
    if (!meta || typeof meta !== 'object') return null;
    const piAcp = (meta as { piAcp?: unknown }).piAcp;
    if (!piAcp || typeof piAcp !== 'object') return null;
    const notify = (piAcp as { notify?: unknown }).notify;
    if (!notify || typeof notify !== 'object') return null;
    const level = (notify as { level?: unknown }).level;
    return { ...(typeof level === 'string' ? { level } : {}) };
}

/** The notice a pi-acp text chunk is, or null for ordinary model output. */
export function classifyPiAcpNotice(text: string, meta?: unknown): AcpNotice | null {
    const notify = notifyMeta(meta);
    if (notify) return { kind: 'notify', text: text.trim(), ...(notify.level ? { level: notify.level } : {}) };
    const trimmed = text.trim();
    if (PI_ACP_RETRY.test(trimmed)) return { kind: 'retry', text: trimmed };
    if (trimmed === PI_ACP_RETRY_END) return { kind: 'retry-end', text: trimmed };
    if (trimmed === PI_ACP_COMPACTION) return { kind: 'compaction', text: trimmed };
    if (trimmed === PI_ACP_COMPACTION_END) return { kind: 'compaction-end', text: trimmed };
    if (PI_ACP_UNSUPPORTED.test(trimmed)) return { kind: 'unsupported', text: trimmed };
    return null;
}

/** The service line the web shows for a notice, prefixed with the agent so it reads as the wrapper's. */
export function acpNoticeMessage(agentName: string, notice: AcpNotice): string {
    switch (notice.kind) {
        case 'retry':
            return `${agentName} is retrying the model request${notice.text.startsWith('Retrying (') ? ` ${notice.text.slice('Retrying '.length).replace(/\.\.\.$/, '')}` : ''}`;
        case 'retry-end':
            return `${agentName} retry finished, resuming`;
        case 'compaction':
            return `${agentName} is compacting its context (nearing the limit)`;
        case 'compaction-end':
            return `${agentName} compacted its context; the session continues on a summary`;
        case 'unsupported':
            return `${agentName}: ${notice.text}`;
        case 'notify':
            return `${agentName}${notice.level && notice.level !== 'info' ? ` ${notice.level}` : ''}: ${notice.text}`;
    }
}
