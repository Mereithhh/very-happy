/**
 * ToolGroupView — a run of consecutive tool calls rendered as a single
 * collapsible block with a mono font and a teal accent left-spine. The spine
 * color encodes state: teal=running, danger=error, warn=mixed, line=done.
 */
import { memo, useEffect, useId, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ChevronRight, AlertTriangle, Bot, Check, PanelRight, Square } from 'lucide-react';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { sameItems } from './rowMemo';
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
import { presentedSubagentStatus } from './subagentAbort';
import { openSubagentPanel } from './subagentPanelState';
import './toolgroup.css';
import './subagent.css';

type GroupState = 'running' | 'stalled' | 'error' | 'mixed' | 'done';

/**
 * B-295: `stalled` = the transcript still says `running`, but the session is
 * demonstrably not working (see sync/agentLiveness.ts). The closing
 * tool_result is exactly what a killed/restarted wrapper never sends, so this
 * state is permanent — it must read as "unfinished", never as a live pulse
 * (phosphor teal is reserved for genuinely live, docs/design-language.md).
 */
function groupState(tools: ToolCallMessage[], stalled = false): GroupState {
    const states = tools.map((m) => m.tool.state);
    if (states.some((s) => s === 'running')) return stalled ? 'stalled' : 'running';
    const errors = states.filter((s) => s === 'error').length;
    if (errors === states.length && errors > 0) return 'error';
    if (errors > 0) return 'mixed';
    return 'done';
}

/** B-260-P2: the only accent on a sub-agent row is a genuinely running lifecycle.
 *  Deliberately NOT gated on B-295's `stalled`: a background sub-agent
 *  (`async_launched`) legitimately keeps running after its launching turn ends,
 *  and its `running` is an explicit CLI lifecycle event — not the absence of a
 *  closing frame that makes a plain tool call stall.
 *  B-317: a user abort DOES gate it — see subagentAbort.ts. `aborted` covers the
 *  no-lifecycle case too, where the row would otherwise pulse off `tool.state`
 *  alone (the closing tool_result is exactly what an aborted turn delays). */
function subagentGlyph(
    status: 'running' | 'completed' | 'failed' | 'stopped' | undefined,
    toolState: string,
    aborted: boolean,
) {
    if (status === 'stopped' || (aborted && status === undefined)) return <Square size={11} className="tg-subagent-glyph" aria-hidden />;
    if (status === 'running' || (status === undefined && toolState === 'running')) return <StatusDot status="thinking" size={7} pulse />;
    if (status === 'failed' || toolState === 'error') return <StatusDot status="permission" size={7} />;
    if (status === 'completed') return <Check size={13} className="tg-subagent-glyph" aria-hidden />;
    // No lifecycle from the CLI (old wrapper / stub completion): neutral, no claim.
    return <Bot size={13} className="tg-subagent-glyph" aria-hidden />;
}

