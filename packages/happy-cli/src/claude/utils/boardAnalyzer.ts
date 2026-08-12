/**
 * Board analyzer (LLM bypass — Task Board V2).
 *
 * Mirrors the titleGenerator contract exactly: a one-shot, cheap
 * `claude -p --model haiku` subprocess against the already-authenticated local
 * Claude binary, 30s timeout, fire-and-forget, every failure swallowed (a
 * board with no fresh analysis beats a session loop that can stall).
 *
 * What it does: after the first user message and at every turn end it asks
 * haiku to (a) map the session onto one of the user's board tasks (titles read
 * from KV `vh.board-tasks.v1` — plain base64 JSON, this fork is
 * server-trusted), (b) flag whether the session needs the boss's attention
 * ('review' / 'blocked'), and (c) produce a one-line Chinese progress note.
 * The verdict is written into session metadata `board: { taskId?, attention?,
 * progress?, analyzedAt }` via the same updateMetadata primitive the summary
 * path uses, so it rides the existing sessions push to every device — no new
 * sync channel.
 *
 * Cost guardrails (all enforced BEFORE spawning the subprocess):
 *  - opt-in only: `boardLlm: true` in ~/.happy/settings.json (daemon-local;
 *    the synced web settings blob is client-side encrypted and NOT readable
 *    here — see the V2 plan / final report for the trade-off).
 *  - per session: at least ANALYZE_MIN_INTERVAL_MS between runs AND the input
 *    content hash must have changed.
 *  - per machine: a file-backed sliding-window cap (HOURLY_LIMIT runs/hour
 *    across ALL happy sessions on this machine — each session is its own
 *    process, so the counter lives in ~/.happy, not in module state).
 *
 * Output contract: strict JSON
 *   { "taskId": string|null, "attention": "none"|"review"|"blocked", "progress": string }
 * Anything else is dropped. A taskId not present in the offered task list is
 * nulled (models invent ids; the board must not).
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/apiSession';
import type { RawJSONLines } from '@/claude/types';
import { resolveClaudeBinary, runClaudeOneShot } from './titleGenerator';

export const ANALYZE_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const HOURLY_LIMIT = 30;
export const HOURLY_WINDOW_MS = 60 * 60 * 1000;
const USER_MESSAGE_MAX_CHARS = 1000;
const ASSISTANT_TAIL_MAX_CHARS = 1000;
const PROGRESS_MAX_CHARS = 200;
const MAX_TASKS_IN_PROMPT = 30;

//
// Pure pieces (unit-tested in boardAnalyzer.test.ts)
//

export interface BoardTaskRef {
    id: string;
    title: string;
}

export interface BoardAnalysisInput {
    lastUserMessage: string;
    /** tail (last ASSISTANT_TAIL_MAX_CHARS chars) of the latest assistant text */
    assistantTail: string;
    /** latest TodoWrite todos, already flattened to "[ ] content" lines */
    todos: string[];
    /** open board tasks offered for classification (may be empty) */
    tasks: BoardTaskRef[];
}

export interface BoardAnalysis {
    taskId: string | null;
    attention: 'none' | 'review' | 'blocked';
    progress: string;
}

/** Deterministic content hash of everything that influences the verdict.
 *  Same hash → the previous verdict still stands → skip the run. */
export function computeInputHash(input: BoardAnalysisInput): string {
    const h = createHash('sha256');
    h.update(input.lastUserMessage);
    h.update('\0');
    h.update(input.assistantTail);
    h.update('\0');
    h.update(input.todos.join('\n'));
    h.update('\0');
    h.update(input.tasks.map((t) => t.id).join(','));
    return h.digest('hex');
}

export interface ThrottleState {
    lastRunAt: number;
    lastHash: string | null;
}

/** Per-session throttle: ≥5min since the last run AND the input changed.
 *  A session's very first run (lastRunAt === 0) passes immediately. */
export function shouldAnalyze(state: ThrottleState, hash: string, now: number): boolean {
    if (state.lastHash !== null && state.lastHash === hash) return false;
    if (now - state.lastRunAt < ANALYZE_MIN_INTERVAL_MS) return false;
    return true;
}

/** Sliding-window rate check over a list of run timestamps. Returns the
 *  pruned window plus whether one more run is allowed right now. */
export function pruneRateWindow(
    timestamps: number[],
    now: number,
    limit: number = HOURLY_LIMIT,
    windowMs: number = HOURLY_WINDOW_MS,
): { window: number[]; allowed: boolean } {
    const window = timestamps.filter((t) => typeof t === 'number' && t > now - windowMs && t <= now);
    return { window, allowed: window.length < limit };
}

/** Strip markdown fences and parse the strict JSON verdict. Returns null on
 *  anything malformed — a dropped analysis is always safe. */
