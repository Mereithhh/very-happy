import { Users, ArrowUpRight, ClipboardCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { useTeamNavigation } from '@/screens/sessions/useTeamNavigation';
import { teamMessageTask, memberTitle, teamForMessage } from '@/screens/teams/teamPresentation';
import { useFirstUseCopy } from '@/screens/teams/firstUseCopy';
import type { presentTeamMessage } from './teamMessage';
import './teamMessage.css';

export function TeamMessageCard({ content, sessionId, localId }: { content: NonNullable<ReturnType<typeof presentTeamMessage>>; sessionId?: string; localId?: string | null }) {
    const { t } = useTranslation();
    const copy = useFirstUseCopy();
    const teams = useTeamNavigation();
    const team = teamForMessage(teams, sessionId, localId ?? null);
    const task = team && teamMessageTask(team, localId ?? null);
    const assignee = team?.bots.find(bot => bot.id === task?.assigneeBotId);
    const result = task?.attempts.find(a => a.id === task.currentAttemptId)?.result;
    return <div className="msg msg--team">
        {task && team && <div className="team-message-work">
            <div className="team-message-work-heading"><Users size={16} /><span>{copy.message}</span><span>{t(`teams.${task.status}`)}</span></div>
            <strong>{task.goal}</strong>
            {assignee && <span>{memberTitle(assignee, copy)} · {assignee.assistant === 'pi-acp' ? 'pi' : assignee.assistant}</span>}
            {result && <p className="team-message-result"><ClipboardCheck size={16} />{result.slice(0, 220)}{result.length > 220 ? '…' : ''}</p>}
            <Link to={`/teams/${encodeURIComponent(team.id)}?task=${encodeURIComponent(task.id)}`}>{copy.inspect}<ArrowUpRight size={15} /></Link>
        </div>}
        <details className="team-message">
            <summary className="team-message-summary">
                {!task && <Users size={16} aria-hidden />}
                <span className="team-message-label">{task ? copy.raw : t('teams.collaborationMessage')}</span>
                {!task && <span className="team-message-preview">{content.preview || t('teams.genericMessage')}</span>}
                {!task && <span className="team-message-toggle">{t('teams.messageSource')}</span>}
            </summary>
            <pre className="team-message-source">{content.raw}</pre>
        </details>
    </div>;
}
