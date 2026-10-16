/**
 * SessionPeerMessageCard (B-497) — a user message that came from ANOTHER
 * session on the same machine (session_message) or an edit-conflict notice
 * the daemon sent both editors. Same structure as TeamMessageCard: one
 * compact block with the source (title · runner · link to that session), the
 * human body, and the exact source text folded away.
 *
 * B-614: the heading is the route — sender → this session — drawn with the
 * shared AgentChip, and the session link + source fold share one action row,
 * so a one-line message no longer costs ~200px.
 */
import { ArrowUpRight, MessageSquareShare, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { useSession } from '@/sync/storage';
import { getSessionName } from '@/utils/sessionUtils';
import { formatAgo, type PresentedPeerMessage } from './sessionPeerMessage';
import { AgentChip, AgentRoute } from './AgentChip';
import { agentKindLabel, agentKindOf } from './agentIdentity';
import './sessionPeerMessage.css';

export function SessionPeerMessageCard({ content, sessionId }: { content: PresentedPeerMessage; sessionId?: string }) {
    const { t } = useTranslation();
    const self = useSession(sessionId ?? '');
    const conflict = content.kind === 'conflict';
    const fromKind = agentKindOf(content.agent);
    // B-506: a message that crossed machines names the sender's host.
    const fromSecondary = [agentKindLabel(fromKind) ?? content.agent, content.machine ? `@${content.machine}` : null].filter(Boolean).join(' · ');
    const label = conflict ? t('session.peerMessage.conflict') : t('session.peerMessage.messageFrom');
    const from = <AgentChip strong kind={fromKind} name={content.fromTitle ?? content.fromSessionId} secondary={fromSecondary || undefined} title={content.fromSessionId} />;
    const to = self ? <AgentChip kind={agentKindOf(self.metadata?.flavor)} name={getSessionName(self)} /> : null;
    return <div className={`msg msg--peer${conflict ? ' msg--peer-conflict' : ''}`}>
        <div className="peer-message" role="group" aria-label={label}>
            <div className="peer-message-heading">
                {conflict ? <TriangleAlert size={16} aria-hidden /> : <MessageSquareShare size={16} aria-hidden />}
                {conflict && <span className="peer-message-kind">{label}</span>}
                {to ? <AgentRoute from={from} to={to} /> : from}
                {conflict && content.peerEditedAgoMs !== undefined && content.peerEditedAgoMs > 0 && (
                    <span className="peer-message-ago">{t('session.peerMessage.editedAgo', { ago: formatAgo(content.peerEditedAgoMs) })}</span>
                )}
            </div>
            {conflict && (content.paths ?? (content.path ? [content.path] : [])).map((p) => <code key={p} className="peer-message-path">{p}</code>)}
            {content.agent === 'terminal-mirror' && <span className="peer-message-note">{t('session.peerMessage.fromTerminal')}</span>}
            {content.body && <p className="peer-message-body">{conflict ? content.body.replace(/\nFiles:\n[\s\S]*$/, '') : content.body}</p>}
            <div className="peer-message-actions">
                {content.fromSessionId !== 'cli' && (
                    <Link to={`/session/${encodeURIComponent(content.fromSessionId)}`} className="peer-message-link" title={content.fromSessionId}>
                        {t('session.peerMessage.openSession')}<ArrowUpRight size={15} aria-hidden />
                    </Link>
                )}
                <details className="peer-message-details">
                    <summary className="peer-message-summary">{t('session.peerMessage.source')}</summary>
                    <pre className="peer-message-source">{content.raw}</pre>
                </details>
            </div>
        </div>
    </div>;
}