export function parseBoardAnalysis(raw: string, knownTaskIds: ReadonlySet<string>): BoardAnalysis | null {
    let text = raw.trim();
    if (!text) return null;
    // Models love ```json fences despite instructions; also tolerate prose
    // around a single JSON object by slicing the outermost braces.
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1].trim();
    if (!text.startsWith('{')) {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start === -1 || end <= start) return null;
        text = text.slice(start, end + 1);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const attention = obj.attention;
    if (attention !== 'none' && attention !== 'review' && attention !== 'blocked') return null;
    if (typeof obj.progress !== 'string') return null;
    const progress = obj.progress.trim().slice(0, PROGRESS_MAX_CHARS);
    if (!progress) return null;
    let taskId: string | null = null;
    if (typeof obj.taskId === 'string' && knownTaskIds.has(obj.taskId)) {
        taskId = obj.taskId;
    }
    return { taskId, attention, progress };
}

export function buildBoardPrompt(input: BoardAnalysisInput): string {
    const tasks = input.tasks.slice(0, MAX_TASKS_IN_PROMPT);
    const taskLines = tasks.length > 0
        ? tasks.map((t) => `- ${t.id}: ${t.title}`).join('\n')
        : '(no tasks defined)';
    const todoBlock = input.todos.length > 0 ? input.todos.join('\n') : '(none)';
    return [
        'You are a status analyzer for a task board of coding-agent sessions. Analyze this session snapshot and reply with ONLY a strict JSON object, no markdown, no explanations:',
        '{"taskId": string|null, "attention": "none"|"review"|"blocked", "progress": string}',
        '',
        'Rules:',
        `- taskId: the id of the ONE task below this session is working on, or null if none clearly matches. Never invent an id.`,
        '- attention: "blocked" if the agent is stuck/waiting on the user; "review" if it finished something that needs the user to check; otherwise "none".',
        '- progress: one short sentence in Chinese (简体中文) describing current progress. No quotes inside.',
        '',
        `Task list:\n${taskLines}`,
        '',
        `Latest user message:\n${input.lastUserMessage.slice(0, USER_MESSAGE_MAX_CHARS)}`,
        '',
        `Latest assistant output (tail):\n${input.assistantTail.slice(-ASSISTANT_TAIL_MAX_CHARS)}`,
        '',
        `Current todos:\n${todoBlock}`,
    ].join('\n');
}

/** Extract the plain-text tail of an assistant message and any TodoWrite
 *  todos from a raw Claude JSONL line. Pure: feed observations in, get the
 *  fields the analyzer tracks. */
export function extractFromClaudeMessage(body: RawJSONLines): { assistantText?: string; todos?: string[] } {
    if (body.type !== 'assistant') return {};
    const message = (body as { message?: { content?: unknown } }).message;
    const content = message?.content;
    if (!Array.isArray(content)) return {};
    let assistantText: string | undefined;
    let todos: string[] | undefined;
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: string; text?: unknown; name?: string; input?: { todos?: unknown } };
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            assistantText = b.text;
        } else if (b.type === 'tool_use' && b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
            todos = (b.input!.todos as Array<{ content?: unknown; status?: unknown }>)
                .filter((t) => t && typeof t.content === 'string')
                .map((t) => `[${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`);
        }
    }
    return { assistantText, todos };
}

//
// Machine-wide hourly limiter (file-backed: every happy session is its own
// process, so the shared counter must live on disk). Best-effort: a race
// between two sessions can overshoot by a run or two — acceptable for a cost
// guardrail, not a billing system.
//

export class FileRateLimiter {
    constructor(
        private readonly filePath: string,
        private readonly limit: number = HOURLY_LIMIT,
        private readonly windowMs: number = HOURLY_WINDOW_MS,
    ) { }

    /** Try to record one run right now. False → over the hourly cap. */
    tryAcquire(now: number = Date.now()): boolean {
        let timestamps: number[] = [];
        try {
            const raw = readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as { runs?: unknown };
            if (Array.isArray(parsed.runs)) timestamps = parsed.runs as number[];
        } catch {
            // missing/corrupt file → empty window
        }
        const { window, allowed } = pruneRateWindow(timestamps, now, this.limit, this.windowMs);
        if (!allowed) return false;
        window.push(now);
        try {
            mkdirSync(dirname(this.filePath), { recursive: true });
            writeFileSync(this.filePath, JSON.stringify({ runs: window }));
        } catch (error) {
            // Can't persist the counter → fail CLOSED for this run? No: failing
            // closed on a read-only FS would silently disable the feature the
            // user opted into. The per-session 5-min throttle still bounds cost.
            logger.debug('[boardAnalyzer] rate file write failed', { error: String(error) });
        }
        return true;
    }
}

