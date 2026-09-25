/**
 * SessionPeerMessageCard (B-497) — a user message that came from ANOTHER
 * session on the same machine (session_message) or an edit-conflict notice
 * the daemon sent both editors. Same structure as TeamMessageCard: one
 * compact block with the source (title · runner · link to that session), the
 * human body, and the exact source text folded away.
 */
import { ArrowUpRight, MessageSquareShare, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { formatAgo, peerAgentName, type PresentedPeerMessage } from './sessionPeerMessage';
import { messageTimestamp } from './messageTimestamp';
import './sessionPeerMessage.css';

export function SessionPeerMessageCard({ content, createdAt }: { content: PresentedPeerMessage; createdAt?: number }) {
    const { t, lang } = useTranslation();
    const conflict = content.kind === 'conflict';
    const agent = peerAgentName(content.agent);
    // B-506: a message that crossed machines names the sender's host.
    const who = [content.fromTitle ?? content.fromSessionId, agent, content.machine ? `@${content.machine}` : null].filter(Boolean).join(' · ');
    return <div className={`msg msg--peer${conflict ? ' msg--peer-conflict' : ''}`} title={messageTimestamp(createdAt, lang)}>
        <div className="peer-message" title="">
            <div className="peer-message-heading">
                {conflict ? <TriangleAlert size={16} aria-hidden /> : <MessageSquareShare size={16} aria-hidden />}
                <span>{conflict ? t('session.peerMessage.conflict') : t('session.peerMessage.messageFrom')}</span>
                {conflict && content.peerEditedAgoMs !== undefined && content.peerEditedAgoMs > 0 && (
                    <span className="peer-message-ago">{t('session.peerMessage.editedAgo', { ago: formatAgo(content.peerEditedAgoMs) })}</span>
                )}
            </div>
            <strong className="peer-message-who">{who}</strong>
            {conflict && (content.paths ?? (content.path ? [content.path] : [])).map((p) => <code key={p} className="peer-message-path">{p}</code>)}
            {content.agent === 'terminal-mirror' && <span className="peer-message-note">{t('session.peerMessage.fromTerminal')}</span>}
            {content.body && <p className="peer-message-body">{conflict ? content.body.replace(/\nFiles:\n[\s\S]*$/, '') : content.body}</p>}
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
    </div>;
}
