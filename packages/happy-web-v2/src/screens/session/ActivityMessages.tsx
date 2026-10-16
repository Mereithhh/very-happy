import { useMemo } from 'react';
import type { Message } from '@/sync/typesMessage';
import { buildLeafRows, type LeafRow } from './chatTurns';
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
    // B-614: consecutive tool rows share ONE card (`.tg-stack`) so a turn's
    // work reads as a visible structure; prose and thinking stay on the canvas.
    const blocks = useMemo(() => stackToolRows(rows), [rows]);
    return <SubagentNavigationContext.Provider value={subagentNavigation ?? inheritedNavigation}>{blocks.map(block => block.kind === 'stack'
        ? <div key={block.key} className="tg-stack">{block.groups.map(row =>
            <ToolGroupView key={row.key} tools={row.tools} collapseCompleted stalled={stalled} abortedAt={abortedAt} />)}</div>
        : <MessageView key={block.row.key} message={block.row.message} sessionId={sessionId}
            showMeta={false} showActions={false} thinkingDurationMs={block.row.thinkingDurationMs} />)}</SubagentNavigationContext.Provider>;
}

type ToolRow = Extract<LeafRow, { type: 'toolgroup' }>;
type MessageRow = Exclude<LeafRow, { type: 'toolgroup' }>;
export type ActivityBlock = { kind: 'stack'; key: string; groups: ToolRow[] } | { kind: 'row'; row: MessageRow };

/** B-614: group runs of consecutive tool rows; order is preserved exactly. */
export function stackToolRows(rows: LeafRow[]): ActivityBlock[] {
    const out: ActivityBlock[] = [];
    for (const row of rows) {
        const last = out[out.length - 1];
        if (row.type !== 'toolgroup') out.push({ kind: 'row', row });
        else if (last?.kind === 'stack') last.groups.push(row);
        else out.push({ kind: 'stack', key: `stack-${row.key}`, groups: [row] });
    }
    return out;
}
