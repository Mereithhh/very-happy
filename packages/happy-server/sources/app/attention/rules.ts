import {
    ATTENTION_LIMITS, attentionKindNeedsOwner, attentionPushKind, isAttentionActive,
    type AttentionItem, type AttentionItemPost, type TeamState, type TeamTask,
} from '@slopus/happy-wire';

/** Pure B-766 briefing-board rules (`specs/2026-10-owner-briefing.md`), kept out of the store so they are testable without a database. */

export class AttentionError extends Error {
    constructor(public code: string, public status = 409, public details?: Record<string, unknown>) { super(code); }
}
export function requireAttention(condition: unknown, code: string, status = 409, details?: Record<string, unknown>): asserts condition {
    if (!condition) throw new AttentionError(code, status, details);
}

/** Server-wide switch beside `VH_AGENT_TEAMS_ENABLED`: `true` opens the board; otherwise every route answers 404 `owner_board_disabled` and the hooks do nothing. */
export function attentionEnabled(): boolean {
    return process.env.VH_OWNER_BOARD_ENABLED === 'true';
}

export interface AttentionRow {
    id: string; accountId: string; sessionId: string; teamId: string | null; projectId: string | null;
    source: string; kind: string; key: string | null; lastRequestId: string | null;
    title: string; bodyMd: string | null; options: unknown; links: unknown; anchor: unknown; firstReply: unknown;
    replyToId: string | null; inferred: boolean; needsOwner: boolean; state: string; ownerChoice: string | null; ownerNote: string | null;
    resolvedBy: string | null; resolveNote: string | null; repostCount: number;
    createdAt: Date; updatedAt: Date; resolvedAt: Date | null; pushedAt: Date | null; version: number;
}

const ms = (d: Date | null) => d ? d.getTime() : null;
export function itemView(row: AttentionRow): AttentionItem {
    return {
        id: row.id, sessionId: row.sessionId, teamId: row.teamId, projectId: row.projectId, source: row.source, kind: row.kind, key: row.key,
        title: row.title, bodyMd: row.bodyMd, options: (row.options as AttentionItem['options']) ?? null, links: (row.links as AttentionItem['links']) ?? null,
        anchor: (row.anchor as AttentionItem['anchor']) ?? null, firstReply: (row.firstReply as AttentionItem['firstReply']) ?? null,
        replyToId: row.replyToId, inferred: row.inferred, needsOwner: row.needsOwner, state: row.state, ownerChoice: row.ownerChoice, ownerNote: row.ownerNote,
        resolvedBy: row.resolvedBy, resolveNote: row.resolveNote, repostCount: row.repostCount,
        createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime(), resolvedAt: ms(row.resolvedAt), pushedAt: ms(row.pushedAt), version: row.version,
    };
}

/** Key-less posts dedupe on their request id, so a retried POST never creates a second row. */
export function postKey(input: Pick<AttentionItemPost, 'key' | 'requestId'>): string | null {
    return input.key ?? (input.requestId ? `req:${input.requestId}` : null);
}

export type PostPlan =
    | { action: 'create' }
    | { action: 'noop' }
    /** `reopened`: the row was closed — it opens again and may push once more. */
    | { action: 'repost'; reopened: boolean };

/**
 * What a POST does to the row already holding its `(sessionId, key)`:
 * the same request again is a no-op; otherwise the content is replaced,
 * `repostCount` grows, and a closed row reopens. A repost never changes
 * `kind` / `source` silently: a different kind under the same key is refused.
 */
export function planPost(existing: Pick<AttentionRow, 'kind' | 'state' | 'lastRequestId'> | null, input: Pick<AttentionItemPost, 'kind' | 'requestId'>): PostPlan {
    if (!existing) return { action: 'create' };
    if (input.requestId && existing.lastRequestId === input.requestId) return { action: 'noop' };
    requireAttention(existing.kind === input.kind, 'attention_key_kind_mismatch', 409, { kind: existing.kind });
    return { action: 'repost', reopened: !isAttentionActive(existing.state) && existing.state !== 'answered' };
}

/** State a `reply_to` post leaves its target in: an answer answers the question; a report closes the owner's request. */
export function replyTargetState(kind: string): { state: 'answered' } | { state: 'resolved'; resolvedBy: 'lead' } | null {
    if (kind === 'answer') return { state: 'answered' };
    if (kind === 'report') return { state: 'resolved', resolvedBy: 'lead' };
    return null;
}

export { attentionKindNeedsOwner };

// ─── Root-task submit (reducer.ts `msg()` has no recipient when ownerBotId is null) ──

export const TEAM_SUBMIT_KEY_PREFIX = 'team-submit:';
export const teamSubmitKey = (taskId: string) => `${TEAM_SUBMIT_KEY_PREFIX}${taskId}`;
export const TEAM_SUBMIT_CHOICES = { accept: 'accept', return: 'return' } as const;

export interface RootTaskTransitions {
    /** Root tasks that just became `submitted` — each writes one「待你验收」item. */
    submitted: TeamTask[];
    /** Root tasks that left `submitted` (accepted, returned, cancelled) — their item closes. */
    settled: TeamTask[];
}

