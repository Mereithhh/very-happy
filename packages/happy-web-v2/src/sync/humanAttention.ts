/**
 * B-510: in-app side of `request_human` — the latest "needs you" per session,
 * fed by the `session-event` ephemeral (kind `attention`). Shown as a banner on
 * that session until dismissed, or until it is 30 minutes old (the agent is
 * polling its own completion condition; a stale strip would only mislead).
 */
import { create } from 'zustand';

export const HUMAN_ATTENTION_TTL_MS = 30 * 60_000;

export interface HumanAttention {
    reason: string;
    /** in-app path (panel deep link) or null */
    url: string | null;
    at: number;
}

interface HumanAttentionState {
    bySession: Record<string, HumanAttention>;
    report: (sessionId: string, attention: HumanAttention) => void;
    dismiss: (sessionId: string) => void;
}

export const useHumanAttention = create<HumanAttentionState>((set) => ({
    bySession: {},
    report: (sessionId, attention) => set((s) => ({ bySession: { ...s.bySession, [sessionId]: attention } })),
    dismiss: (sessionId) => set((s) => {
        const { [sessionId]: _gone, ...rest } = s.bySession;
        return { bySession: rest };
    }),
}));

/** Only an in-app path is followed — never an external URL from an event. */
export function attentionFromEvent(event: { kind: string; body: string; url?: string; timestamp: number }): HumanAttention | null {
    if (event.kind !== 'attention') return null;
    const url = typeof event.url === 'string' && /^\/(?!\/)/.test(event.url) ? event.url : null;
    return { reason: event.body, url, at: event.timestamp };
}

export function isAttentionFresh(a: HumanAttention | undefined, now: number): a is HumanAttention {
    return !!a && now - a.at < HUMAN_ATTENTION_TTL_MS;
}
