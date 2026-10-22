/**
 * B-766 W-1 — the 汇报板 (Briefing) as pure functions: which group an item
 * belongs to, what the two tabs show, the counts on the strip / badge, the
 * status chip, and the in-stream pointers. No React, no store (DESIGN §3 A, §6).
 */
import { ATTENTION_LIMITS, ATTENTION_SESSION_CAPABILITY, attentionKindNeedsOwner, isAttentionActive, type AttentionItem, type AttentionOption } from '@slopus/happy-wire';

export type BoardGroup = 'need' | 'asked' | 'report';
export type BoardTab = 'open' | 'done';

export const BOARD_GROUPS: readonly BoardGroup[] = ['need', 'asked', 'report'];
/** D2: answered Owner items stay visible in 「进行中」, newest two only. */
export const RECENT_ANSWERED = 2;

export function boardGroup(item: AttentionItem): BoardGroup {
    if (item.needsOwner) return 'need';
    if (item.kind === 'question' || item.kind === 'request') return 'asked';
    return 'report';
}

/** Still in play: 「进行中」. Answered / resolved / dismissed belong to 「已处理」. */
export function isLive(item: AttentionItem): boolean {
    return isAttentionActive(item.state);
}

export interface BoardSection { group: BoardGroup; items: AttentionItem[]; liveCount: number }

const newest = (a: AttentionItem, b: AttentionItem) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;
const doneAt = (i: AttentionItem) => i.resolvedAt ?? i.updatedAt;

export function buildBoard(items: readonly AttentionItem[], tab: BoardTab): BoardSection[] {
    return BOARD_GROUPS.map((group) => {
        const mine = items.filter((i) => boardGroup(i) === group);
        const live = mine.filter(isLive);
        let shown: AttentionItem[];
        if (tab === 'done') {
            shown = mine.filter((i) => !isLive(i)).sort((a, b) => doneAt(b) - doneAt(a));
        } else if (group === 'need') {
            // Waiting longest first: the oldest open decision is the most overdue.
            shown = [...live].sort((a, b) => a.createdAt - b.createdAt);
        } else if (group === 'asked') {
            const answered = mine.filter((i) => !isLive(i) && i.state !== 'dismissed').sort((a, b) => doneAt(b) - doneAt(a));
            shown = [...live.sort(newest), ...answered.slice(0, RECENT_ANSWERED)];
        } else {
            shown = live.sort(newest);
        }
        return { group, items: shown, liveCount: live.length };
    });
}

export interface BoardCounts {
    /** 「等你」: needsOwner && live — the only number that becomes a badge (§6.1). */
    need: number;
    /** 「未结」: the Owner's own questions / requests still open. */
    asked: number;
    /** 「新汇报」: live reports / answers / pins not yet seen. */
    fresh: number;
}

export function boardCounts(items: readonly AttentionItem[], seen: ReadonlySet<string> = new Set()): BoardCounts {
    let need = 0, asked = 0, fresh = 0;
    for (const item of items) {
        if (!isLive(item)) continue;
        const group = boardGroup(item);
        if (group === 'need') need++;
        else if (group === 'asked') asked++;
        else if (!seen.has(item.id)) fresh++;
    }
    return { need, asked, fresh };
}

/** Red dot on a card: something the Owner has not looked at that is addressed to them. */
export function isUnread(item: AttentionItem, seen: ReadonlySet<string>): boolean {
    return isLive(item) && boardGroup(item) !== 'asked' && !seen.has(item.id);
}

export type StatusTone = 'open' | 'wip' | 'done';
export type StatusKey = 'waiting' | 'unanswered' | 'working' | 'inProgress' | 'answered' | 'completed' | 'decided' | 'dismissed';
export interface ItemStatus { tone: StatusTone; key: StatusKey; choice?: string }

/** The chip at the end of a card's first row; null for reports (they have no workflow). */
export function itemStatus(item: AttentionItem): ItemStatus | null {
    const live = isLive(item);
    if (item.state === 'dismissed') return { tone: 'done', key: 'dismissed' };
    switch (item.kind) {
        case 'request':
            return live ? { tone: 'wip', key: 'working' } : { tone: 'done', key: 'completed' };
        case 'question':
            if (!live) return { tone: 'done', key: 'answered' };
            return item.state === 'in_progress' || item.firstReply ? { tone: 'wip', key: 'inProgress' } : { tone: 'open', key: 'unanswered' };
        case 'decision':
            return live ? { tone: 'open', key: 'waiting' } : { tone: 'done', key: 'decided', choice: item.ownerChoice ?? undefined };
        case 'todo':
        case 'blocked':
            return live ? { tone: 'open', key: 'waiting' } : { tone: 'done', key: 'completed' };
        default:
            return null;
    }
}

