/**
 * B-556 `set_status` — the agent's own one-line status for the user's task
 * board (spec `specs/2026-10-agent-set-status.md`).
 *
 * One schema, every managed runner: Claude registers it in-process
 * (`startHappyServer`, advertised in `toolNames` → SDK allowedTools), the
 * Codex/Gemini/ACP stdio bridge forwards it by name, managed pi discovers it
 * over `HAPPY_MCP_URL` `tools/list`. Execution always happens in the owning
 * session process, which writes `metadata.selfStatus`.
 *
 * Deliberately NOT in the system prompt (B-493: a fixed "always call X" cost
 * every session two extra tool rounds). The description says when it helps;
 * the agent decides.
 *
 * Writes are coalesced, never dropped: metadata writes share the account rate
 * bucket (B-307), but discarding a status leaves the card showing a stale one.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const SELF_STATUS_TOOL_NAME = 'set_status';
export const SELF_STATUS_TOOL_TITLE = 'Set Status on the Task Board';
export const SELF_STATUS_PHASES = ['planning', 'implementing', 'testing', 'reviewing', 'blocked', 'done'] as const;
export type SelfStatusPhase = typeof SELF_STATUS_PHASES[number];
export const SELF_STATUS_MAX_CHARS = 120;
/** Two writes closer than this are merged into one trailing write of the latest value. */
export const SELF_STATUS_MIN_INTERVAL_MS = 10_000;
/** Re-sending the exact status already written within this window is a no-op. */
export const SELF_STATUS_DEDUPE_MS = 60_000;

export const SELF_STATUS_TOOL_DESCRIPTION =
    "Show a one-line status for this session on the user's task board, so they can tell what you are doing without "
    + 'opening the conversation. Useful during longer, multi-step work: call it when you move to a new phase '
    + '(e.g. planning → implementing → testing), when you become blocked, and when you finish. '
    + 'It is optional: skip it for quick questions and do not call it after every tool call — it is a status line, not a log. '
    + `Keep text short (max ${SELF_STATUS_MAX_CHARS} characters, one line). `
    + 'This only updates a display; to ask the user something, ask in the conversation.';

export interface SelfStatus {
    text: string;
    phase?: SelfStatusPhase;
    updatedAt: number;
}

/** Single line, trimmed, capped at SELF_STATUS_MAX_CHARS (with an ellipsis). Empty → null. */
export function normalizeSelfStatusText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const flat = value.replace(/\s+/g, ' ').trim();
    if (!flat) return null;
    const chars = Array.from(flat);
    return chars.length > SELF_STATUS_MAX_CHARS ? `${chars.slice(0, SELF_STATUS_MAX_CHARS - 1).join('').trimEnd()}…` : flat;
}

type Timer = unknown;

export interface SelfStatusPublisherDeps {
    write: (status: SelfStatus) => void;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => Timer;
    clearTimer?: (timer: Timer) => void;
}

export interface SelfStatusPublisher {
    /** Accept a new status; written now or as the trailing write of the current window. */
    publish(text: string, phase?: SelfStatusPhase): void;
    /** Drop a pending trailing write (session shutting down). */
    dispose(): void;
}

export function createSelfStatusPublisher(deps: SelfStatusPublisherDeps): SelfStatusPublisher {
    const now = deps.now ?? Date.now;
    const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    let lastWrite: SelfStatus | null = null;
    let pending: { text: string; phase?: SelfStatusPhase } | null = null;
    let timer: Timer | null = null;

    const flush = () => {
        timer = null;
        if (!pending) return;
        const next: SelfStatus = { text: pending.text, ...(pending.phase ? { phase: pending.phase } : {}), updatedAt: now() };
        pending = null;
        lastWrite = next;
        deps.write(next);
    };

    return {
        publish(text, phase) {
            const at = now();
            if (lastWrite && !pending && lastWrite.text === text && lastWrite.phase === phase
                && at - lastWrite.updatedAt >= 0 && at - lastWrite.updatedAt < SELF_STATUS_DEDUPE_MS) return;
            pending = { text, ...(phase ? { phase } : {}) };
            if (timer !== null) return; // the scheduled trailing write picks up the newest value
            const since = lastWrite ? at - lastWrite.updatedAt : Infinity;
            if (since >= SELF_STATUS_MIN_INTERVAL_MS || since < 0) flush();
            else timer = setTimer(flush, SELF_STATUS_MIN_INTERVAL_MS - since);
        },
        dispose() {
            if (timer !== null) clearTimer(timer);
            timer = null;
            pending = null;
        },
    };
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError: boolean };
export type SelfStatusExecutor = (args: { text?: unknown; phase?: unknown }) => Promise<ToolResult>;

/** Registers `set_status` on an MCP server; `execute` decides where it runs (in-process or forwarded). */
export function registerSelfStatusTool(server: Pick<McpServer, 'registerTool'>, execute: SelfStatusExecutor): void {
    server.registerTool(SELF_STATUS_TOOL_NAME, {
        description: SELF_STATUS_TOOL_DESCRIPTION,
        title: SELF_STATUS_TOOL_TITLE,
        inputSchema: {
            text: z.string().describe(`What you are doing now, one short line (max ${SELF_STATUS_MAX_CHARS} characters)`),
            phase: z.enum(SELF_STATUS_PHASES).optional()
                .describe('Optional phase of the work; "blocked" when you cannot proceed, "done" when finished'),
        },
        annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false, destructiveHint: false },
    }, async (args: any) => {
        try { return await execute(args ?? {}); }
        catch (error) {
            return { content: [{ type: 'text' as const, text: `Failed to set status: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
    });
}

/** The in-process executor: validate, then hand to the publisher. */
export function createSelfStatusExecutor(publisher: Pick<SelfStatusPublisher, 'publish'>): SelfStatusExecutor {
    return async (args) => {
        const text = normalizeSelfStatusText(args.text);
        if (!text) return { content: [{ type: 'text', text: 'text must be a non-empty one-line string' }], isError: true };
        const phase = SELF_STATUS_PHASES.includes(args.phase as SelfStatusPhase) ? args.phase as SelfStatusPhase : undefined;
        publisher.publish(text, phase);
        return { content: [{ type: 'text', text: 'Status shown on the task board.' }], isError: false };
    };
}
