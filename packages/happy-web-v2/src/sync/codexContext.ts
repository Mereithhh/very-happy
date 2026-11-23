/**
 * B-963 — a Codex session's context occupancy, web side, pure.
 *
 * Codex messages carry no usage, so the composer had nothing to show. Wrappers
 * with codex-context-v1 mirror Codex's own figures (newest request + its
 * window) into `agentState.codexContextUsage`; only those are read (AGENTS
 * #14), and only while they belong to the thread the session is on now.
 */
import { CODEX_CONTEXT_CAPABILITY, readCodexContextUsage, type CodexContextUsage } from '@slopus/happy-wire';

export type CodexContextInput = {
    metadata?: { flavor?: string | null; capabilities?: readonly string[] | null; codexThreadId?: string | null } | null;
    agentState?: { codexContextUsage?: unknown } | null;
};

export function sessionCodexContext(session: CodexContextInput | null | undefined): CodexContextUsage | null {
    const metadata = session?.metadata;
    if (metadata?.flavor !== 'codex' || !metadata.capabilities?.includes(CODEX_CONTEXT_CAPABILITY)) return null;
    const usage = readCodexContextUsage(session?.agentState?.codexContextUsage);
    // Cleared, forked or not resumed: the numbers are another thread's.
    return usage && usage.threadId === metadata.codexThreadId ? usage : null;
}

/** One sub-agent thread's occupancy, or null when it was not reported. */
export function codexChildContext(session: CodexContextInput | null | undefined, threadId: string): { tokens: number; contextWindow: number | null } | null {
    const child = sessionCodexContext(session)?.children?.find((c) => c.threadId === threadId);
    return child && child.tokens !== null ? { tokens: child.tokens, contextWindow: child.contextWindow ?? null } : null;
}
