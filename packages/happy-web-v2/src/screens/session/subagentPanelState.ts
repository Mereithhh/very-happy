/**
 * Imperative "open the sub-agent drawer" hook (B-317) — same window-event
 * singleton as btwPanelState: a tool row deep inside the transcript must not
 * grow a props chain up to SessionDetailScreen just to flip one URL param.
 */
const OPEN_EVENT = 'vh:subagent-open';

export interface SubagentOpenDetail {
    sessionId: string;
    /** id of the Agent/Task tool-call message to show */
    messageId: string;
}

export function openSubagentPanel(sessionId: string, messageId: string): void {
    window.dispatchEvent(new CustomEvent<SubagentOpenDetail>(OPEN_EVENT, { detail: { sessionId, messageId } }));
}

export function onSubagentOpen(cb: (detail: SubagentOpenDetail) => void): () => void {
    const handler = (event: Event) => {
        const detail = (event as CustomEvent<SubagentOpenDetail>).detail;
        if (detail && typeof detail.sessionId === 'string' && typeof detail.messageId === 'string') cb(detail);
    };
    window.addEventListener(OPEN_EVENT, handler);
    return () => window.removeEventListener(OPEN_EVENT, handler);
}
