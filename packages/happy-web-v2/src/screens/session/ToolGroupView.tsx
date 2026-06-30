/**
 * ToolGroupView — a run of consecutive tool calls rendered as a single
 * collapsible block with a mono font and a teal accent left-spine. The spine
 * color encodes state: teal=running, danger=error, warn=mixed, line=done.
 */
import { useEffect, useState } from 'react';
import { ChevronRight, AlertTriangle } from 'lucide-react';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { useTranslation } from '@/i18n/useTranslation';
import { StatusDot } from '@/ui';
import { ToolView } from './ToolView';
import { toolTitle } from './toolInfo';
import { useElapsedSeconds } from './useElapsed';
import { formatElapsed } from './format';
import './toolgroup.css';

type GroupState = 'running' | 'error' | 'mixed' | 'done';

function groupState(tools: ToolCallMessage[]): GroupState {
    const states = tools.map((m) => m.tool.state);
    if (states.some((s) => s === 'running')) return 'running';
    const errors = states.filter((s) => s === 'error').length;
    if (errors === states.length && errors > 0) return 'error';
    if (errors > 0) return 'mixed';
    return 'done';
}

function ToolRow({ message, single }: { message: ToolCallMessage; single: boolean }) {
    const tool = message.tool;
    const [open, setOpen] = useState(single);
    const status =
        tool.state === 'running' ? 'thinking' : tool.state === 'error' ? 'permission' : 'connected';
    return (
        <div className={`tg-row${tool.state === 'error' ? ' tg-row--error' : ''}`}>
            <button type="button" className="tg-row-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
                <ChevronRight size={13} className={`tg-chevron${open ? ' is-open' : ''}`} />
                <StatusDot status={status as any} size={7} pulse={tool.state === 'running'} />
                <span className="tg-tool-name">{toolTitle(tool)}</span>
            </button>
            {open && <ToolView message={message} />}
        </div>
    );
}

export function ToolGroupView({ tools }: { tools: ToolCallMessage[] }) {
    const { t } = useTranslation();
    const state = groupState(tools);
    const running = state === 'running';
    // collapsed by default once done; open while running.
    const [expanded, setExpanded] = useState(running || tools.length === 1);

    useEffect(() => {
        if (running) setExpanded(true);
    }, [running]);

    const runningStarted = running
        ? Math.min(...tools.filter((m) => m.tool.state === 'running').map((m) => m.tool.startedAt ?? m.tool.createdAt))
        : null;
    const elapsed = useElapsedSeconds(running ? runningStarted : null);

    const single = tools.length === 1;
    if (single) {
        // Single tool: render directly with the spine, no group header.
        return (
            <div className={`tg tg--${state}`}>
                <div className="tg-spine" aria-hidden />
                <div className="tg-content">
                    <ToolRow message={tools[0]} single />
                </div>
            </div>
        );
    }

    return (
        <div className={`tg tg--${state}`}>
            <div className="tg-spine" aria-hidden />
            <div className="tg-content">
                <button
                    type="button"
                    className="tg-head"
                    onClick={() => setExpanded((v) => !v)}
                    aria-expanded={expanded}
                >
                    <ChevronRight size={14} className={`tg-chevron${expanded ? ' is-open' : ''}`} />
                    <span className="tg-summary">{t('session.chat.usedTools' as any, { count: tools.length })}</span>
                    {running ? (
                        <span className="tg-elapsed tg-elapsed--live">
                            <StatusDot status="thinking" size={7} pulse />
                            {formatElapsed(elapsed)}
                        </span>
                    ) : state === 'error' || state === 'mixed' ? (
                        <span className="tg-elapsed tg-elapsed--err">
                            <AlertTriangle size={12} />
                            {t('session.chat.toolError' as any)}
                        </span>
                    ) : null}
                </button>
                {expanded && (
                    <div className="tg-rows">
                        {tools.map((m) => (
                            <ToolRow key={m.id} message={m} single={false} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
