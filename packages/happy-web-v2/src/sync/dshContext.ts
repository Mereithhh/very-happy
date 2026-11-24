/**
 * B-970 — a dsh (DeepSeek Harness) session's context occupancy, web side, pure.
 *
 * dsh messages carry no usage the composer can read. Wrappers with
 * dsh-context-v1 mirror dsh's own `usage_update` (used / size) into
 * `agentState.dshContextUsage`; only those are read (AGENTS #14), and only
 * while they belong to the dsh session the Very Happy session is on now.
 *
 * undefined = not a dsh session on such a wrapper (the composer keeps its old
 * reading); null = it is, but nothing measured yet for this dsh session.
 */
import { DSH_CONTEXT_CAPABILITY, readDshContextUsage } from '@slopus/happy-wire';

export type DshContextInput = {
    metadata?: { flavor?: string | null; capabilities?: readonly string[] | null; dshSessionId?: string | null } | null;
    agentState?: { dshContextUsage?: unknown } | null;
};

export function sessionDshContext(session: DshContextInput | null | undefined): { tokens: number; contextWindow: number } | null | undefined {
    const metadata = session?.metadata;
    if (metadata?.flavor !== 'dsh' || !metadata.capabilities?.includes(DSH_CONTEXT_CAPABILITY)) return undefined;
    const usage = readDshContextUsage(session?.agentState?.dshContextUsage);
    // A failed resume started a fresh dsh session: the numbers are the old one's.
    if (!usage || usage.sessionId !== metadata.dshSessionId) return null;
    return { tokens: usage.tokens, contextWindow: usage.contextWindow };
}
