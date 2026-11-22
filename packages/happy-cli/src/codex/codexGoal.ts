/**
 * B-953: `/goal` on a Codex session, run by the wrapper through the
 * app-server (`thread/goal/*`, origin `user`) instead of being sent to the
 * model as chat (a user 11-22: "why is /goal not supported?").
 *
 * Subcommands follow Codex's TUI (`/goal [<objective>|clear|pause|resume]`,
 * codex-rs tui/src/goal_display.rs) plus `budget <N|off>`: the TUI has no way
 * to set `tokenBudget`, the app-server takes one.
 *
 * While a goal is `active` Codex starts turns by itself (no user message);
 * `turn/interrupt` alone leaves it `active` — Codex's TUI pauses it first
 * (chatwidget/interaction.rs), and so does the wrapper's stop (runCodex).
 */
import {
    CODEX_GOAL_MIN_VERSION,
    codexVersionAtLeast,
    parseCodexGoalCommand,
    type CodexGoal,
    type CodexGoalCommand,
    type CodexGoalStatus,
} from '@slopus/happy-wire';

/** What `thread/goal/*` answers / notifies (schema v2 ThreadGoal). */
export type CodexThreadGoal = {
    objective: string;
    status: CodexGoalStatus;
    tokenBudget?: number | null;
    tokensUsed?: number | null;
    timeUsedSeconds?: number | null;
};

export type CodexGoalSetParams = {
    objective?: string;
    status?: CodexGoalStatus;
    tokenBudget?: number | null;
};

export type CodexGoalClient = {
    hasActiveThread(): boolean;
    serverVersion: string | null;
    getGoal(): Promise<CodexThreadGoal | null>;
    setGoal(params: CodexGoalSetParams): Promise<CodexThreadGoal | null>;
    clearGoal(): Promise<boolean>;
};

export type CodexGoalOutcome = 'shown' | 'set' | 'updated' | 'cleared' | 'none' | 'unsupported' | 'failed';

/** `/goal …` (any spelling the composer sends) → the command, else null. */
export function codexGoalCommand(text: string): CodexGoalCommand | null {
    return parseCodexGoalCommand(text);
}

const STATUS_TEXT: Record<CodexGoalStatus, string> = {
    active: 'active',
    paused: 'paused',
    blocked: 'stalled',
    usageLimited: 'stopped: usage limit reached',
    budgetLimited: 'stopped: token budget reached',
    complete: 'complete',
};

export function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
    return String(n);
}

/** `12k / 50k tokens` / `12k tokens` / '' */
export function describeGoalUsage(goal: Pick<CodexThreadGoal, 'tokensUsed' | 'tokenBudget'>): string {
    const used = goal.tokensUsed ?? 0;
    if (goal.tokenBudget) return `${formatTokens(used)} / ${formatTokens(goal.tokenBudget)} tokens`;
    return used > 0 ? `${formatTokens(used)} tokens` : '';
}

/** One line for the transcript: `Goal active: <objective> · 12k / 50k tokens`. */
export function describeGoal(goal: CodexThreadGoal): string {
    const usage = describeGoalUsage(goal);
    return `Goal ${STATUS_TEXT[goal.status] ?? goal.status}: ${goal.objective}${usage ? ` · ${usage}` : ''}`;
}

/**
 * The line a status change deserves, or null. Only changes a person acts on:
 * the goal finished, stopped on a limit, stalled, was paused or resumed.
 * Token-count updates (many per turn) say nothing.
 */
export function describeGoalTransition(previous: CodexThreadGoal | null, next: CodexThreadGoal | null): string | null {
    if (!next) return previous ? 'Goal cleared' : null;
    if (previous && previous.status === next.status && previous.objective === next.objective) return null;
    return describeGoal(next);
}

/** agentState.codexGoal for a goal (null clears the field). */
export function toAgentStateGoal(goal: CodexThreadGoal | null, now: number = Date.now()): CodexGoal | null {
    if (!goal) return null;
    return {
        objective: goal.objective,
        status: goal.status,
        tokenBudget: goal.tokenBudget ?? null,
        tokensUsed: goal.tokensUsed ?? 0,
        timeUsedSeconds: goal.timeUsedSeconds ?? 0,
        updatedAt: now,
    };
}

/** An app-server refusal → the line a person reads, with the way out. */
export function describeGoalError(error: unknown, serverVersion: string | null): string {
    const message = error instanceof Error ? error.message : typeof (error as any)?.message === 'string' ? (error as any).message : String(error);
    if (/goals feature is disabled/i.test(message)) {
        return 'Goals are turned off in this machine\'s Codex config. Remove `goals = false` under [features] in ~/.codex/config.toml (or run `codex features enable goals`), then send /goal again.';
    }
    if (/method not found|unknown variant|unknown method|-32601/i.test(message)) {
        return unsupportedText(serverVersion);
    }
    if (/no goal exists/i.test(message)) return 'There is no goal on this conversation. Set one with /goal <objective>.';
    return `Goal command failed: ${message}`;
}

