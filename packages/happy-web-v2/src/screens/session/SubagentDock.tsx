import { Spinner, useToast } from '@/ui';
import { useEffect, useMemo, useState } from 'react';
import { Bot, ChevronRight, Eye, ListTodo, Terminal, X } from 'lucide-react';
import { useSession, useSessionMessages } from '@/sync/storage';
import { currentTurnMessages, isAgentWorkLive, type AgentLivenessInput } from '@/sync/agentLiveness';
import { backgroundTaskCount, useHeartbeatFresh, useHeartbeatLeaseBump } from '@/sync/heartbeatLease';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { useTranslation } from '@/i18n/useTranslation';
import { buildSubagentSummary, isSubagentToolName } from './subagentSummary';
import { presentedSubagentStatus, userAbortedAt } from './subagentAbort';
import { openSubagentPanel } from './subagentPanelState';
import { backgroundTaskEntries, formatTaskAge, type BackgroundTaskEntry } from './backgroundTaskDock';
import { claudeRuntimeRequest } from './claudeRuntimeControl';
import './subagent.css';

/** Uses the same lifecycle as the transcript; an async launch stub is not completion. */
export function runningSubagentCards(messages: Message[]): ToolCallMessage[] {
    const abortedAt = userAbortedAt(messages);
    return messages.filter((m): m is ToolCallMessage => m.kind === 'tool-call'
        && (isSubagentToolName(m.tool.name) || m.subagent?.subagentType === 'background-command') && presentedSubagentStatus(m, abortedAt) === 'running');
}

/** Historical running frames are not live evidence after a new turn or disconnect. */
export function liveSubagentDockCards(messages: Message[], activity: Omit<AgentLivenessInput, 'runningSubagentsInTurn'> & {archivedAt?: number | null}): ToolCallMessage[] {
    if (activity.archivedAt != null) return [];
    const cards = runningSubagentCards(currentTurnMessages(messages));
    return isAgentWorkLive({...activity, runningSubagentsInTurn: cards.length}) ? cards : [];
}

const TASK_ICON = { command: Terminal, monitor: Eye, agent: Bot, other: ListTodo } as const;
const STOP_TIMEOUT_MS = 15_000;

export function SubagentDock({ sessionId }: { sessionId: string }) {
    const { messages } = useSessionMessages(sessionId);
    const session = useSession(sessionId);
    const heartbeatFresh = useHeartbeatFresh(sessionId);
    useHeartbeatLeaseBump((s) => s.bump);
    const chronological = useMemo(() => [...messages].reverse(), [messages]);
    const cards = useMemo(() => liveSubagentDockCards(chronological, {
        presence: session?.presence, thinking: session?.thinking, archivedAt: session?.archivedAt, heartbeatFresh,
    }), [chronological, session?.presence, session?.thinking, session?.archivedAt, heartbeatFresh]);
    // B-518: work that outlives its turn (run_in_background, Monitor, async
    // sub-agents). The count is the heartbeat's; the list is agentState's.
    const liveCount = session?.archivedAt != null ? 0 : backgroundTaskCount(sessionId);
    const tasks = useMemo(
        () => backgroundTaskEntries(session?.agentState?.backgroundTasks?.tasks, liveCount, cards),
        [session?.agentState?.backgroundTasks?.tasks, liveCount, cards],
    );
    const canStop = session?.metadata?.capabilities?.includes('claude-runtime-controls-v1') === true;
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (tasks.length === 0) return;
        const timer = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(timer);
    }, [tasks.length]);
    const { t } = useTranslation();
    if (!cards.length && !tasks.length) return null;
    return <nav className="sa-dock" aria-label={tasks.length ? t('session.chat.backgroundTasksDock', { count: tasks.length }) : t('session.chat.subagentPanelTitle')}>
        {cards.map(card => {
            const summary = buildSubagentSummary(card);
            return <button type="button" key={card.id} className="sa-dock-item"
                onClick={() => openSubagentPanel(sessionId, card.id)}>
                <span aria-hidden><Spinner size={16} className="tg-subagent-spinner" /></span>
                <span className="sa-dock-title">{summary.title ?? t(card.subagent?.subagentType === 'background-command' ? 'session.chat.backgroundCommand' : 'session.chat.subagentPanelTitle')}</span>
                <span className="sa-dock-state">{t('session.chat.subagentStatus.running')}</span>
                <ChevronRight size={14} aria-hidden />
            </button>;
        })}
        {tasks.map(task => <BackgroundTaskChip key={task.id} sessionId={sessionId} task={task} now={now} canStop={canStop}
            messages={chronological} />)}
    </nav>;
}

function BackgroundTaskChip({ sessionId, task, now, canStop, messages }: {
    sessionId: string; task: BackgroundTaskEntry; now: number; canStop: boolean; messages: Message[];
}) {
    const { t } = useTranslation();
    const toast = useToast();
    const [stopping, setStopping] = useState(false);
    // The chip disappears when the heartbeat drops the task; if it has not
    // after a while the stop did not take — let the user try again.
    useEffect(() => {
        if (!stopping) return;
        const timer = setTimeout(() => setStopping(false), STOP_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [stopping]);
    const Icon = TASK_ICON[task.kind];
    const kindLabel = t(task.kind === 'command' ? 'session.chat.backgroundCommand'
        : task.kind === 'monitor' ? 'session.chat.backgroundMonitor'
        : task.kind === 'agent' ? 'session.chat.backgroundAgent' : 'session.chat.backgroundTask');
    const age = formatTaskAge(task.startedAt, now);
    // A background sub-agent whose spawn card is loaded opens like the cards do.
    const agentCard = task.kind === 'agent' && task.description
        ? messages.find((m): m is ToolCallMessage => m.kind === 'tool-call' && isSubagentToolName(m.tool.name)
            && (m.tool.input as Record<string, unknown> | null)?.description === task.description)
        : undefined;
    const stop = async () => {
        if (stopping) return;
        setStopping(true);
        try {
            await claudeRuntimeRequest(sessionId, { action: 'stop-task', taskId: task.id });
        } catch (e) {
            setStopping(false);
            toast.error(t('session.chat.stopBackgroundTaskFailed', { error: e instanceof Error ? e.message : String(e) }));
        }
    };
    const title = [kindLabel, task.description, age ? t('session.chat.backgroundTaskAge', { age }) : null].filter(Boolean).join(' · ');
    const body = <>
        <span aria-hidden><Spinner size={16} className="tg-subagent-spinner" /></span>
        <Icon size={13} aria-hidden className="sa-dock-kind" />
        <span className="sa-dock-title">{task.description ?? kindLabel}</span>
        {age && <span className="sa-dock-state sa-dock-age">{age}</span>}
    </>;
    return <span className={`sa-dock-item sa-dock-item--task${stopping ? ' is-stopping' : ''}`} title={title}>
        {agentCard
            ? <button type="button" className="sa-dock-open" onClick={() => openSubagentPanel(sessionId, agentCard.id)}>{body}</button>
            : <span className="sa-dock-open">{body}</span>}
        {canStop && <button type="button" className="sa-dock-stop" onClick={() => void stop()} disabled={stopping}
            aria-label={t('session.chat.stopBackgroundTask')} title={t('session.chat.stopBackgroundTask')}>
            {stopping ? <Spinner size={12} /> : <X size={13} />}
        </button>}
    </span>;
}
