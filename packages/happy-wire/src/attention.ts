import { z } from 'zod';

// B-766 Owner briefing board (「汇报板」/ Briefing; spec
// `specs/2026-10-owner-briefing.md`). One plaintext server table holds every
// "needs you" item: lead board posts, `request_human`, the owner's own
// questions and pins, root-task submits and (later) automation attention.
// Same trust tier as Teams / Projects (Owner decision D1).
//
// Request schemas are strict (the server validates them). The item and update
// schemas keep `source` / `kind` / `state` / `resolvedBy` as open strings so a
// client tolerates values added by a newer server (AGENTS #4/#14); use the
// `ATTENTION_*` lists and helpers below to interpret them.

/** Session capability a wrapper advertises once it registers the `owner_board_*` tools and posts `request_human` as an item. */
export const ATTENTION_SESSION_CAPABILITY = 'owner-board-v1';
/** Error code every `/v1/attention-items` route returns (HTTP 404) while the server feature flag is off. */
export const ATTENTION_DISABLED_ERROR = 'owner_board_disabled';

export const ATTENTION_LIMITS = {
    titleChars: 120,
    bodyBytes: 8 * 1024,
    keyChars: 256,
    options: { min: 2, max: 4 },
    optionIdChars: 16,
    optionLabelChars: 120,
    optionDetailChars: 1000,
    links: 16,
    linkRefChars: 2048,
    linkLabelChars: 120,
    snippetChars: 200,
    noteChars: 2000,
    listMax: 200,
    /** Open `needsOwner` items per session before the playbook asks the lead to merge or drop stale ones (§5.1 rule 6). */
    openPerSessionSoftCap: 5,
} as const;

/** Who created the item. `agent` = `request_human`; `team` = a root-task `team_submit`. */
export const ATTENTION_SOURCES = ['lead', 'agent', 'owner', 'automation', 'team'] as const;
export type AttentionSource = typeof ATTENTION_SOURCES[number];
export const ATTENTION_KINDS = ['decision', 'todo', 'blocked', 'report', 'answer', 'question', 'request', 'pin'] as const;
export type AttentionKind = typeof ATTENTION_KINDS[number];
/** `answered` is a settled question/request that stays visible (latest 2 per session, D2); `resolved`/`dismissed` are closed. */
export const ATTENTION_STATES = ['open', 'in_progress', 'answered', 'resolved', 'dismissed'] as const;
export type AttentionState = typeof ATTENTION_STATES[number];
export const ATTENTION_ACTIVE_STATES: readonly AttentionState[] = ['open', 'in_progress'];
export const ATTENTION_RESOLVED_BY = ['owner', 'owner-replied', 'lead', 'auto-first-reply', 'run-done', 'session-archived'] as const;
export type AttentionResolvedBy = typeof ATTENTION_RESOLVED_BY[number];

/** Kinds the lead may post with `owner_board_post`; the other kinds come from their own paths. */
export const OWNER_BOARD_POST_KINDS = ['decision', 'todo', 'report', 'answer'] as const;
export type OwnerBoardPostKind = typeof OWNER_BOARD_POST_KINDS[number];
export const OWNER_BOARD_RESOLVE_OUTCOMES = ['done', 'answered', 'dropped', 'superseded'] as const;
export type OwnerBoardResolveOutcome = typeof OWNER_BOARD_RESOLVE_OUTCOMES[number];

/**
 * localId prefix of the owner chat message the Web sends for a board action
 * (`board-<itemId>-<nonce>`: a choice or a 追问). Message bodies are encrypted,
 * so the server's owner-replied rule reads only this plaintext prefix: a board
 * message never auto-resolves some other open decision (the board action
 * already settled its own item through `owner-respond`).
 */
export const ATTENTION_BOARD_LOCAL_ID_PREFIX = 'board-';
export function attentionBoardLocalId(itemId: string, nonce: string): string {
    return `${ATTENTION_BOARD_LOCAL_ID_PREFIX}${itemId}-${nonce}`;
}
export function isAttentionBoardLocalId(localId: string | null | undefined): boolean {
    return typeof localId === 'string' && localId.startsWith(ATTENTION_BOARD_LOCAL_ID_PREFIX);
}

/** Badge + push: only these kinds wait on the owner (§6.1). */
export function attentionKindNeedsOwner(kind: string): boolean {
    return kind === 'decision' || kind === 'todo' || kind === 'blocked';
}