function unsupportedText(serverVersion: string | null): string {
    return `/goal needs Codex ${CODEX_GOAL_MIN_VERSION} or newer (this machine runs ${serverVersion ?? 'an unknown version'}). Update Codex on that machine (npm install -g @openai/codex), then send /goal again. The message was not sent to the model.`;
}

/** The line Stop leaves when it paused an active goal (Lead 11-22). */
export const GOAL_PAUSED_ON_STOP = 'Goal paused — send /goal resume to continue';

/**
 * After a restart / resume: read the thread's goal once so the session shows it
 * again (null clears a stale one). Quiet on a Codex without goals or any error.
 */
export async function restoreCodexGoal(deps: {
    client: Pick<CodexGoalClient, 'hasActiveThread' | 'serverVersion' | 'getGoal'>;
    apply: (goal: CodexThreadGoal | null) => void;
    log?: (message: string) => void;
}): Promise<boolean> {
    if (!deps.client.hasActiveThread() || !codexVersionAtLeast(deps.client.serverVersion)) return false;
    try {
        deps.apply(await deps.client.getGoal());
        return true;
    } catch (error) {
        deps.log?.(`[Codex] Could not read the goal after resume: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

const USAGE = 'Usage: /goal <objective> · /goal (show) · /goal pause · /goal resume · /goal clear · /goal budget <tokens|off> (e.g. /goal budget 50000)';

/**
 * Runs one `/goal` command. `ensureThread` opens the conversation when the
 * goal is its first message (Codex keeps goals per thread). Every outcome is
 * reported through `notify`; nothing reaches the model.
 */
export async function runCodexGoal(command: CodexGoalCommand, deps: {
    client: CodexGoalClient;
    ensureThread: () => Promise<void>;
    notify: (text: string) => void;
    /** the goal as Codex now has it — the caller mirrors it and reports the change */
    onGoal: (goal: CodexThreadGoal | null) => void;
}): Promise<CodexGoalOutcome> {
    const { client, notify } = deps;
    if (!codexVersionAtLeast(client.serverVersion)) {
        notify(unsupportedText(client.serverVersion));
        return 'unsupported';
    }
    try {
        if (!client.hasActiveThread()) {
            if (command.kind !== 'set') {
                notify(command.kind === 'show' ? `No goal set. ${USAGE}` : 'There is no goal on this conversation. Set one with /goal <objective>.');
                return 'none';
            }
            await deps.ensureThread();
        }
        switch (command.kind) {
            case 'show': {
                const goal = await client.getGoal();
                deps.onGoal(goal);
                notify(goal ? describeGoal(goal) : `No goal set. ${USAGE}`);
                return goal ? 'shown' : 'none';
            }
            case 'set': {
                // Codex's TUI replaces a goal by clearing it first: a new objective
                // starts with its own usage, not the old goal's.
                const existing = await client.getGoal();
                if (existing) await client.clearGoal();
                const goal = await client.setGoal({
                    objective: command.objective,
                    status: 'active',
                    ...(existing?.tokenBudget ? { tokenBudget: existing.tokenBudget } : {}),
                });
                deps.onGoal(goal);
                return 'set';
            }
            case 'pause':
            case 'resume': {
                const existing = await client.getGoal();
                if (!existing) {
                    notify('There is no goal on this conversation. Set one with /goal <objective>.');
                    return 'none';
                }
                const goal = await client.setGoal({ status: command.kind === 'pause' ? 'paused' : 'active' });
                deps.onGoal(goal);
                return 'updated';
            }
            case 'budget': {
                const existing = await client.getGoal();
                if (!existing) {
                    notify('There is no goal on this conversation. Set one with /goal <objective>, then its budget.');
                    return 'none';
                }
                const goal = await client.setGoal({ tokenBudget: command.tokens });
                deps.onGoal(goal);
                notify(command.tokens ? `Goal token budget set to ${formatTokens(command.tokens)}` : 'Goal token budget removed');
                return 'updated';
            }
            case 'clear': {
                const cleared = await client.clearGoal();
                // `onGoal(null)` reports 「Goal cleared」 (one line per change).
                deps.onGoal(null);
                if (!cleared) notify('There was no goal to clear');
                return cleared ? 'cleared' : 'none';
            }
        }
    } catch (error) {
        notify(describeGoalError(error, client.serverVersion));
        return 'failed';
    }
    return 'none';
}
