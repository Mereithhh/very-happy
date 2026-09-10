import { Spinner } from '@/ui';
import { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { useSession, useSessionMessages } from '@/sync/storage';
import { currentTurnMessages, isAgentWorkLive, type AgentLivenessInput } from '@/sync/agentLiveness';
import { useHeartbeatFresh } from '@/sync/heartbeatLease';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { useTranslation } from '@/i18n/useTranslation';
import { buildSubagentSummary, isSubagentToolName } from './subagentSummary';
import { presentedSubagentStatus, userAbortedAt } from './subagentAbort';
import { openSubagentPanel } from './subagentPanelState';
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

export function SubagentDock({ sessionId }: { sessionId: string }) {
    const { messages } = useSessionMessages(sessionId);
    const session = useSession(sessionId);
    const heartbeatFresh = useHeartbeatFresh(sessionId);
    const cards = useMemo(() => liveSubagentDockCards([...messages].reverse(), {
        presence: session?.presence, thinking: session?.thinking, archivedAt: session?.archivedAt, heartbeatFresh,
    }), [messages, session?.presence, session?.thinking, session?.archivedAt, heartbeatFresh]);
    const { t } = useTranslation();
    if (!cards.length) return null;
    return <nav className="sa-dock" aria-label={t('session.chat.subagentPanelTitle')}>
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
    </nav>;
}