/**
 * Root tasks (`ownerBotId === null`, owned by the person) whose submit state
 * changed between two team states. Only the owner can accept / return / cancel
 * them, so a settled item always closes as the owner's decision.
 */
export function rootTaskTransitions(before: TeamState, after: TeamState): RootTaskTransitions {
    const out: RootTaskTransitions = { submitted: [], settled: [] };
    for (const task of after.tasks) {
        if (task.ownerBotId !== null) continue;
        const prior = before.tasks.find(t => t.id === task.id);
        const wasSubmitted = prior?.status === 'submitted' && prior.currentAttemptId === task.currentAttemptId;
        if (task.status === 'submitted' && !wasSubmitted) out.submitted.push(task);
        else if (prior?.status === 'submitted' && task.status !== 'submitted') out.settled.push(task);
    }
    return out;
}

function truncateBytes(text: string, maxBytes: number): string {
    const encoder = new TextEncoder();
    if (encoder.encode(text).length <= maxBytes) return text;
    const suffix = '\n\n…';
    let out = '';
    let used = encoder.encode(suffix).length;
    for (const ch of text) {
        const size = encoder.encode(ch).length;
        if (used + size > maxBytes) break;
        out += ch;
        used += size;
    }
    return out + suffix;
}

/**
 * Caps a server-written title at `maxChars` (UTF-16 units, as the wire
 * schema counts) without splitting a surrogate pair or cutting a
 * word: CJK text breaks between characters, Latin text backs off to the last
 * word boundary — unless that would drop more than half the title, the one
 * case (a single over-long word) that is cut mid-word. The cut ends in「…」.
 */
export function truncateTitle(text: string, maxChars: number): string {
    const trimmed = text.trim();
    if (trimmed.length <= maxChars) return trimmed;
    const chars = Array.from(trimmed);
    const word = /[\p{L}\p{N}_'’-]/u;
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
    const inWord = (i: number) => word.test(chars[i]) && !cjk.test(chars[i]);
    let end = 0;
    for (let used = 0; used + chars[end].length <= maxChars - 1; end++) used += chars[end].length;
    // `end` is the first dropped character: inside a word when both it and the one before are word characters.
    if (inWord(end) && inWord(end - 1)) {
        let back = end - 1;
        while (back > 0 && inWord(back - 1)) back--;
        if (back > maxChars / 2) end = back;
    }
    return chars.slice(0, end).join('').trimEnd() + '…';
}

/**
 * The「待你验收」item for a submitted root task; its options map to the team
 * accept / return actions (ids stay machine values, labels are what the owner
 * reads). Neither is marked recommended: the system has no opinion on the work.
 */
export function teamSubmitItem(team: Pick<TeamState, 'id' | 'name'>, task: TeamTask) {
    const result = task.attempts.find(a => a.id === task.currentAttemptId)?.result ?? '';
    const goal = task.goal.split('\n')[0]?.trim() ?? '';
    return {
        source: 'team' as const,
        kind: 'decision' as const,
        key: teamSubmitKey(task.id),
        title: truncateTitle(`根目标已提交，等你验收 · ${goal}`, ATTENTION_LIMITS.titleChars),
        bodyMd: result ? truncateBytes(result, ATTENTION_LIMITS.bodyBytes) : null,
        options: [
            { id: TEAM_SUBMIT_CHOICES.accept, label: '验收' },
            { id: TEAM_SUBMIT_CHOICES.return, label: '退回' },
        ],
        links: [{ type: 'task' as const, ref: task.id, label: team.name }],
    };
}

// ─── Push ─────────────────────────────────────────────────────────────────────

const PUSH_TITLE: Record<string, string> = {
    decision: '等你决定',
    todo: '等你处理',
    blocked: '需要你',
};

/** Push text for an item, or null when it never pushes (§6.2). */
export function pushPresentation(item: Pick<AttentionRow, 'kind' | 'title' | 'replyToId'> & { inferred?: boolean }): { kind: 'attention' | 'question'; title: string; body: string } | null {
    const kind = attentionPushKind(item);
    if (!kind) return null;
    if (kind === 'question') return { kind, title: '负责人回答了你的问题', body: item.title.slice(0, 500) };
    return { kind, title: `${PUSH_TITLE[item.kind] ?? '需要你'} · ${item.title}`.slice(0, 200), body: item.title.slice(0, 500) };
}

/**
 * `GET ?state=active`: open + in_progress, plus the latest `answered` items per
 * session (D2: settled questions stay visible, the newest two only).
 */
export const ANSWERED_VISIBLE_PER_SESSION = 2;
export function capAnswered<T extends Pick<AttentionRow, 'sessionId' | 'state'>>(rowsNewestFirst: readonly T[]): T[] {
    const seen = new Map<string, number>();
    return rowsNewestFirst.filter(row => {
        if (row.state !== 'answered') return true;
        const n = seen.get(row.sessionId) ?? 0;
        seen.set(row.sessionId, n + 1);
        return n < ANSWERED_VISIBLE_PER_SESSION;
    });
}
