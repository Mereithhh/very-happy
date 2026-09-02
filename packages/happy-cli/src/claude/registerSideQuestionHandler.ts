/**
 * Session-scoped RPCs for `/btw` side questions (B-283).
 *
 * Why ask/poll instead of one blocking RPC: server AND relay cap every RPC at
 * 30s (rpcHandler.ts / relay.ts RPC_TIMEOUT_MS) while an answer over a big
 * context routinely takes longer. `btw-ask` returns a request id at once; the
 * web polls `btw-poll` (~1s) for progressive text until a terminal status.
 *
 * One side question per session at a time; finished results linger briefly so
 * a poll that raced the completion still finds it, then are dropped.
 */
import { logger } from '@/ui/logger';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSideQuestion, type SideQuestionExchange, type SideQuestionInput } from './sideQuestion';

export type SideQuestionStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface SideQuestionAskRequest {
    question?: unknown;
    history?: unknown;
}
export interface SideQuestionAskResponse {
    requestId: string;
    /** false when the main session has not produced a Claude session id yet. */
    hadContext: boolean;
}
export interface SideQuestionPollResponse {
    requestId: string;
    status: SideQuestionStatus;
    text: string;
    error?: string;
    startedAt: number;
    finishedAt?: number;
}

interface RpcRegistrar {
    registerHandler<TReq, TRes>(method: string, handler: (request: TReq) => Promise<TRes>): unknown;
}

export interface SideQuestionDeps {
    /** Live Claude session id of the main conversation (null before first turn). */
    getClaudeSessionId: () => string | null | undefined;
    getModel: () => string | undefined;
    cwd: string;
    /** Session `--claude-env` values; the fork runs against the same provider/credentials. */
    getEnv?: () => Record<string, string> | undefined;
    /** `--settings` file for the fork (see `writeSideQuestionSettingsFile`). */
    settingsPath?: string;
    /** Wall-clock cap for one side question; the slot is freed (aborted) when it elapses. */
    maxRunMs?: number;
    run?: (input: SideQuestionInput) => Promise<{ answer: string; hadContext: boolean }>;
    now?: () => number;
    /** How long a finished result stays pollable. */
    retainMs?: number;
}

interface Slot {
    requestId: string;
    status: SideQuestionStatus;
    text: string;
    error?: string;
    startedAt: number;
    finishedAt?: number;
    abort: AbortController;
}

export const SIDE_QUESTION_RETAIN_MS = 5 * 60_000;
export const SIDE_QUESTION_MAX_CHARS = 8000;
export const SIDE_QUESTION_MAX_RUN_MS = 10 * 60_000;

/**
 * Claude Code's own `/btw` runs in-process and fires no hooks; our fork is a
 * fresh `claude` process that would otherwise run the user's SessionStart /
 * Stop / SessionEnd hooks (desktop notifications, context injection, mirror
 * forwarders) once per side question. `disableAllHooks` via `--settings`
 * keeps the fork silent while `settingSources` still bring in CLAUDE.md.
 */
export function writeSideQuestionSettingsFile(homeDir: string): string {
    const dir = join(homeDir, 'tmp', 'hooks');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `side-question-${process.pid}.json`);
    writeFileSync(file, JSON.stringify({ disableAllHooks: true }));
    return file;
}

function parseHistory(raw: unknown): SideQuestionExchange[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const { question, answer } = item as { question?: unknown; answer?: unknown };
        return typeof question === 'string' && typeof answer === 'string' ? [{ question, answer }] : [];
    });
}

