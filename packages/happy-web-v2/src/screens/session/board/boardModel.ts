/**
 * B-766 W-1 — the 汇报板 (Briefing) as pure functions: which group an item
 * belongs to, what the two tabs show, the counts on the strip / badge, the
 * status chip, and the in-stream pointers. No React, no store (DESIGN §3 A, §6).
 */
import { ATTENTION_SESSION_CAPABILITY, attentionKindNeedsOwner, isAttentionActive, type AttentionItem } from '@slopus/happy-wire';

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

/** 「已上板」pointers under a transcript message: items the agent side posted from that reply. */
export function pointersAt(items: readonly AttentionItem[], messageId: string): AttentionItem[] {
    return items
        .filter((i) => i.anchor?.messageId === messageId && i.source !== 'owner')
        .sort((a, b) => a.createdAt - b.createdAt);
}

/** Answers / reports the lead attached to an Owner item, oldest first. */
export function repliesTo(items: readonly AttentionItem[], id: string): AttentionItem[] {
    return items.filter((i) => i.replyToId === id).sort((a, b) => a.createdAt - b.createdAt);
}

/** Text the composer gets for 「追问」 until W0 carries `meta.replyToItem`. */
export function followUpQuote(item: AttentionItem, prefix: string): string {
    return `> ${prefix}${item.title}\n\n`;
}

/**
 * Does this session show a 汇报板 at all? Loaded (the server has the feature)
 * and either it already holds items or its wrapper advertises the board tools
 * (AGENTS #14: decide by session capabilities, not CLI version).
 */
export function sessionHasBoard(items: readonly AttentionItem[] | undefined, capabilities: readonly string[] | undefined): boolean {
    return !!items && (items.length > 0 || capabilities?.includes(ATTENTION_SESSION_CAPABILITY) === true);
}
