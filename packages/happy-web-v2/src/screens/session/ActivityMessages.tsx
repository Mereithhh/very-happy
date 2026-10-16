import { useMemo } from 'react';
import type { Message } from '@/sync/typesMessage';
import { buildLeafRows, type HeldAnswer } from './chatTurns';
import { MessageView } from './MessageView';
import { ToolGroupView } from './ToolGroupView';
import { SubagentNavigationContext, useSubagentNavigation } from './subagentNavigation';

/** Shared process renderer for the main turn and subagents. Input is chronological. */
export function ActivityMessages({ messages, sessionId, stalled = false, abortedAt = null, subagentNavigation, answer }: {
    messages: Message[];
    sessionId: string;
    stalled?: boolean;
    abortedAt?: number | null;
    subagentNavigation?: 'session' | 'inline';
    /** B-615: a finished turn's answer held in here renders as its own row would
     *  (actions, meta, suggestions) — same node, so nothing moves under the reader. */
    answer?: HeldAnswer;
}) {
    const inheritedNavigation = useSubagentNavigation();
    const rows = useMemo(() => buildLeafRows(messages, null, 'completed-terminal', false), [messages]);
    return <SubagentNavigationContext.Provider value={subagentNavigation ?? inheritedNavigation}>{rows.map(row => {
        if (row.type === 'toolgroup') {
            return <ToolGroupView key={row.key} tools={row.tools} collapseCompleted stalled={stalled} abortedAt={abortedAt} />;
        }
        const held = answer?.id === row.message.id ? answer : null;
        return <MessageView key={row.key} message={row.message} sessionId={sessionId}
            showMeta={held?.showMeta ?? false} showActions={held?.showActions ?? false}
            optionsActive={held?.optionsActive ?? false} thinkingDurationMs={row.thinkingDurationMs} />;
    })}</SubagentNavigationContext.Provider>;
}
