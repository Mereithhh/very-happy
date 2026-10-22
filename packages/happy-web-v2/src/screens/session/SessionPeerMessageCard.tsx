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
 *
 * B-716: the body is previewed as plain lines (markdown stripped); clicking
 * the card opens MessageReader with the body rendered and the source folded.
 */
import { useRef, useState } from 'react';
import { ArrowUpRight, MessageSquareShare, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { useSession } from '@/sync/storage';
import { getSessionName } from '@/utils/sessionUtils';
import { plainPreviewLines } from '@/utils/markdownPreview';
import { formatAgo, type PresentedPeerMessage } from './sessionPeerMessage';
import { AgentChip, AgentRoute } from './AgentChip';
import { agentKindLabel, agentKindOf } from './agentIdentity';
import { MessageReader, PreviewLines } from './MessageReader';
import { readerTitle } from '@/screens/teams/teamPresentation';
import { MessageTime } from './MessageTime';
import { cardClickOpens } from './cardClick';
import './sessionPeerMessage.css';

/** B-716: the folded card previews the body in plain lines; the whole card opens the reader. */
export function SessionPeerMessageCard({ content, sessionId, createdAt }: { content: PresentedPeerMessage; sessionId?: string; createdAt?: number | null }) {
    const { t } = useTranslation();
    const self = useSession(sessionId ?? '');
    const [open, setOpen] = useState(false);
    const openRef = useRef<HTMLButtonElement>(null);
    const conflict = content.kind === 'conflict';
    const fromKind = agentKindOf(content.agent);
    // B-506: a message that crossed machines names the sender's host.
    const fromSecondary = [agentKindLabel(fromKind) ?? content.agent, content.machine ? `@${content.machine}` : null].filter(Boolean).join(' · ');
    const label = conflict ? t('session.peerMessage.conflict') : t('session.peerMessage.messageFrom');
    const from = <AgentChip strong kind={fromKind} name={content.fromTitle ?? content.fromSessionId} secondary={fromSecondary || undefined} title={content.fromSessionId} />;
    const to = self ? <AgentChip kind={agentKindOf(self.metadata?.flavor)} name={getSessionName(self)} /> : null;
    const route = to ? <AgentRoute from={from} to={to} /> : from;
    const body = conflict ? content.body.replace(/\nFiles:\n[\s\S]*$/, '') : content.body;
    const paths = conflict ? (content.paths ?? (content.path ? [content.path] : [])) : [];
    const ago = conflict && content.peerEditedAgoMs !== undefined && content.peerEditedAgoMs > 0
        ? <span className="peer-message-ago">{t('session.peerMessage.editedAgo', { ago: formatAgo(content.peerEditedAgoMs) })}</span>
        : null;
    const sessionLink = content.fromSessionId !== 'cli' ? `/session/${encodeURIComponent(content.fromSessionId)}` : null;
    const preview = plainPreviewLines(body, 3);
    const Icon = conflict ? TriangleAlert : MessageSquareShare;
    return <div className={`msg msg--peer${conflict ? ' msg--peer-conflict' : ''}`}>
        <div className="peer-message peer-message--card" role="group" aria-label={label} onClick={(e) => { if (cardClickOpens(e)) setOpen(true); }}>
            <div className="peer-message-heading">
                <Icon size={16} aria-hidden />
                {conflict && <span className="peer-message-kind">{label}</span>}
                {route}
                {ago}
                <MessageTime createdAt={createdAt} />
            </div>
            {paths.map((p) => <code key={p} className="peer-message-path">{p}</code>)}
            {content.agent === 'terminal-mirror' && <span className="peer-message-note">{t('session.peerMessage.fromTerminal')}</span>}
            {preview.lines.length > 0 && (
                <button ref={openRef} type="button" className="peer-message-open" aria-haspopup="dialog" aria-expanded={open} aria-label={`${t('session.messageReader.open')}: ${preview.lines[0]}`} onClick={() => setOpen(true)}>
                    <PreviewLines {...preview} className="peer-message-preview" />
                </button>
            )}
            {sessionLink && (
                <div className="peer-message-actions">
                    <Link to={sessionLink} className="peer-message-link" title={content.fromSessionId}>
                        {t('session.peerMessage.openSession')}<ArrowUpRight size={15} aria-hidden />
                    </Link>
                </div>
            )}
        </div>
        <MessageReader
            open={open}
            onOpenChange={setOpen}
            triggerRef={openRef}
            icon={<Icon size={18} aria-hidden />}
            title={readerTitle(label, content.fromTitle ?? content.fromSessionId)}
            meta={<>{route}{ago}<MessageTime createdAt={createdAt} /></>}
            before={paths.length > 0 ? <div className="msg-reader-paths">{paths.map((p) => <code key={p}>{p}</code>)}</div> : undefined}
            body={body || content.raw}
            links={sessionLink ? [{ to: sessionLink, label: t('session.peerMessage.openSession'), title: content.fromSessionId }] : []}
            raw={content.raw}
        />
    </div>;
}
