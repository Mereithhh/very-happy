/**
 * B-954 — the Codex wrapper's `/goal` receipts (B-953, CLI 0.2.220) and the
 * dsh capability note (B-952), shown in the interface language.
 *
 * The wrappers send these as plain service events in fixed English (the CLI
 * never knows the viewer's language), so the web recognises the exact lines
 * (codexGoal.ts `describeGoal` / `runCodexGoal` / GOAL_PAUSED_ON_STOP and
 * dshRunner.ts DSH_SESSION_NOTICE) and renders its own text. A line that does
 * not match stays as sent.
 *
 * Goal receipts answer something the person just did (`/goal`, `/goal budget`,
 * Stop), so they are pinned outside the collapsed activity group (like B-950).
 */
import type { CodexGoalStatus } from '@slopus/happy-wire';
import type { t as translateFn } from '@/text';

type Translate = typeof translateFn;

export type GoalNotice =
    | { type: 'status'; status: CodexGoalStatus; objective: string; usage: string | null }
    | { type: 'cleared' }
    | { type: 'budget-set'; tokens: string }
    | { type: 'budget-removed' }
    | { type: 'paused-on-stop' }
    | { type: 'none-set' }
    | { type: 'no-goal' }
    | { type: 'no-goal-budget' }
    | { type: 'nothing-to-clear' }
    | { type: 'disabled' }
    | { type: 'needs-codex'; minimum: string; version: string | null }
    | { type: 'failed'; error: string };

/** codexGoal.ts STATUS_TEXT, reversed. */
const STATUS_FROM_TEXT: Record<string, CodexGoalStatus> = {
    active: 'active',
    paused: 'paused',
    stalled: 'blocked',
    'stopped: usage limit reached': 'usageLimited',
    'stopped: token budget reached': 'budgetLimited',
    complete: 'complete',
};

const STATUS_LINE = /^Goal (active|paused|stalled|stopped: usage limit reached|stopped: token budget reached|complete): ([\s\S]+)$/;
/** describeGoalUsage: `12k / 50k tokens` / `12k tokens` */
const USAGE_TAIL = /^([\s\S]+?) · (\d+(?:\.\d+)?[kM]?(?: \/ \d+(?:\.\d+)?[kM]?)?) tokens$/;
const NEEDS_CODEX = /^\/goal needs Codex (\S+) or newer \(this machine runs (.+?)\)\. Update Codex on that machine/;
const GOAL_FAILED = /^Goal command failed: ([\s\S]+)$/;
const BUDGET_SET = /^Goal token budget set to (\d+(?:\.\d+)?[kM]?)$/;

export function parseGoalNotice(message: string): GoalNotice | null {
    const text = message.trim();
    if (!text) return null;
    if (text === 'Goal paused — send /goal resume to continue') return { type: 'paused-on-stop' };
    if (text === 'Goal cleared') return { type: 'cleared' };
    if (text === 'Goal token budget removed') return { type: 'budget-removed' };
    if (text === 'There was no goal to clear') return { type: 'nothing-to-clear' };
    if (text === 'There is no goal on this conversation. Set one with /goal <objective>.') return { type: 'no-goal' };
    if (text === 'There is no goal on this conversation. Set one with /goal <objective>, then its budget.') return { type: 'no-goal-budget' };
    if (text.startsWith('No goal set. Usage: /goal <objective>')) return { type: 'none-set' };
    if (text.startsWith('Goals are turned off in this machine\'s Codex config.')) return { type: 'disabled' };
    const budget = BUDGET_SET.exec(text);
    if (budget) return { type: 'budget-set', tokens: budget[1] };
    const needs = NEEDS_CODEX.exec(text);
    if (needs) return { type: 'needs-codex', minimum: needs[1], version: needs[2] === 'an unknown version' ? null : needs[2] };
    const failed = GOAL_FAILED.exec(text);
    if (failed) return { type: 'failed', error: failed[1] };
    const status = STATUS_LINE.exec(text);
    if (status) {
        const tail = USAGE_TAIL.exec(status[2]);
        return {
            type: 'status',
            status: STATUS_FROM_TEXT[status[1]],
            objective: tail ? tail[1] : status[2],
            usage: tail ? tail[2] : null,
        };
    }
    return null;
}

const STATUS_KEY = {
    active: 'session.chat.goalNotice.status.active',
    paused: 'session.chat.goalNotice.status.paused',
    blocked: 'session.chat.goalNotice.status.blocked',
    usageLimited: 'session.chat.goalNotice.status.usageLimited',
    budgetLimited: 'session.chat.goalNotice.status.budgetLimited',
    complete: 'session.chat.goalNotice.status.complete',
} as const;

export function goalNoticeText(notice: GoalNotice, t: Translate): string {
    switch (notice.type) {
        case 'status': {
            const line = t('session.chat.goalNotice.line', { label: t(STATUS_KEY[notice.status]), objective: notice.objective });
            return notice.usage ? `${line} · ${t('session.chat.goalTokens', { usage: notice.usage })}` : line;
        }
        case 'cleared': return t('session.chat.goalNotice.cleared');
        case 'budget-set': return t('session.chat.goalNotice.budgetSet', { tokens: notice.tokens });
        case 'budget-removed': return t('session.chat.goalNotice.budgetRemoved');
        case 'paused-on-stop': return t('session.chat.goalNotice.pausedOnStop');
        case 'none-set': return t('session.chat.goalNotice.noneSet');
        case 'no-goal': return t('session.chat.goalNotice.noGoal');
        case 'no-goal-budget': return t('session.chat.goalNotice.noGoalBudget');
        case 'nothing-to-clear': return t('session.chat.goalNotice.nothingToClear');
        case 'disabled': return t('session.chat.goalNotice.disabled');
        case 'needs-codex': return t('session.chat.goalNotice.needsCodex', { minimum: notice.minimum, version: notice.version ?? t('session.chat.goalNotice.unknownVersion') });
        case 'failed': return t('session.chat.goalNotice.failed', { error: notice.error });
    }
}

/** Same string as the CLI's dshRunner.ts DSH_SESSION_NOTICE (B-952). */
export const DSH_SESSION_NOTICE = 'DeepSeek Harness session: replies appear one message at a time (dsh sends no word-by-word stream); resuming keeps this transcript but dsh does not replay it; plan mode, slash commands and images are not available. Tool permissions are asked here unless the session runs in yolo mode.';

export function isDshSessionNotice(message: string): boolean {
    return message.trim() === DSH_SESSION_NOTICE;
}
