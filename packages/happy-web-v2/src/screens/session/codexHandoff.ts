import type { Session } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/sync/ops';

/**
 * B-901: the way out of a Codex thread that kills Codex whenever it is loaded
 * (a rollout of hundreds of MB, OOM on resume). Fork / import go through
 * Codex and die the same way, so the new session starts EMPTY in the same
 * machine + directory, with a summary of the old one prefilled in its
 * composer for the user to check and send. The summary comes from the
 * machine (`codex-handoff-context` streams the rollout: Codex's own latest
 * compaction summary + the last messages); when that is unavailable (older
 * CLI, transcript gone) it falls back to the messages loaded on this page.
 * Pure over `HandoffDeps`; the live wiring is codexHandoffRun.ts.
 */
export type HandoffMessage = { role: 'user' | 'assistant'; text: string };
export type HandoffContext = { summary: string | null; recent: HandoffMessage[] };

export type HandoffLabels = {
    intro: string;
    summary: string;
    recent: string;
    user: string;
    assistant: string;
    outro: string;
};

const RECENT = 12;
const MESSAGE_CHARS = 1_500;

const clip = (text: string) => (text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS)}…` : text);

export function composeHandoffDraft(context: HandoffContext, labels: HandoffLabels): string {
    const parts = [labels.intro];
    if (context.summary?.trim()) parts.push(`## ${labels.summary}\n\n${context.summary.trim()}`);
    if (context.recent.length > 0) {
        const lines = context.recent.map((m) => `**${m.role === 'user' ? labels.user : labels.assistant}:** ${m.text.trim()}`);
        parts.push(`## ${labels.recent}\n\n${lines.join('\n\n')}`);
    }
    parts.push(labels.outro);
    return parts.join('\n\n');
}

/** The machine's answer, or null when it gave nothing usable. */
export function readHandoffResponse(response: unknown): HandoffContext | null {
    const r = response as { type?: unknown; error?: unknown; summary?: unknown; recent?: unknown } | null;
    if (!r || r.error || r.type !== 'success') return null;
    const recent = Array.isArray(r.recent)
        ? r.recent.flatMap((m: { role?: unknown; text?: unknown }): HandoffMessage[] =>
            (m?.role === 'user' || m?.role === 'assistant') && typeof m.text === 'string' && m.text.trim() ? [{ role: m.role, text: m.text }] : [])
        : [];
    const summary = typeof r.summary === 'string' && r.summary.trim() ? r.summary : null;
    return summary || recent.length > 0 ? { summary, recent } : null;
}

/** Fallback: the last prompts and replies loaded on this page, oldest first. */
export function handoffFromMessages(messages: Message[]): HandoffContext {
    const recent = [...messages]
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
        .flatMap((m): HandoffMessage[] => {
            if (m.kind === 'user-text' && !m.cancelReason && m.text.trim()) return [{ role: 'user', text: clip(m.text) }];
            if (m.kind === 'agent-text' && m.text.trim()) return [{ role: 'assistant', text: clip(m.text) }];
            return [];
        })
        .slice(-RECENT);
    return { summary: null, recent };
}

export type HandoffDeps = {
    rpc: (machineId: string, method: string, args: Record<string, string>) => Promise<unknown>;
    spawn: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    loadedMessages: (sessionId: string) => Message[];
    setDraft: (sessionId: string, draft: string) => void;
    refresh: () => Promise<void>;
};


export type HandoffResult = { sessionId: string; fromMachine: boolean };

export async function startCodexHandoff(session: Session, labels: HandoffLabels, injected: HandoffDeps): Promise<HandoffResult> {
    const machineId = session.metadata?.machineId;
    const directory = session.metadata?.path;
    if (!machineId || !directory) throw new Error('This session has no machine or directory');
    const threadId = session.metadata?.codexThreadId;
    let context: HandoffContext | null = null;
    if (threadId) {
        try {
            context = readHandoffResponse(await injected.rpc(machineId, 'codex-handoff-context', { codexThreadId: threadId }));
        } catch {
            context = null;
        }
    }
    const fromMachine = context !== null;
    const draft = composeHandoffDraft(context ?? handoffFromMessages(injected.loadedMessages(session.id)), labels);
    const permissionMode = session.permissionMode ?? session.metadata?.permissionMode ?? undefined;
    const spawned = await injected.spawn({
        source: 'codex-handoff', machineId, directory, agent: 'codex',
        approvedNewDirectoryCreation: false, parentSessionId: session.id,
        ...(permissionMode ? { permissionMode } : {}),
    });
    if (spawned.type !== 'success' || !spawned.sessionId) {
        throw new Error(spawned.type === 'error' ? spawned.errorMessage : 'The new session was not started');
    }
    injected.setDraft(spawned.sessionId, draft);
    try { await injected.refresh(); } catch { /* the update stream hydrates it shortly */ }
    return { sessionId: spawned.sessionId, fromMachine };
}
