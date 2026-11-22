import { z } from 'zod';

// B-953: `/goal` on a Codex session. Codex (≥ 0.128, on by default since
// 0.133) keeps a persisted goal per thread and runs turns on its own while the
// goal is `active` (app-server `thread/goal/set|get|clear`, notifications
// `thread/goal/updated|cleared`). Before this the wrapper sent `/goal …` to the
// model as chat, which answered that it cannot run it.
//
// The wrapper runs the command itself and mirrors the goal into agentState
// (`codexGoal`, null when cleared). Wrappers that do declare
// CODEX_GOAL_CAPABILITY; the web reads the field only on those (AGENTS #14),
// and lists `/goal` as unavailable on older Codex wrappers.

export const CODEX_GOAL_CAPABILITY = 'codex-goal-v1';

/** The first Codex release whose goals are on without a feature flag. */
export const CODEX_GOAL_MIN_VERSION = '0.133.0';

export const CODEX_GOAL_STATUSES = ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'] as const;
export type CodexGoalStatus = typeof CODEX_GOAL_STATUSES[number];

export const CodexGoalSchema = z.object({
    objective: z.string(),
    status: z.enum(CODEX_GOAL_STATUSES),
    tokenBudget: z.number().nullish(),
    tokensUsed: z.number().nullish(),
    timeUsedSeconds: z.number().nullish(),
    /** wrapper-clock ms epoch of the last change the wrapper saw */
    updatedAt: z.number(),
});
export type CodexGoal = z.infer<typeof CodexGoalSchema>;

/** agentState.codexGoal → a goal, or null (absent, cleared or malformed). */
export function readCodexGoal(raw: unknown): CodexGoal | null {
    const parsed = CodexGoalSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

export type CodexGoalCommand =
    | { kind: 'show' }
    | { kind: 'set'; objective: string }
    | { kind: 'pause' }
    | { kind: 'resume' }
    | { kind: 'clear' }
    /** VH extension: Codex's TUI has no budget command, the app-server takes `tokenBudget`. */
    | { kind: 'budget'; tokens: number | null };

const GOAL_RE = /^[/／]goal(?![A-Za-z0-9_:-])([\s\S]*)$/i;
const LEADING_SPACE_RE = /^[\s　﻿​]+/;
/**
 * A standalone `/goal …` → the command, else null. Same subcommands as Codex's
 * TUI (`/goal [<objective>|clear|pause|resume]`) plus `budget <N|off>`. Strict:
 * a subcommand is the whole rest of the line (`/goal pause the build` sets that
 * goal) and a budget is a positive integer or `off`. Accepts
 * what a phone keyboard types (／goal, /Goal, a full-width space); "please
 * /goal" and "/goals" stay chat.
 */
export function parseCodexGoalCommand(text: string): CodexGoalCommand | null {
    const match = text.replace(LEADING_SPACE_RE, '').match(GOAL_RE);
    if (!match) return null;
    const rest = match[1].replace(/　/g, ' ').trim();
    if (!rest) return { kind: 'show' };
    if (rest === 'pause') return { kind: 'pause' };
    if (rest === 'resume') return { kind: 'resume' };
    if (rest === 'clear') return { kind: 'clear' };
    if (rest === 'budget off') return { kind: 'budget', tokens: null };
    const budget = rest.match(/^budget ([1-9]\d{0,15})$/);
    if (budget && Number.isSafeInteger(Number(budget[1]))) return { kind: 'budget', tokens: Number(budget[1]) };
    return { kind: 'set', objective: rest };
}

/** The canonical text of a goal command (what the wrapper's queue carries). */
export function codexGoalCommandText(command: CodexGoalCommand): string {
    switch (command.kind) {
        case 'show': return '/goal';
        case 'set': return `/goal ${command.objective}`;
        case 'budget': return `/goal budget ${command.tokens ?? 'off'}`;
        default: return `/goal ${command.kind}`;
    }
}

/** `a.b.c` ≥ `min`; an unparsable version counts as new enough (the request then speaks for itself). */
export function codexVersionAtLeast(version: string | null | undefined, min: string = CODEX_GOAL_MIN_VERSION): boolean {
    const parse = (v: string) => v.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? null;
    const have = version ? parse(version) : null;
    const want = parse(min);
    if (!have || !want) return true;
    for (let i = 0; i < 3; i += 1) {
        if (have[i] !== want[i]) return have[i] > want[i];
    }
    return true;
}
