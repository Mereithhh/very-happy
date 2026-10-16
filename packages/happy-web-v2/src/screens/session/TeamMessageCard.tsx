import { UsersRound, ArrowUpRight, ClipboardCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { useTeamNavigation } from '@/screens/sessions/useTeamNavigation';
import { teamMessageTask, memberTitle, teamForMessage, teamMessageRoute } from '@/screens/teams/teamPresentation';
import { AgentChip, AgentRoute } from './AgentChip';
import { agentKindLabel, agentKindOf } from './agentIdentity';
import { useFirstUseCopy } from '@/screens/teams/firstUseCopy';
import type { TeamBot, TeamState } from '@slopus/happy-wire';
import type { presentTeamMessage } from './teamMessage';
import './teamMessage.css';

type TeamMessageContent = NonNullable<ReturnType<typeof presentTeamMessage>>;

export function TeamMessageCard({ content, sessionId, localId }: { content: TeamMessageContent; sessionId?: string; localId?: string | null }) {
    const teams = useTeamNavigation();
    return <TeamMessageCardView content={content} team={teamForMessage(teams, sessionId, localId ?? null)} localId={localId ?? null} />;
}

/** B-614: presentational half, fed fixtures by the dev harness. */
export function TeamMessageCardView({ content, team, localId }: { content: TeamMessageContent; team: TeamState | undefined; localId: string | null }) {
    const { t } = useTranslation();
    const copy = useFirstUseCopy();
    const task = team && teamMessageTask(team, localId ?? null);
    const assignee = team?.bots.find(bot => bot.id === task?.assigneeBotId);
    const result = task?.attempts.find(a => a.id === task.currentAttemptId)?.result;
    const route = team && teamMessageRoute(team, localId);
    const chip = (bot: TeamBot) => <AgentChip kind={agentKindOf(bot.assistant)} name={memberTitle(bot, copy)} title={agentKindLabel(agentKindOf(bot.assistant)) ?? undefined} />;
    const source = <details className="team-message">
        <summary className="team-message-summary">
            {!task && <UsersRound size={16} aria-hidden />}
            <span className="team-message-label">{task ? copy.raw : t('teams.collaborationMessage')}</span>
            {!task && <span className="team-message-preview">{content.preview || t('teams.genericMessage')}</span>}
            {!task && <span className="team-message-toggle">{t('teams.messageSource')}</span>}
        </summary>
        <pre className="team-message-source">{content.raw}</pre>
    </details>;
    if (!task || !team) return <div className="msg msg--team">{source}</div>;
    // B-614: one block — who → whom, the task, its evidence, then links/source on one row.
    return <div className="msg msg--team">
        <div className="team-message-work">
            <div className="team-message-work-heading">
                <UsersRound size={16} aria-hidden />
                {route?.from && route.to
                    ? <AgentRoute from={chip(route.from)} to={chip(route.to)} />
                    : <span>{copy.message}</span>}
                <span className="team-message-status">{t(`teams.${task.status}`)}</span>
            </div>
            <strong>{task.goal}</strong>
            {assignee && route?.to?.id !== assignee.id && route?.from?.id !== assignee.id && <span className="team-message-assignee"><AgentChip kind={agentKindOf(assignee.assistant)} name={memberTitle(assignee, copy)} secondary={agentKindLabel(agentKindOf(assignee.assistant))} /></span>}
            {result && <p className="team-message-result"><ClipboardCheck size={16} />{result.slice(0, 220)}{result.length > 220 ? '…' : ''}</p>}
            <div className="team-message-actions">
                <Link to={`/teams/${encodeURIComponent(team.id)}?task=${encodeURIComponent(task.id)}`}>{copy.inspect}<ArrowUpRight size={15} /></Link>
                {source}
            </div>
        </div>
    </div>;
}
