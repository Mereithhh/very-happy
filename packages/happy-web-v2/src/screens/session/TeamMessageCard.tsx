import { useRef, useState } from 'react';
import { UsersRound, ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { useTeamNavigation } from '@/screens/sessions/useTeamNavigation';
import { teamMessageTask, memberTitle, teamForMessage, teamMessageRoute } from '@/screens/teams/teamPresentation';
import { plainPreviewLines, plainPreviewText } from '@/utils/markdownPreview';
import { AgentChip, AgentRoute } from './AgentChip';
import { agentKindLabel, agentKindOf } from './agentIdentity';
import { useFirstUseCopy } from '@/screens/teams/firstUseCopy';
import { MessageReader, PreviewLines, type MessageReaderLink } from './MessageReader';
import { MessageTime } from './MessageTime';
import { cardClickOpens } from './cardClick';
import type { TeamBot, TeamState } from '@slopus/happy-wire';
import type { PresentedTeamMessage, TeamMessageKind } from './teamMessage';
import type { TranslationKey } from '@/text';
import './teamMessage.css';

const KIND_LABEL: Record<TeamMessageKind, TranslationKey> = {
    assigned: 'session.messageReader.kind.assigned',
    submitted: 'session.messageReader.kind.submitted',
    revision: 'session.messageReader.kind.revision',
    handoff: 'session.messageReader.kind.handoff',
    message: 'session.messageReader.kind.message',
};

export function TeamMessageCard({ content, sessionId, localId, createdAt }: { content: PresentedTeamMessage; sessionId?: string; localId?: string | null; createdAt?: number | null }) {
    const teams = useTeamNavigation();
    return <TeamMessageCardView content={content} team={teamForMessage(teams, sessionId, localId ?? null)} localId={localId ?? null} createdAt={createdAt} />;
}

/**
 * B-614: presentational half, fed fixtures by the dev harness.
 * B-716: folded card = who → whom · kind · time, the task line and a plain
 * 3-line preview (no markdown syntax); the whole card opens MessageReader with
 * the body rendered in full. The task link stays on the card.
 */
export function TeamMessageCardView({ content, team, localId, createdAt }: { content: PresentedTeamMessage; team: TeamState | undefined; localId: string | null; createdAt?: number | null }) {
    const { t } = useTranslation();
    const copy = useFirstUseCopy();
    const [open, setOpen] = useState(false);
    const openRef = useRef<HTMLButtonElement>(null);
    const task = team && teamMessageTask(team, localId ?? null);
    const route = team && teamMessageRoute(team, localId);
    const chip = (bot: TeamBot) => <AgentChip kind={agentKindOf(bot.assistant)} name={memberTitle(bot, copy)} title={agentKindLabel(agentKindOf(bot.assistant)) ?? undefined} />;
    const kindLabel = t(KIND_LABEL[content.kind]);
    const who = route?.from && route.to
        ? <AgentRoute from={chip(route.from)} to={chip(route.to)} />
        : content.sender ? <span className="team-message-sender">{content.sender}</span> : null;
    const status = task && <span className={`team-message-status vh-pill${task.status === 'running' ? ' vh-pill--live' : task.status === 'submitted' ? ' vh-pill--warn' : ''}`}>{t(`teams.${task.status}`)}</span>;
    // An assignment's body IS the goal; every other kind names the task it is about.
    const goal = task && content.kind !== 'assigned' ? plainPreviewText(task.goal, 160) : null;
    const preview = plainPreviewLines(content.body.trim() ? content.body : t('teams.genericMessage'), 3);
    const taskLink = team && task ? `/teams/${encodeURIComponent(team.id)}?task=${encodeURIComponent(task.id)}` : null;
    const links: MessageReaderLink[] = taskLink ? [{ to: taskLink, label: copy.inspect }] : [];
    return <div className="msg msg--team">
        <div className="team-message-work team-message-card" onClick={(e) => { if (cardClickOpens(e)) setOpen(true); }}>
            <div className="team-message-work-heading">
                <UsersRound size={16} aria-hidden />
                <span className="team-message-kind">{content.kind === 'message' && !task ? t('teams.collaborationMessage') : kindLabel}</span>
                {who}
                {status}
                <MessageTime createdAt={createdAt} />
            </div>
            <button ref={openRef} type="button" className="team-message-open" aria-haspopup="dialog" aria-expanded={open} aria-label={`${t('session.messageReader.open')}: ${content.preview}`} onClick={() => setOpen(true)}>
                {goal && <strong className="team-message-goal">{goal}</strong>}
                <PreviewLines {...preview} />
            </button>
            {taskLink && <div className="team-message-actions">
                <Link to={taskLink}>{copy.inspect}<ArrowUpRight size={15} /></Link>
            </div>}
        </div>
        <MessageReader
            open={open}
            onOpenChange={setOpen}
            triggerRef={openRef}
            icon={<UsersRound size={18} aria-hidden />}
            title={task ? `${kindLabel} · ${plainPreviewText(task.goal, 120)}` : (content.sender ? `${kindLabel} · ${content.sender}` : t('teams.collaborationMessage'))}
            meta={<>{who}{status}<MessageTime createdAt={createdAt} /></>}
            body={content.body || content.raw}
            links={links}
            raw={content.raw}
        />
    </div>;
}
