/**
 * B-923: one main agent tool call as a semantic card (view model from
 * mainAgentToolView). Fill-only header pill, one closed outline (.vh-panel),
 * the raw input / receipt folded into a <details> at the bottom.
 *
 * Links: sessions → /session/<id>; board → the main agent's own session with
 * ?panel=board (spec §4.2 link format); settings → /settings/main-agent.
 */

import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Ban, Bot, CheckCircle2, ClipboardList, FileText, GitBranch, ListChecks, MessageSquare, NotebookPen, RotateCcw, ShieldAlert, SquareStack, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Spinner } from '@/ui';
import { Summary } from '@/ui/Summary';
import { useTranslation } from '@/i18n/useTranslation';
import { STATUS_TONE, type ToolCardKind, type ToolCardView, type ToolLink } from './mainAgentToolView';
import { explain, mainAgentToolCopy } from './mainAgentToolCopy';
import './toolCards.css';

const KIND_ICON: Record<ToolCardKind, LucideIcon> = {
    delegate: Users, 'lead-message': MessageSquare, session: Bot, issue: ClipboardList, todo: ListChecks, note: NotebookPen, board: SquareStack,
    decision: CheckCircle2, lifecycle: RotateCcw, list: FileText, blocked: ShieldAlert, unavailable: Ban, error: AlertTriangle,
};

const PREVIEW_MAX = 600;

export function linkHref(link: ToolLink, mainAgentSessionId: string | null): string | null {
    switch (link.kind) {
        case 'session': return `/session/${link.sessionId}`;
        case 'board': return mainAgentSessionId ? `/session/${mainAgentSessionId}?panel=board` : null;
        case 'settings': return '/settings/main-agent';
        case 'issue': return `/issues/${link.ref.toUpperCase()}`;
    }
}

export function MainAgentToolCard({ view, mainAgentSessionId }: { view: ToolCardView; mainAgentSessionId: string | null }) {
    const { lang } = useTranslation();
    const copy = mainAgentToolCopy(lang);
    const navigate = useNavigate();
    const Icon = view.kind === 'delegate' ? Users : view.tool === 'session_handoff' ? GitBranch : KIND_ICON[view.kind];
    const tone = STATUS_TONE[view.status];
    const reason = explain(view, copy);
    const links = view.links.map((l) => ({ link: l, href: linkHref(l, mainAgentSessionId) })).filter((l): l is { link: ToolLink; href: string } => !!l.href);
    const preview = view.preview && view.preview.length > PREVIEW_MAX ? `${view.preview.slice(0, PREVIEW_MAX)}…` : view.preview;
    return (
        <div className="ma-tc vh-panel" data-kind={view.kind} data-status={view.status} data-tool={view.tool}>
            <div className="ma-tc-head">
                <Icon size={14} aria-hidden className="ma-tc-icon" />
                <span className="ma-tc-name">{copy.tool[view.tool] ?? view.tool}</span>
                <span className={`vh-pill ma-tc-pill${tone === 'live' ? ' vh-pill--live' : tone === 'warn' ? ' vh-pill--warn' : tone === 'danger' ? ' vh-pill--danger' : ''}`} data-tone={tone}>
                    {view.status === 'running' && <Spinner size={10} />}
                    {copy.status[view.status]}
                </span>
            </div>
            {(view.heading || view.kind === 'list') && view.status !== 'running' && (
                <div className="ma-tc-heading">
                    {view.kind === 'list' ? copy.count(Number(view.heading ?? 0)) : view.kind === 'decision' && view.heading ? copy.tool[view.heading] ?? view.heading : view.heading}
                </div>
            )}
            {reason && <p className="ma-tc-reason" role={view.kind === 'blocked' || view.status === 'failed' ? 'alert' : undefined}>{reason}</p>}
            {view.fields.length > 0 && (
                <dl className="ma-tc-fields">
                    {view.fields.map((f) => (
                        <div key={f.key} className="ma-tc-field">
                            <dt>{copy.field[f.key]}</dt>
                            <dd className={f.mono ? 'mono' : undefined}>{f.key === 'to' && f.value === 'new' ? copy.toNew : f.value}</dd>
                        </div>
                    ))}
                </dl>
            )}
            {preview && <p className="ma-tc-preview">{preview}</p>}
            {view.items && view.items.length > 0 && (
                <div className="ma-tc-items">
                    {view.kind === 'delegate' && <div className="ma-tc-items-label">{copy.acceptance}</div>}
                    {view.kind === 'board' && <div className="ma-tc-items-label">{copy.options}</div>}
                    <ul>
                        {view.items.map((it, i) => <li key={i} className={view.kind === 'list' ? 'mono' : undefined}>{it}</li>)}
                    </ul>
                    {view.more ? <div className="ma-tc-more">{copy.more(view.more)}</div> : null}
                </div>
            )}
            {links.length > 0 && (
                <div className="ma-tc-links">
                    {links.map(({ link, href }) => (
                        <button key={href} type="button" className="ma-tc-link" onClick={() => navigate(href)}>{copy.link(link)}</button>
                    ))}
                </div>
            )}
            <details className="ma-tc-raw">
                <Summary className="ma-tc-raw-summary">{copy.raw}</Summary>
                <div className="ma-tc-raw-body">
                    <div className="ma-tc-raw-label">{copy.rawInput}</div>
                    <pre className="mono">{safeJson(view.raw.input)}</pre>
                    {view.raw.result !== null && (
                        <>
                            <div className="ma-tc-raw-label">{copy.rawResult}</div>
                            <pre className="mono">{prettyMaybeJson(view.raw.result)}</pre>
                        </>
                    )}
                </div>
            </details>
        </div>
    );
}

function safeJson(value: unknown): string {
    try { return JSON.stringify(value, null, 2) ?? ''; } catch { return String(value); }
}
function prettyMaybeJson(text: string): string {
    const t = text.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return text;
    try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return text; }
}
