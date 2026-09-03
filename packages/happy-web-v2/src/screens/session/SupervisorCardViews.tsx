/**
 * Supervisor session cards (B-353): TickReportCard for `[vh-tick …]` user messages and
 * DecisionCard for the charter decisions JSON at the end of an assistant reply.
 * Parsing lives in supervisorCards.ts; both callers fall back to the plain bubble when it returns null.
 */
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import type { Decision, TickItem, TickReport } from './supervisorCards';
import './supervisorCards.css';

const ATTENTION_KINDS = new Set(['permission', 'missing']);

function sessionPathOf(item: TickItem): string | null {
    if (item.sessionRef) {
        const m = /\/session\/([^/?#]+)/.exec(item.sessionRef);
        if (m) return `/session/${m[1]}`;
    }
    return item.sessionId ? `/session/${item.sessionId}` : null;
}

export function TickReportCard({ report }: { report: TickReport }) {
    const { t } = useTranslation();
    return (
        <div className="msg msg--event">
            <div className="svc" data-role="tick">
                <div className="svc-head">
                    <span className="svc-title">{t('message.supervisorTick', { count: report.items.length })}</span>
                    <span className="svc-mono svc-dim">{report.at}</span>
                </div>
                <ul className="svc-items">
                    {report.items.map((item) => {
                        const path = sessionPathOf(item);
                        return (
                            <li key={item.number} className="svc-item">
                                <div className="svc-item-head">
                                    <span className={`svc-kind${ATTENTION_KINDS.has(item.kind) ? ' svc-kind--attention' : ''}`}>{item.kind}</span>
                                    {item.taskId && <span className="svc-mono">{item.taskId}</span>}
                                    {item.goal && <span className="svc-goal">{item.goal}</span>}
                                    {item.untrackedSessionId && <span className="svc-mono">{item.untrackedSessionId}</span>}
                                </div>
                                <div className="svc-meta svc-mono svc-dim">
                                    {item.autonomy && <span>autonomy {item.autonomy}</span>}
                                    {item.status && <span>status {item.status}</span>}
                                    {item.machine && <span>{item.machine}</span>}
                                    {item.sessionState && <span>{item.sessionState}</span>}
                                    {path && <Link to={path} className="svc-link">{t('message.supervisorOpenSession')}</Link>}
                                </div>
                                {item.pendingRequests.length > 0 && (
                                    <div className="svc-section">
                                        <span className="svc-label">{t('message.supervisorPending')}</span>
                                        <ul className="svc-list svc-mono">
                                            {item.pendingRequests.map((req) => (
                                                <li key={req.id}>
                                                    <span className="svc-req-id">{req.id}</span>
                                                    {req.tool && <span className="svc-dim"> {req.tool}</span>}
                                                    {req.waiting && <span className="svc-wait"> {req.waiting}</span>}
                                                    {req.description && <span className="svc-dim"> · {req.description}</span>}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                                {item.acceptance.length > 0 && (
                                    <div className="svc-section">
                                        <span className="svc-label">{t('message.supervisorAcceptance')}</span>
                                        <ol start={0} className="svc-list svc-acceptance">
                                            {item.acceptance.map((criterion, i) => <li key={i}>{criterion}</li>)}
                                        </ol>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
                {report.footnotes.length > 0 && (
                    <div className="svc-foot svc-dim">{report.footnotes.map((note, i) => <div key={i}>{note}</div>)}</div>
                )}
            </div>
        </div>
    );
}

export function DecisionCard({ decisions }: { decisions: Decision[] }) {
    const { t } = useTranslation();
    return (
        <div className="svc" data-role="decision">
            <div className="svc-head">
                <span className="svc-title">{t('message.supervisorDecisions', { count: decisions.length })}</span>
            </div>
            <ul className="svc-items">
                {decisions.map((d, i) => (
                    <li key={`${d.taskId}-${i}`} className="svc-item">
                        <div className="svc-item-head">
                            <span className={`svc-action svc-action--${d.action}`}>{d.action}</span>
                            <span className="svc-mono">{d.taskId}</span>
                            {d.requestId && <span className="svc-mono svc-dim">{d.requestId}</span>}
                            {d.citedAcceptance.length > 0 && (
                                <span className="svc-mono svc-dim">{t('message.supervisorCited', { items: d.citedAcceptance.join(',') })}</span>
                            )}
                        </div>
                        {d.reason && <div className="svc-reason">{d.reason}</div>}
                        {d.message && <div className="svc-message">{d.message}</div>}
                        {d.command && <code className="svc-command svc-mono">{d.command}</code>}
                    </li>
                ))}
            </ul>
        </div>
    );
}