export function isAttentionActive(state: string): boolean {
    return (ATTENTION_ACTIVE_STATES as readonly string[]).includes(state);
}

/** What a `resolve` outcome leaves the item in. Unknown outcomes close it as `resolved`. */
export function attentionResolveState(outcome: string): AttentionState {
    if (outcome === 'answered') return 'answered';
    if (outcome === 'dropped' || outcome === 'superseded') return 'dismissed';
    return 'resolved';
}

/**
 * Push kind for an item, or null when it never pushes (§6.2). The server sends
 * at most one push per item (`pushedAt`), plus one more only after a reopen.
 * `answer` pushes only when it answers an owner question (`replyToId`).
 * An `inferred` draft (D5) never pushes: it shows on the board and badge only,
 * until the lead posts the same key and confirms it.
 */
export function attentionPushKind(item: { kind: string; replyToId?: string | null; inferred?: boolean }): 'attention' | 'question' | null {
    if (item.inferred) return null;
    if (attentionKindNeedsOwner(item.kind)) return 'attention';
    if (item.kind === 'answer' && item.replyToId) return 'question';
    return null;
}

const id = z.string().min(1).max(128);
const title = z.string().trim().min(1).max(ATTENTION_LIMITS.titleChars);
const bodyMd = z.string().max(ATTENTION_LIMITS.bodyBytes * 4)
    .refine(v => new TextEncoder().encode(v).length <= ATTENTION_LIMITS.bodyBytes, 'body exceeds 8KB');
const note = z.string().max(ATTENTION_LIMITS.noteChars);
const requestId = z.string().min(1).max(128);
const key = z.string().min(1).max(ATTENTION_LIMITS.keyChars);

export const AttentionOptionSchema = z.object({
    id: z.string().trim().min(1).max(ATTENTION_LIMITS.optionIdChars),
    label: z.string().trim().min(1).max(ATTENTION_LIMITS.optionLabelChars),
    detail: z.string().max(ATTENTION_LIMITS.optionDetailChars).optional(),
    recommended: z.boolean().optional(),
});
export type AttentionOption = z.infer<typeof AttentionOptionSchema>;
const options = z.array(AttentionOptionSchema).min(ATTENTION_LIMITS.options.min).max(ATTENTION_LIMITS.options.max)
    .refine(o => new Set(o.map(x => x.id)).size === o.length, 'option ids must be unique');

export const ATTENTION_LINK_TYPES = ['task', 'pr', 'commit', 'url', 'panel'] as const;
export const AttentionLinkSchema = z.object({
    type: z.enum(ATTENTION_LINK_TYPES),
    ref: z.string().trim().min(1).max(ATTENTION_LIMITS.linkRefChars),
    label: z.string().max(ATTENTION_LIMITS.linkLabelChars).optional(),
});
export type AttentionLink = z.infer<typeof AttentionLinkSchema>;
const links = z.array(AttentionLinkSchema).max(ATTENTION_LIMITS.links);

/** Points back into the message stream (`chatJump`): `localId` for user messages, `messageId` for agent messages. */
export const AttentionAnchorSchema = z.object({
    localId: z.string().min(1).max(256).optional(),
    messageId: z.string().min(1).max(128).optional(),
    snippet: z.string().max(ATTENTION_LIMITS.snippetChars).optional(),
}).refine(a => a.localId !== undefined || a.messageId !== undefined, 'anchor needs localId or messageId');
export type AttentionAnchor = z.infer<typeof AttentionAnchorSchema>;

// ─── Item (response / update payload) ────────────────────────────────────────

export const AttentionItemSchema = z.object({
    id: z.string(),
    sessionId: z.string(),
    teamId: z.string().nullable(),
    projectId: z.string().nullable(),
    source: z.string(),
    kind: z.string(),
    key: z.string().nullable(),
    title: z.string(),
    bodyMd: z.string().nullable(),
    options: z.array(AttentionOptionSchema.passthrough()).nullable(),
    links: z.array(z.object({ type: z.string(), ref: z.string(), label: z.string().optional() }).passthrough()).nullable(),
    anchor: z.object({ localId: z.string().optional(), messageId: z.string().optional(), snippet: z.string().optional() }).nullable(),
    /** The lead's first in-stream reply to an owner question (auto-attached by the CLI, §4.4). */
    firstReply: z.object({ localId: z.string().optional(), messageId: z.string().optional(), snippet: z.string().optional() }).nullable(),
    replyToId: z.string().nullable(),
    /** D5: drafted by the CLI from the lead's text (「自动识别」), not posted by the lead. No push until the lead confirms it. */
    inferred: z.boolean().default(false),
    needsOwner: z.boolean(),
    state: z.string(),
    ownerChoice: z.string().nullable(),
    ownerNote: z.string().nullable(),
    resolvedBy: z.string().nullable(),
    /** The lead's `owner_board_resolve` note. */
    resolveNote: z.string().nullable(),
    /** Times the same `(sessionId, key)` was posted again and folded into this item. */
    repostCount: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    resolvedAt: z.number().nullable(),
    pushedAt: z.number().nullable(),
    /** Bumped on every mutation; clients keep the highest version per id. */
    version: z.number(),
});
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

