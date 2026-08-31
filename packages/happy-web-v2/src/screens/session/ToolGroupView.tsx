/**
 * ToolGroupView — a run of consecutive tool calls rendered as a single
 * collapsible block with a mono font and a teal accent left-spine. The spine
 * color encodes state: teal=running, danger=error, warn=mixed, line=done.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ChevronRight, AlertTriangle, Bot } from 'lucide-react';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { useTranslation } from '@/i18n/useTranslation';
import { StatusDot } from '@/ui';
import { ToolView } from './ToolView';
import { toolLabel, toolDetail } from './toolInfo';
import { toolFilePathOf } from './toolFilePath';
import { FilePathLink } from './FilePathLink';
import { useElapsedSeconds } from './useElapsed';
import { formatElapsed } from './format';
import { useMediaQuery } from '@/app/useMediaQuery';
import { toolRunSummary } from './toolRunSummary';
import { buildSubagentSummary } from './subagentSummary';
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

function ToolRow({
    message,
    defaultOpen,
    collapseOnComplete = false,
}: {
    message: ToolCallMessage;
    defaultOpen: boolean;
    collapseOnComplete?: boolean;
}) {
    const { t } = useTranslation();
    const tool = message.tool;
    // B-260: sub-agent rows are pointers. Their stub tool_result is not a real
    // completion, so they are exempt from collapse-on-complete, keep a neutral
    // glyph instead of a "done" status dot, and carry an always-visible
    // one-line process summary outside the disclosure panel.
    const isSubagent = tool.name === 'Task' || tool.name === 'Agent';
    const subagentSummary = isSubagent ? buildSubagentSummary(message) : null;
    const [open, setOpen] = useState(defaultOpen);
    const wasRunningRef = useRef(tool.state === 'running');
    const bodyId = useId();
    // 与 ToolView 同一手法（它也是 useParams），避免为了一个 id 改整条 props 链
    const { id: sessionId } = useParams();
    // B-145: 带文件路径的工具，头部的 detail 变成可点——点开预览而不是折叠这一行
    const filePath = toolFilePathOf(tool);
    const status =
        tool.state === 'running' ? 'thinking' : tool.state === 'error' ? 'permission' : 'connected';
    const label = toolLabel(tool);
    const detail = toolDetail(tool);
    // A live or failed operation must surface itself even when the mobile
    // overview initially collapsed this row. Turn activity rows fold exactly
    // once on running→completed; legacy tool groups preserve their old state.
    useEffect(() => {
        if (tool.state === 'running' || tool.state === 'error') setOpen(true);
        if (collapseOnComplete && !isSubagent && tool.state === 'completed' && wasRunningRef.current) setOpen(false);
        wasRunningRef.current = tool.state === 'running';
    }, [collapseOnComplete, isSubagent, tool.state]);
    return (
        <div className={`tg-row${tool.state === 'error' ? ' tg-row--error' : ''}`}>
            <div className="tg-row-head-wrap">
                <button type="button" className="tg-row-head vh-disclosure-trigger" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={bodyId}>
                    <ChevronRight size={13} className={`tg-chevron${open ? ' is-open' : ''}`} />
                    {isSubagent && tool.state === 'completed'
                        ? <Bot size={13} className="tg-subagent-glyph" aria-hidden />
                        : <StatusDot status={status as any} size={7} pulse={tool.state === 'running'} />}
                    <span className="tg-tool-label">{label}</span>
                    {detail && detail !== label && !filePath && <span className="tg-tool-detail">{detail}</span>}
                </button>
                {detail && detail !== label && filePath && sessionId && (
                    <FilePathLink path={filePath} sessionId={sessionId} label={detail} className="tg-tool-detail" />
                )}
                {detail && detail !== label && filePath && !sessionId && (
                    <span className="tg-tool-detail">{detail}</span>
                )}
            </div>
            {subagentSummary && subagentSummary.toolCount > 0 && (
                <div className="tg-subagent-line">
                    {t('session.chat.usedTools', { count: subagentSummary.toolCount })}
                    {subagentSummary.recent.length > 0
                        ? ` · ${t('session.chat.subagentLatest', { line: subagentSummary.recent[subagentSummary.recent.length - 1] })}`
                        : ''}
                </div>
            )}
            <div id={bodyId} className="vh-disclosure-panel" hidden={!open}>
                {open && <ToolView message={message} />}
            </div>
        </div>
    );
}

export function ToolGroupView({
    tools,
    collapseCompleted = false,
}: {
    tools: ToolCallMessage[];
    collapseCompleted?: boolean;
}) {
    const { t } = useTranslation();
    const state = groupState(tools);
    const running = state === 'running';
    const compact = useMediaQuery('(max-width: 860px)');
    // collapsed by default once done; open while running.
    const [expanded, setExpanded] = useState(running || tools.length === 1);
    const rowsId = useId();

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
                    <ToolRow
                        message={tools[0]}
                        defaultOpen={collapseCompleted ? running || state === 'error' : !compact || running || state === 'error'}
                        collapseOnComplete={collapseCompleted}
                    />
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
                    className="tg-head vh-disclosure-trigger"
                    onClick={() => setExpanded((v) => !v)}
                    aria-expanded={expanded}
                    aria-controls={rowsId}
                >
                    <ChevronRight size={14} className={`tg-chevron${expanded ? ' is-open' : ''}`} />
                    <span className="tg-summary">{t('session.chat.usedTools', { count: tools.length })}</span>
                    <span className="tg-run-summary" title={toolRunSummary(tools.map((m) => m.tool))}>
                        {toolRunSummary(tools.map((m) => m.tool))}
                    </span>
                    {running ? (
                        <span className="tg-elapsed tg-elapsed--live">
                            <StatusDot status="thinking" size={7} pulse />
                            {formatElapsed(elapsed)}
                        </span>
                    ) : state === 'error' || state === 'mixed' ? (
                        <span className="tg-elapsed tg-elapsed--err">
                            <AlertTriangle size={12} />
                            {t('session.chat.toolError')}
                        </span>
                    ) : null}
                </button>
                <div id={rowsId} className="tg-rows vh-disclosure-panel" hidden={!expanded}>
                    {expanded && <>
                        {tools.map((m) => (
                            <ToolRow
                                key={m.id}
                                message={m}
                                defaultOpen={m.tool.state === 'running' || m.tool.state === 'error'}
                                collapseOnComplete={collapseCompleted}
                            />
                        ))}
                    </>}
                </div>
            </div>
        </div>
    );
}
