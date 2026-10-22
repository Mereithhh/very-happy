/**
 * B-766 W-1 — DRAFT client shape of an `AttentionItem` (DESIGN §4.1).
 *
 * Placeholder until the W0 contract (`@slopus/happy-wire` AttentionItem) lands;
 * then this file re-exports the wire type and the board reads synced items.
 * Keep it a strict subset of the design table so the swap is mechanical.
 */
export type AttentionKind = 'decision' | 'todo' | 'blocked' | 'report' | 'answer' | 'question' | 'request' | 'pin';
export type AttentionState = 'open' | 'in_progress' | 'answered' | 'resolved' | 'dismissed';
export type AttentionSource = 'lead' | 'agent' | 'owner' | 'automation' | 'team';

export interface AttentionOption { id: string; label: string; detail?: string; recommended?: boolean }
export interface AttentionLink { type: 'task' | 'pr' | 'commit' | 'url' | 'panel'; ref: string; label?: string }
/** Where「在消息流中定位」lands: an Owner message by localId, a lead reply by message id. */
export interface AttentionAnchor { localId?: string; messageId?: string; snippet?: string }
/** §4.4: the lead's same-turn reply hooked onto an Owner item (`auto` = attached by the CLI fallback). */
export interface AttentionReply { anchor: AttentionAnchor; text: string; at: number; auto?: boolean }

export interface AttentionItem {
    id: string;
    sessionId: string;
    source: AttentionSource;
    kind: AttentionKind;
    key?: string;
    title: string;
    bodyMd?: string;
    options?: AttentionOption[];
    links?: AttentionLink[];
    anchor?: AttentionAnchor;
    /** answer / report → the Owner item it answers. */
    replyToId?: string;
    needsOwner: boolean;
    state: AttentionState;
    ownerChoice?: string;
    firstReply?: AttentionReply;
    /** Same `key` posted again — 「已合并 N 次重复提醒」. */
    repostCount: number;
    createdAt: number;
    updatedAt: number;
    resolvedAt?: number;
}