//
// The analyzer
//

export interface BoardAnalyzerOptions {
    /** daemon-local opt-in (~/.happy/settings.json `boardLlm: true`) */
    enabled: boolean;
    /** reads open board tasks from KV; null on any failure (analysis still runs, taskId stays null) */
    fetchTasks: () => Promise<BoardTaskRef[] | null>;
    /** machine-wide hourly limiter (file-backed) */
    rateLimiter: FileRateLimiter;
}

export class BoardAnalyzer {
    private lastUserMessage = '';
    private assistantTail = '';
    private todos: string[] = [];
    private throttle: ThrottleState = { lastRunAt: 0, lastHash: null };
    private running = false;
    private sawUserMessage = false;

    constructor(
        private readonly session: ApiSessionClient,
        private readonly options: BoardAnalyzerOptions,
    ) { }

    /** Feed every observed user prompt (both the app channel and the JSONL
     *  scanner — same call sites as titleGenerator.maybeGenerate). The FIRST
     *  one also triggers an immediate analysis attempt. */
    noteUserMessage(text: string | null | undefined): void {
        if (!this.options.enabled) return;
        if (!text || text.trim().length === 0) return;
        this.lastUserMessage = text.slice(0, USER_MESSAGE_MAX_CHARS * 2);
        if (!this.sawUserMessage) {
            this.sawUserMessage = true;
            this.maybeAnalyze('first-message');
        }
    }

    /** Feed every raw Claude JSONL line flowing to the server (assistant text
     *  tail + TodoWrite snapshots). Cheap; called from a socket 'claude-session-message' listener. */
    noteClaudeMessage(body: RawJSONLines): void {
        if (!this.options.enabled) return;
        try {
            const { assistantText, todos } = extractFromClaudeMessage(body);
            if (assistantText) this.assistantTail = assistantText.slice(-ASSISTANT_TAIL_MAX_CHARS);
            if (todos) this.todos = todos;
        } catch {
            // observation must never break the message path
        }
    }

    /** Turn ended (any status) — throttled analysis attempt. */
    onTurnEnd(): void {
        if (!this.options.enabled) return;
        this.maybeAnalyze('turn-end');
    }

    private maybeAnalyze(reason: 'first-message' | 'turn-end'): void {
        if (this.running) return;
        if (!this.lastUserMessage) return;
        // Detach entirely from the caller's control flow (fire-and-forget).
        this.running = true;
        void this.analyze(reason)
            .catch((error) => {
                logger.debug('[boardAnalyzer] analysis rejected', { error: String(error) });
            })
            .finally(() => {
                this.running = false;
            });
    }

    private async analyze(reason: 'first-message' | 'turn-end'): Promise<void> {
        // Task list first: it is part of the input hash (a new task appearing
        // is a legitimate reason to re-classify an otherwise idle session).
        let tasks: BoardTaskRef[] = [];
        try {
            tasks = (await this.options.fetchTasks()) ?? [];
        } catch {
            tasks = [];
        }

        const input: BoardAnalysisInput = {
            lastUserMessage: this.lastUserMessage,
            assistantTail: this.assistantTail,
            todos: this.todos,
            tasks,
        };
        const hash = computeInputHash(input);
        const now = Date.now();
        if (!shouldAnalyze(this.throttle, hash, now)) {
            logger.debug(`[boardAnalyzer] throttled (${reason})`);
            return;
        }
        if (!this.options.rateLimiter.tryAcquire(now)) {
            logger.debug('[boardAnalyzer] machine hourly cap reached; skipping');
            return;
        }
        // Stamp the throttle BEFORE the subprocess: a hung/failed run must not
        // be retried in a tight loop by the next turn end.
        this.throttle = { lastRunAt: now, lastHash: hash };

        const binary = resolveClaudeBinary();
        if (!binary) {
            logger.debug('[boardAnalyzer] no claude binary; skipping');
            return;
        }
        const stdout = await runClaudeOneShot(binary, buildBoardPrompt(input));
        if (stdout == null) return;

        const verdict = parseBoardAnalysis(stdout, new Set(tasks.map((t) => t.id)));
        if (!verdict) {
            logger.debug('[boardAnalyzer] unusable analysis output; dropped');
            return;
        }

        logger.debug(`[boardAnalyzer] verdict: task=${verdict.taskId} attention=${verdict.attention}`);
        this.session.updateMetadata((metadata) => ({
            ...metadata,
            board: {
                ...(verdict.taskId ? { taskId: verdict.taskId } : {}),
                attention: verdict.attention,
                progress: verdict.progress,
                analyzedAt: Date.now(),
            },
        }));
    }
}
