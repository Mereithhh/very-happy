/**
 * Pure decision logic for the daemon → assistant "主动汇报" sink (B-069).
 *
 * When a session that the assistant dispatched (spawn-origin tag
 * `spawnedBy: 'assistant'`) reaches a stable turn end (completed) or blocks
 * on a permission request (needs_input), the daemon forwards a role-tagged
 * `[系统通报]` user message into the live assistant session so it can verify
 * with session_read and report a one-line conclusion aloud.
 *
 * Everything here is decidable without I/O so the send/skip matrix is
 * unit-testable in isolation (assistantSpawn.ts precedent):
 *  - only assistant-spawned sessions report (spawnedBy === 'assistant');
 *  - the assistant never reports about itself (variant or same-id guard);
 *  - a live assistant session must exist on this machine;
 *  - per-session cooldown (5 min) collapses bursts — the prompt additionally
 *    asks the assistant to merge near-simultaneous reports.
 *
 * daemon/run.ts wires this into the /session-event control endpoint and the
 * actual sendUserMessage delivery.
 */

import type { Metadata } from '@/api/types';

/** Session state transition kinds the sink reacts to (mirrors the terminal
 *  tracker's 'completed' / 'permission' event pair, session flavored). */
export type AssistantReportEvent = 'completed' | 'needs_input';

/** Per-session minimum interval between two reports. */
export const ASSISTANT_REPORT_COOLDOWN_MS = 5 * 60 * 1000;

export interface AssistantReportDecisionInput {
    /** Spawn-origin tag of the finishing session (TrackedSession.spawnedBy,
     *  falling back to what the session process itself reported). */
    spawnedBy: string | undefined;
    /** The finishing session is itself the assistant variant. */
    isAssistantSession: boolean;
    /** Happy session id of the finishing session. */
    sessionId: string;
    /** Live assistant's session id, when a live assistant process exists
     *  AND its webhook already assigned an id. */
    assistantSessionId: string | undefined;
    /** Last time a report was sent for this sessionId (undefined = never). */
    lastReportAt: number | undefined;
    now: number;
    cooldownMs?: number;
}

export type AssistantReportDecision =
    | { send: true; assistantSessionId: string }
    | { send: false; reason: string };

/**
 * Decide whether a session state event should be forwarded to the assistant.
 * Pure — every gate is expressed over plain inputs.
 */
export function decideAssistantReport(input: AssistantReportDecisionInput): AssistantReportDecision {
    if (input.spawnedBy !== 'assistant') {
        return { send: false, reason: 'session was not spawned by the assistant' };
    }
    if (input.isAssistantSession) {
        return { send: false, reason: 'session is the assistant itself' };
    }
    if (!input.assistantSessionId) {
        return { send: false, reason: 'no live assistant session on this machine' };
    }
    if (input.sessionId === input.assistantSessionId) {
        return { send: false, reason: 'session is the assistant itself (same id)' };
    }
    const cooldownMs = input.cooldownMs ?? ASSISTANT_REPORT_COOLDOWN_MS;
    if (input.lastReportAt !== undefined && input.now - input.lastReportAt < cooldownMs) {
        return { send: false, reason: `cooldown (${cooldownMs}ms) not elapsed` };
    }
    return { send: true, assistantSessionId: input.assistantSessionId };
}

/**
 * Human title for the reported session: generated summary > user-given name >
 * last path segment > the session id itself. Pure; unit-tested.
 */
export function resolveReportSessionTitle(metadata: Metadata | undefined, sessionId: string): string {
    const summary = metadata?.summary?.text?.trim();
    if (summary) return summary;
    const name = metadata?.name?.trim();
    if (name) return name;
    const path = metadata?.path;
    if (path) {
        const segments = path.split('/').filter(Boolean);
        if (segments.length > 0) return segments[segments.length - 1];
    }
    return sessionId;
}

/**
 * The `[系统通报]` message body sent into the assistant session. The template
 * counterpart (assistant CLAUDE.md) tells the assistant how to handle it:
 * verify via session_read, then a one-line spoken conclusion. Pure; unit-tested.
 */
export function formatAssistantReportMessage(title: string, sessionId: string, event: AssistantReportEvent): string {
    const state = event === 'completed' ? '已完成' : '等待输入';
    return `[系统通报] 会话「${title}」${state}（${sessionId}）。请用 session_read 核实结果，并向用户口头汇报一句结论；多条通报接近时合并汇报。`;
}
