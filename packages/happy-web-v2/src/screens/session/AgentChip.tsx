/** B-614 identity atoms — see agentIdentity.ts for the rules. */
import type { ReactNode } from 'react';
import { AlertTriangle, ArrowRight, Asterisk, Bot, Check, CodeXml, Pi, Square, TerminalSquare, UsersRound, type LucideIcon } from 'lucide-react';
import { Spinner, StatusDot } from '@/ui';
import type { AgentKind, AgentStatus } from './agentIdentity';
import './agentIdentity.css';

const GLYPH: Record<AgentKind, LucideIcon> = {
    claude: Asterisk, codex: CodeXml, pi: Pi, terminal: TerminalSquare, subagent: Bot, team: UsersRound, unknown: Bot,
};

export function AgentGlyph({ kind, size = 14 }: { kind: AgentKind; size?: number }) {
    const Icon = GLYPH[kind];
    return <Icon size={size} className="ag-glyph" aria-hidden />;
}

/** glyph + name (+ quiet secondary). Inherits font size from its host. */
export function AgentChip({ kind, name, secondary, title, strong = false }: {
    kind: AgentKind; name: ReactNode; secondary?: ReactNode; title?: string; strong?: boolean;
}) {
    return <span className={`ag-chip${strong ? ' ag-chip--strong' : ''}`} title={title}>
        <AgentGlyph kind={kind} />
        <span className="ag-name">{name}</span>
        {secondary ? <span className="ag-secondary">{secondary}</span> : null}
    </span>;
}

/** Who talks to whom: `from → to`. */
export function AgentRoute({ from, to, label }: { from: ReactNode; to: ReactNode; label?: string }) {
    return <span className="ag-route" aria-label={label}>
        {from}
        <ArrowRight size={13} className="ag-route-arrow" aria-hidden />
        {to}
    </span>;
}

/** The one status vocabulary (StatusDot semantics: accent=live, warn=waiting). */
export function AgentStatusIcon({ status, fallback = 'subagent' }: { status: AgentStatus | undefined; fallback?: AgentKind }) {
    switch (status) {
        case 'running': return <Spinner size={16} className="tg-subagent-spinner" />;
        case 'completed': return <Check size={13} className="ag-status ag-status--done" aria-hidden />;
        case 'failed': return <AlertTriangle size={14} className="ag-status ag-status--failed" aria-hidden />;
        case 'stopped': return <Square size={11} className="ag-status ag-status--done" aria-hidden />;
        case 'waiting': return <StatusDot status="permission" size={7} />;
        default: return <AgentGlyph kind={fallback} size={13} />;
    }
}
