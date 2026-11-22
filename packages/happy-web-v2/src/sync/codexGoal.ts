/**
 * B-953 — a Codex session's `/goal`, web side, pure.
 *
 * The Codex wrapper (codex-goal-v1) runs `/goal …` through the app-server and
 * mirrors the thread's goal into `agentState.codexGoal` (null once cleared).
 * Only wrappers that declare CODEX_GOAL_CAPABILITY write it (AGENTS #14:
 * capabilities, never versions); on older Codex wrappers `/goal` would reach
 * the model as chat, so the composer refuses it there.
 */
import { CODEX_GOAL_CAPABILITY, readCodexGoal, type CodexGoal } from '@slopus/happy-wire';

export type GoalSupport = 'supported' | 'unsupported' | 'passthrough';

export type CodexGoalInput = {
    metadata?: { flavor?: string | null; capabilities?: readonly string[] | null } | null;
    agentState?: { codexGoal?: unknown } | null;
    archivedAt?: number | null;
};

const GOAL_RE = /^[\s　﻿​]*[/／]goal(?![A-Za-z0-9_:-])/i;

/** A standalone `/goal …` (what the wrapper takes as the command). */
export function isGoalCommand(text: string): boolean {
    return GOAL_RE.test(text);
}

/**
 * Codex: the wrapper's capability decides. Claude Code has its own `/goal`
 * (the SDK runs it); other agents get the text as typed.
 */
export function goalSupport(session: CodexGoalInput | null | undefined): GoalSupport {
    if (session?.metadata?.flavor !== 'codex') return 'passthrough';
    return session.metadata.capabilities?.includes(CODEX_GOAL_CAPABILITY) ? 'supported' : 'unsupported';
}

/** The goal to show for this session now, or null. */
export function sessionCodexGoal(session: CodexGoalInput | null | undefined): CodexGoal | null {
    if (!session || session.archivedAt != null) return null;
    if (goalSupport(session) !== 'supported') return null;
    return readCodexGoal(session.agentState?.codexGoal);
}

export function formatGoalTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
    return String(n);
}

/** `12k / 50k` (with a budget) / `12k` / null (nothing used, no budget). */
export function goalUsage(goal: Pick<CodexGoal, 'tokensUsed' | 'tokenBudget'>): string | null {
    const used = goal.tokensUsed ?? 0;
    if (goal.tokenBudget) return `${formatGoalTokens(used)} / ${formatGoalTokens(goal.tokenBudget)}`;
    return used > 0 ? formatGoalTokens(used) : null;
}

/** How the strip reads: working, waiting on you, or done. */
export function goalTone(status: CodexGoal['status']): 'active' | 'attention' | 'done' {
    if (status === 'active') return 'active';
    if (status === 'complete') return 'done';
    return 'attention';
}