function ToolRow({
    message,
    defaultOpen,
    collapseOnComplete = false,
    stalled = false,
    abortedAt = null,
}: {
    message: ToolCallMessage;
    defaultOpen: boolean;
    collapseOnComplete?: boolean;
    /** B-295: this `running` row can no longer be live — render it unfinished. */
    stalled?: boolean;
    /** B-317: time of the user abort that ended this turn, if any. */
    abortedAt?: number | null;
}) {
    const { t } = useTranslation();
    const tool = message.tool;
    // B-260: sub-agent rows are pointers. Their stub tool_result is not a real
    // completion, so they are exempt from collapse-on-complete, keep a neutral
    // glyph instead of a "done" status dot, and carry an always-visible
    // one-line process summary outside the disclosure panel.
    const isSubagent = tool.name === 'Task' || tool.name === 'Agent';
    const subagentSummary = isSubagent ? buildSubagentSummary(message) : null;
    const subagentStatus = isSubagent ? presentedSubagentStatus(message, abortedAt) : undefined;
    const isAborted = abortedAt !== null && message.createdAt <= abortedAt;
    const [open, setOpen] = useState(defaultOpen);
    const wasRunningRef = useRef(tool.state === 'running');
    const bodyId = useId();
    // 与 ToolView 同一手法（它也是 useParams），避免为了一个 id 改整条 props 链
    const { id: sessionId } = useParams();
    // B-145: 带文件路径的工具，头部的 detail 变成可点——点开预览而不是折叠这一行
    const filePath = toolFilePathOf(tool);
    const isStalled = stalled && tool.state === 'running';
    const status = isStalled
        ? 'offline'
        : tool.state === 'running' ? 'thinking' : tool.state === 'error' ? 'permission' : 'connected';
    const label = toolLabel(tool);
    const detail = toolDetail(tool);
    // A live or failed operation must surface itself even when the mobile
    // overview initially collapsed this row. Turn activity rows fold exactly
    // once on running→completed; legacy tool groups preserve their old state.
    useEffect(() => {
        if ((tool.state === 'running' && !stalled) || tool.state === 'error') setOpen(true);
        if (collapseOnComplete && !isSubagent && tool.state === 'completed' && wasRunningRef.current) setOpen(false);
        wasRunningRef.current = tool.state === 'running';
    }, [collapseOnComplete, isSubagent, stalled, tool.state]);
    const subagentLine = subagentSummary && (subagentSummary.toolCount > 0 || subagentStatus) ? (
        <div className="tg-subagent-line">
            {subagentStatus
                ? `${t(`session.chat.subagentStatus.${subagentStatus}` as 'session.chat.subagentStatus.running')} · `
                : ''}
            {t('session.chat.usedTools', { count: subagentSummary.toolCount })}
            {(subagentSummary.lifecycle?.latest ?? subagentSummary.recent[subagentSummary.recent.length - 1])
                ? ` · ${t('session.chat.subagentLatest', { line: subagentSummary.lifecycle?.latest ?? subagentSummary.recent[subagentSummary.recent.length - 1] })}`
                : ''}
            {subagentSummary.lifecycle?.durationMs != null
                ? ` · ${formatElapsed(Math.round(subagentSummary.lifecycle.durationMs / 1000))}`
                : ''}
        </div>
    ) : null;

    // B-317: inside a session, a sub-agent row is a POINTER, never a disclosure.
    // Its prompt and process log open in the aside drawer instead of unfolding
    // between two paragraphs of the main conversation. Without a session route
    // (the dev harness) there is no drawer to open, so the old inline
    // disclosure below stays as the fallback.
    if (isSubagent && sessionId) {
        return (
            <div className={`tg-row${tool.state === 'error' ? ' tg-row--error' : ''}`}>
                <button
                    type="button"
                    className="tg-subagent-open"
                    onClick={() => openSubagentPanel(sessionId, message.id)}
                >
                    {subagentGlyph(subagentStatus, tool.state, isAborted)}
                    <span className="tg-tool-label">{label}</span>
                    {detail && detail !== label && <span className="tg-subagent-open-title">{detail}</span>}
                    <PanelRight size={13} className="tg-subagent-open-cue" aria-hidden />
                </button>
                {subagentLine}
            </div>
        );
    }

    return (
        <div className={`tg-row${tool.state === 'error' ? ' tg-row--error' : ''}`}>
            <div className="tg-row-head-wrap">
                <button type="button" className="tg-row-head vh-disclosure-trigger" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={bodyId}>
                    <ChevronRight size={13} className={`tg-chevron${open ? ' is-open' : ''}`} />
                    {isSubagent
                        ? subagentGlyph(subagentStatus, tool.state, isAborted)
                        : <StatusDot status={status as any} size={7} pulse={tool.state === 'running' && !isStalled} />}
                    <span className="tg-tool-label">{label}</span>
                    {detail && detail !== label && !filePath && <span className="tg-tool-detail">{detail}</span>}
                </button>
                {detail && detail !== label && filePath && sessionId && (
                    <FilePathLink path={filePath} sessionId={sessionId} label={detail} className="tg-tool-detail" />
                )}
                {detail && detail !== label && filePath && !sessionId && (
                    <span className="tg-tool-detail">{detail}</span>
                )}
                {isStalled && <span className="tg-tool-stalled">{t('session.chat.toolInterrupted')}</span>}
            </div>
            {subagentLine}
            <div id={bodyId} className="vh-disclosure-panel" hidden={!open}>
                {open && <ToolView message={message} abortedAt={abortedAt} />}
            </div>
        </div>
    );
}

function ToolGroupViewImpl({
    tools,
    collapseCompleted = false,
    stalled = false,
    abortedAt = null,
}: {
    tools: ToolCallMessage[];
    collapseCompleted?: boolean;
    /** B-295: the session is not working, so `running` rows here are orphans. */
    stalled?: boolean;
    /** B-317: time of the user abort that ended this turn, if any. */
    abortedAt?: number | null;
}) {
    const { t } = useTranslation();
    const state = groupState(tools, stalled);
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
                        stalled={stalled}
                        abortedAt={abortedAt}
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
                    ) : state === 'stalled' ? (
                        <span className="tg-elapsed tg-elapsed--stalled">
                            <Square size={11} />
                            {t('session.chat.toolInterrupted')}
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
                                defaultOpen={(m.tool.state === 'running' && !stalled) || m.tool.state === 'error'}
                                collapseOnComplete={collapseCompleted}
                                stalled={stalled}
                                abortedAt={abortedAt}
                            />
                        ))}
                    </>}
                </div>
            </div>
        </div>
    );
}

/** B-311: see rowMemo — the tools array is rebuilt every render, its elements
 *  are not. Without this, one running tool's per-second timer re-rendered
 *  every other tool group in the transcript. */
export const ToolGroupView = memo(ToolGroupViewImpl, (prev, next) => (
    sameItems(prev.tools, next.tools)
    && prev.collapseCompleted === next.collapseCompleted
    && prev.stalled === next.stalled
    && prev.abortedAt === next.abortedAt
));