/** Socket `update` body sent to the account after every item mutation (full item snapshot; items are never hard-deleted). */
export const UpdateAttentionItemBodySchema = z.object({
    t: z.literal('attention-item'),
    item: AttentionItemSchema,
});
export type UpdateAttentionItemBody = z.infer<typeof UpdateAttentionItemBodySchema>;

// ─── REST: /v1/attention-items ───────────────────────────────────────────────

/**
 * POST /v1/attention-items → `AttentionItemPostResponse`.
 * Upserts by `(sessionId, key)`: a repost of an active item updates it and bumps
 * `repostCount`; a repost of a closed one reopens it. Without `key`, `requestId`
 * makes the call idempotent. A retry with the same `requestId` returns the item
 * unchanged (`created:false`, no repost bump).
 */
export const AttentionItemPostSchema = z.object({
    sessionId: id,
    source: z.enum(ATTENTION_SOURCES),
    kind: z.enum(ATTENTION_KINDS),
    title,
    bodyMd: bodyMd.optional(),
    options: options.optional(),
    links: links.optional(),
    anchor: AttentionAnchorSchema.optional(),
    replyToId: id.optional(),
    key: key.optional(),
    requestId: requestId.optional(),
    /**
     * D5 draft: only the CLI's auto-detect path sets it (`owner_board_post` does
     * not expose it). A repost of the key with `false` confirms the draft (and
     * pushes once); a draft never downgrades a confirmed item.
     */
    inferred: z.boolean().default(false),
}).refine(p => p.kind !== 'decision' || p.options !== undefined, { message: 'decision needs 2-4 options', path: ['options'] });
export type AttentionItemPost = z.input<typeof AttentionItemPostSchema>;

/** PATCH /v1/attention-items/:id → `AttentionItemResponse`. Omitted fields keep their value; `appendMd` appends to `bodyMd`. */
export const AttentionItemPatchSchema = z.object({
    title: title.optional(),
    bodyMd: bodyMd.nullable().optional(),
    appendMd: bodyMd.optional(),
    options: options.nullable().optional(),
    links: links.nullable().optional(),
    /** Only `question` → `request` (the lead reclassifies an owner message, §4.4). */
    kind: z.literal('request').optional(),
    state: z.enum(['open', 'in_progress', 'answered']).optional(),
    firstReply: AttentionAnchorSchema.optional(),
    requestId: requestId.optional(),
}).refine(p => !(p.bodyMd !== undefined && p.appendMd !== undefined), 'use bodyMd or appendMd, not both');
export type AttentionItemPatch = z.infer<typeof AttentionItemPatchSchema>;

/** POST /v1/attention-items/:id/resolve → `AttentionItemResponse`. Agent-side close (lead / CLI). */
export const AttentionItemResolveSchema = z.object({
    outcome: z.enum(OWNER_BOARD_RESOLVE_OUTCOMES),
    note: note.optional(),
    /** Defaults to `lead`. */
    by: z.enum(['lead', 'auto-first-reply']).optional(),
    requestId: requestId.optional(),
});
export type AttentionItemResolve = z.infer<typeof AttentionItemResolveSchema>;

/**
 * POST /v1/attention-items/:id/owner-respond → `AttentionItemResponse`.
 * Board buttons. `choose` (decision option) and `resolve` (知道了 / 标为完成 /
 * 已经答了 / 不用跟了) close the item with `resolvedBy:'owner'`; `reopen` is 追问.
 * The Web client sends the matching owner chat message itself
 * (`meta.boardItemId` / `meta.replyToItem`, localId from `attentionBoardLocalId`);
 * the server never writes session content.
 * A root-task submit item maps `choose` to the team accept / return action.
 */
export const AttentionItemOwnerRespondSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('choose'), choice: z.string().trim().min(1).max(ATTENTION_LIMITS.optionIdChars), note: note.optional() }),
    z.object({ action: z.literal('resolve'), note: note.optional() }),
    z.object({ action: z.literal('reopen'), note: note.optional() }),
]);
export type AttentionItemOwnerRespond = z.infer<typeof AttentionItemOwnerRespondSchema>;

/** GET /v1/attention-items → `AttentionItemListResponse`, newest `updatedAt` first. */
export const AttentionItemListQuerySchema = z.object({
    sessionId: id.optional(),
    /** `open` (default) = open + in_progress; `active` adds the latest `answered`; `all` = everything. */
    state: z.enum(['open', 'active', 'all']).optional(),
    needsOwner: z.enum(['1', 'true', '0', 'false']).optional(),
    /** Epoch ms; only items updated after it. */
    since: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(ATTENTION_LIMITS.listMax).optional(),
});
export type AttentionItemListQuery = z.infer<typeof AttentionItemListQuerySchema>;

export type AttentionItemPostResponse = { item: AttentionItem; created: boolean };
export type AttentionItemResponse = { item: AttentionItem };
export type AttentionItemListResponse = { items: AttentionItem[] };
export type AttentionErrorResponse = { error: string };

// ─── MCP tools (CLI `startHappyServer`, snake_case like the other team tools) ──

/** `owner_board_post`. `anchor` defaults to `this_turn`, which the CLI resolves to this turn's reply before calling the server. */
export const OwnerBoardPostInputSchema = z.object({
    kind: z.enum(OWNER_BOARD_POST_KINDS),
    title,
    body_md: bodyMd.optional(),
    options: options.optional(),
    links: links.optional(),
    reply_to: id.optional(),
    key: key.optional(),
    anchor: z.union([z.literal('this_turn'), z.object({ localId: z.string().min(1).max(256) })]).optional(),
    request_id: requestId,
}).refine(p => p.kind !== 'decision' || p.options !== undefined, { message: 'decision needs 2-4 options', path: ['options'] });
export type OwnerBoardPostInput = z.infer<typeof OwnerBoardPostInputSchema>;
export type OwnerBoardPostOutput = { id: string; created: boolean };

export const OwnerBoardUpdateInputSchema = z.object({
    id,
    title: title.optional(),
    body_md: bodyMd.optional(),
    append_md: bodyMd.optional(),
    options: options.optional(),
    links: links.optional(),
    state: z.enum(['open', 'in_progress']).optional(),
    request_id: requestId,
}).refine(p => !(p.body_md !== undefined && p.append_md !== undefined), 'use body_md or append_md, not both');
export type OwnerBoardUpdateInput = z.infer<typeof OwnerBoardUpdateInputSchema>;
export type OwnerBoardUpdateOutput = { item: AttentionItem };

export const OwnerBoardResolveInputSchema = z.object({
    id,
    outcome: z.enum(OWNER_BOARD_RESOLVE_OUTCOMES),
    note: note.optional(),
    request_id: requestId,
});
export type OwnerBoardResolveInput = z.infer<typeof OwnerBoardResolveInputSchema>;
export type OwnerBoardResolveOutput = { item: AttentionItem };

/** `owner_board_list`: this session's items, with the owner's choice and note. `state` defaults to `open`. */
export const OwnerBoardListInputSchema = z.object({
    state: z.enum(['open', 'all']).optional(),
    /** ISO-8601 or epoch ms. */
    since: z.string().min(1).max(64).optional(),
});
export type OwnerBoardListInput = z.infer<typeof OwnerBoardListInputSchema>;
export type OwnerBoardListOutput = { items: AttentionItem[] };

/** Tool input → REST body. `anchor` must already be resolved (the `this_turn` sentinel is CLI-side). */
export function ownerBoardPostToRest(sessionId: string, input: OwnerBoardPostInput, anchor?: AttentionAnchor): AttentionItemPost {
    return {
        sessionId,
        source: 'lead',
        kind: input.kind,
        title: input.title,
        ...(input.body_md !== undefined ? { bodyMd: input.body_md } : {}),
        ...(input.options ? { options: input.options } : {}),
        ...(input.links ? { links: input.links } : {}),
        ...(anchor ? { anchor } : {}),
        ...(input.reply_to ? { replyToId: input.reply_to } : {}),
        ...(input.key ? { key: input.key } : {}),
        requestId: input.request_id,
        inferred: false,
    };
}
