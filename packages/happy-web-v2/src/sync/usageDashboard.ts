import { calculateTotals, type UsageTotalsInput } from './usageTotals';
import type { UsageDataPoint, UsageReportPoint } from './apiUsage';

type SessionFact = {
    id: string;
    createdAt: number;
    metadata?: { flavor?: string | null; terminalId?: string; sessionVariant?: string | null } | null;
};

type TerminalFact = { id: string; createdAt?: number | null; closedAt?: number | null };

export type UsageBreakdown = { key: string; tokens: number; sessions: number };

export type UsageDashboard = {
    totalTokens: number;
    totalCost: number;
    costKnown: boolean;
    structuredSessions: number;
    terminalSessions: number;
    agents: UsageBreakdown[];
    tokenKinds: Array<{ key: string; tokens: number; cost?: number }>;
};

function reportAgent(report: UsageReportPoint, session?: SessionFact): string {
    const match = /^usage:([^:]+):/.exec(report.key);
    if (match) return match[1];
    if (report.key === 'claude-session') return 'claude';
    return session?.metadata?.flavor || 'unknown';
}

function isTerminalMirror(session: SessionFact): boolean {
    return session.metadata?.flavor === 'terminal-mirror' || typeof session.metadata?.terminalId === 'string';
}

export function buildUsageDashboard(input: {
    usage: UsageDataPoint[];
    reports?: UsageReportPoint[];
    sessions: SessionFact[];
    terminals: TerminalFact[];
    startMs: number;
}): UsageDashboard {
    const totalsInput: UsageTotalsInput[] = input.reports?.length
        ? input.reports
        : input.usage;
    const totals = calculateTotals(totalsInput);
    const sessionsInWindow = input.sessions.filter((session) => session.createdAt >= input.startMs);
    const sessionById = new Map(input.sessions.map((session) => [session.id, session]));
    const terminalIds = new Set(
        input.terminals
            .filter((terminal) => Math.max(terminal.createdAt ?? 0, terminal.closedAt ?? 0) >= input.startMs)
            .map((terminal) => terminal.id),
    );
    for (const session of sessionsInWindow) {
        if (isTerminalMirror(session) && session.metadata?.terminalId) terminalIds.add(session.metadata.terminalId);
    }

    const agents = new Map<string, { tokens: number; sessions: Set<string> }>();
    const ensureAgent = (key: string) => {
        const normalized = key || 'unknown';
        const current = agents.get(normalized) ?? { tokens: 0, sessions: new Set<string>() };
        agents.set(normalized, current);
        return current;
    };
    for (const session of sessionsInWindow) {
        const flavor = session.metadata?.flavor || 'unknown';
        ensureAgent(flavor).sessions.add(session.id);
    }
    for (const report of input.reports ?? []) {
        const session = report.sessionId ? sessionById.get(report.sessionId) : undefined;
        const row = ensureAgent(reportAgent(report, session));
        row.tokens += typeof report.tokens.total === 'number' ? report.tokens.total : 0;
        if (report.sessionId) row.sessions.add(report.sessionId);
    }

    const structuredSessionIds = new Set(
        sessionsInWindow.filter((session) => !isTerminalMirror(session)).map((session) => session.id),
    );
    for (const report of input.reports ?? []) {
        if (!report.sessionId) continue;
        const session = sessionById.get(report.sessionId);
        if (!session || !isTerminalMirror(session)) structuredSessionIds.add(report.sessionId);
    }

    const costKnown = (input.reports ?? []).some((report) => (
        (report.key === 'claude-session' || report.key.startsWith('usage:claude:'))
        && typeof report.cost.total === 'number'
    )) || (!input.reports && totals.totalCost > 0);

    return {
        totalTokens: totals.totalTokens,
        totalCost: totals.totalCost,
        costKnown,
        structuredSessions: structuredSessionIds.size,
        terminalSessions: terminalIds.size,
        agents: [...agents.entries()]
            .map(([key, value]) => ({ key, tokens: value.tokens, sessions: value.sessions.size }))
            .sort((a, b) => b.tokens - a.tokens || b.sessions - a.sessions || a.key.localeCompare(b.key)),
        tokenKinds: Object.entries(totals.tokensByKind)
            .map(([key, tokens]) => ({ key, tokens, ...(totals.costByKind[key] === undefined ? {} : { cost: totals.costByKind[key] }) }))
            .sort((a, b) => b.tokens - a.tokens),
    };
}