export function registerSideQuestionHandler(rpc: RpcRegistrar, deps: SideQuestionDeps) {
    const now = deps.now ?? (() => Date.now());
    const retainMs = deps.retainMs ?? SIDE_QUESTION_RETAIN_MS;
    const maxRunMs = deps.maxRunMs ?? SIDE_QUESTION_MAX_RUN_MS;
    const run = deps.run ?? (async (input) => {
        const { query } = await import('@/claude/sdk');
        return runSideQuestion(query as any, input);
    });
    const slots = new Map<string, Slot>();
    let active: Slot | null = null;

    const prune = () => {
        const t = now();
        for (const [id, slot] of slots) {
            if (slot.status !== 'running' && slot.finishedAt !== undefined && t - slot.finishedAt > retainMs) slots.delete(id);
        }
    };
    const finish = (slot: Slot, status: Exclude<SideQuestionStatus, 'running'>, error?: string) => {
        if (slot.status !== 'running') return;
        slot.status = status;
        slot.error = error;
        slot.finishedAt = now();
        if (active === slot) active = null;
    };

    rpc.registerHandler<SideQuestionAskRequest, SideQuestionAskResponse>('btw-ask', async (request) => {
        const question = typeof request?.question === 'string' ? request.question.trim() : '';
        if (!question) throw new Error('Side question is empty');
        if (question.length > SIDE_QUESTION_MAX_CHARS) throw new Error('Side question is too long');
        prune();
        if (active) throw new Error('A side question is already running');
        const resumeSessionId = deps.getClaudeSessionId() ?? null;
        const slot: Slot = {
            requestId: randomUUID(),
            status: 'running',
            text: '',
            startedAt: now(),
            abort: new AbortController(),
        };
        slots.set(slot.requestId, slot);
        active = slot;
        logger.debug(`[btw] side question ${slot.requestId} start (context=${resumeSessionId ? 'fork' : 'none'})`);
        // The web may vanish mid-answer (socket loss, tab closed) without ever
        // sending btw-cancel; without a cap the slot would stay busy forever.
        const deadline = setTimeout(() => {
            if (slot.status !== 'running') return;
            slot.abort.abort('timeout');
            finish(slot, 'error', 'Side question timed out');
            logger.debug(`[btw] side question ${slot.requestId} timed out after ${maxRunMs}ms`);
        }, maxRunMs);
        deadline.unref?.();
        void run({
            question,
            history: parseHistory(request.history),
            resumeSessionId,
            cwd: deps.cwd,
            model: deps.getModel(),
            env: deps.getEnv?.(),
            settingsPath: deps.settingsPath,
            signal: slot.abort.signal,
            onText: (text) => { if (slot.status === 'running') slot.text = text; },
        }).then((result) => {
            slot.text = result.answer;
            finish(slot, 'done');
            logger.debug(`[btw] side question ${slot.requestId} done (${result.answer.length} chars)`);
        }).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (slot.abort.signal.aborted) {
                finish(slot, 'cancelled');
            } else {
                finish(slot, 'error', message);
                logger.debug(`[btw] side question ${slot.requestId} failed: ${message}`);
            }
        }).finally(() => clearTimeout(deadline));
        return { requestId: slot.requestId, hadContext: Boolean(resumeSessionId) };
    });

    rpc.registerHandler<{ requestId?: unknown }, SideQuestionPollResponse>('btw-poll', async (request) => {
        prune();
        const id = typeof request?.requestId === 'string' ? request.requestId : '';
        const slot = slots.get(id);
        if (!slot) throw new Error('Unknown side question');
        return {
            requestId: slot.requestId,
            status: slot.status,
            text: slot.text,
            error: slot.error,
            startedAt: slot.startedAt,
            finishedAt: slot.finishedAt,
        };
    });

    rpc.registerHandler<{ requestId?: unknown }, { cancelled: boolean }>('btw-cancel', async (request) => {
        const id = typeof request?.requestId === 'string' ? request.requestId : '';
        const slot = slots.get(id);
        if (!slot || slot.status !== 'running') return { cancelled: false };
        slot.abort.abort('cancelled by user');
        finish(slot, 'cancelled');
        return { cancelled: true };
    });

    return {
        /** Test/introspection hook. */
        _slots: slots,
    };
}