/** Kinds whose chip is tinted warn (they wait on the Owner); the rest are neutral. */
export function kindTone(kind: string): 'warn' | 'neutral' {
    return attentionKindNeedsOwner(kind) ? 'warn' : 'neutral';
}

/** The one resolve action a live card offers, by kind (prototype 方案 C). */
export type ResolveAction = 'done' | 'ack' | 'answered' | 'drop';
export function resolveAction(item: AttentionItem): ResolveAction | null {
    if (!isLive(item)) return null;
    switch (item.kind) {
        case 'todo': case 'blocked': return 'done';
        case 'report': case 'answer': case 'pin': return 'ack';
        case 'question': return 'answered';
        case 'request': return 'drop';
        default: return null; // a decision resolves by picking an option
    }
}

/** Answers / reports the lead attached to an Owner item, oldest first. */
export function repliesTo(items: readonly AttentionItem[], id: string): AttentionItem[] {
    return items.filter((i) => i.replyToId === id).sort((a, b) => a.createdAt - b.createdAt);
}

/** What 「追问」 quotes into the composer (`quoteMessage` adds the `> ` itself). */
export function followUpQuote(item: AttentionItem, prefix: string): string {
    return `${prefix}${item.title}`;
}

/**
 * Does this session show a 汇报板 at all? Loaded (the server has the feature)
 * and either it already holds items or its wrapper advertises the board tools
 * (AGENTS #14: decide by session capabilities, not CLI version).
 */
export function sessionHasBoard(items: readonly AttentionItem[] | undefined, capabilities: readonly string[] | undefined): boolean {
    return !!items && (items.length > 0 || capabilities?.includes(ATTENTION_SESSION_CAPABILITY) === true);
}

/**
 * B-766 W-2: the request_human strip from items — the newest open `blocked`
 * item; its `panel` link opens that machine web panel (`?panel=machine&wp=`).
 */
export function blockedBanner(items: readonly AttentionItem[], sessionId: string): { id: string; reason: string; url: string | null } | null {
    const open = items.filter((i) => i.kind === 'blocked' && isLive(i)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!open) return null;
    const panel = open.links?.find((l) => l.type === 'panel')?.ref;
    return { id: open.id, reason: open.title, url: panel ? `/session/${encodeURIComponent(sessionId)}?panel=machine&wp=${encodeURIComponent(panel)}` : null };
}

// ─── Card text (QA5 O1) ───────────────────────────────────────────────────────

/** How far back a cut title may retreat to the previous word boundary. */
const TITLE_WORD_BACKOFF = 24;

/**
 * A title the server clipped at `titleChars` (e.g. 「根目标已提交，等你验收 · <goal>」)
 * ends mid-word with no mark. Back off to the last word boundary when the cut
 * fell inside a Latin word, and say it was cut. CJK text has no word to keep.
 */
export function displayTitle(title: string): string {
    if (title.length < ATTENTION_LIMITS.titleChars - 1) return title;
    let cut = title;
    if (/[A-Za-z0-9]$/.test(cut)) {
        const space = cut.search(/\s\S*$/);
        if (space > 0 && space >= cut.length - TITLE_WORD_BACKOFF) cut = cut.slice(0, space);
    }
    return `${cut.replace(/[\s,，、·:：;；/-]+$/, '')}…`;
}

/** An option's id is shown only when it is a one-character marker the Owner can say (A / B / 1); `accept` / `return` are internal. */
export function optionMarker(option: Pick<AttentionOption, 'id'>): string | null {
    return /^[A-Za-z0-9]$/.test(option.id) ? option.id : null;
}

/** 「负责人推荐」 only when the lead itself marked it; a system item (team submit) recommending accept is not the lead's call. */
export function showsLeadRecommendation(item: Pick<AttentionItem, 'source'>, option: Pick<AttentionOption, 'recommended'>): boolean {
    return option.recommended === true && item.source === 'lead';
}

/** The chosen option as the Owner reads it: `B. 明早`, or just the label for an internal id. */
export function choiceLabel(item: Pick<AttentionItem, 'options'>, choiceId: string): string {
    const option = item.options?.find((o) => o.id === choiceId);
    if (!option) return choiceId;
    const marker = optionMarker(option);
    return marker ? `${marker}. ${option.label}` : option.label;
}
