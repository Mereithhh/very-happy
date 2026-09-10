import { useMemo } from 'react';
import type { Message } from '@/sync/typesMessage';
import { buildLeafRows } from './chatTurns';
import { MessageView } from './MessageView';
import { ToolGroupView } from './ToolGroupView';
import { SubagentNavigationContext, useSubagentNavigation } from './subagentNavigation';

/** Shared process renderer for the main turn and subagents. Input is chronological. */
export function ActivityMessages({ messages, sessionId, stalled = false, abortedAt = null, subagentNavigation }: {
    messages: Message[];
    sessionId: string;
    stalled?: boolean;
    abortedAt?: number | null;
    subagentNavigation?: 'session' | 'inline';
}) {
    const inheritedNavigation = useSubagentNavigation();
    const rows = useMemo(() => buildLeafRows(messages, null, 'completed-terminal', false), [messages]);
    return <SubagentNavigationContext.Provider value={subagentNavigation ?? inheritedNavigation}>{rows.map(row => row.type === 'toolgroup'
        ? <ToolGroupView key={row.key} tools={row.tools} collapseCompleted stalled={stalled} abortedAt={abortedAt} />
        : <MessageView key={row.key} message={row.message} sessionId={sessionId}
            showMeta={false} showActions={false} thinkingDurationMs={row.thinkingDurationMs} />)}</SubagentNavigationContext.Provider>;
}
