/**
 * Session message sync v1 — snapshot-reconciled subscriptions (B-807 spec §3,
 * PR-5a / B-811).
 *
 * A user-scoped (web) socket asks the server, over the socket it already
 * receives `update/new-message` on, for the head seq and the increment after
 * its local `afterSeq`, read in ONE statement snapshot. Live pushes keep using
 * the existing `update/new-message` event; v1 adds no push event.
 *
 *   sync-hello           C→S, ack: every subscription at once (connect,
 *                        resume, handover candidate)
 *   session-subscribe    C→S, ack: one session (open, catch-up, gap repair)
 *   session-unsubscribe  C→S, ack: drop one session from the socket's table
 *
 * Wire rules (AGENTS 4/14): additive only, readers ignore unknown fields, and
 * enum-like fields are `z.string()` read through a whitelist — one unknown
 * error code must never make a whole ack unparseable.
 */

import * as z from 'zod';

export const SYNC_PROTOCOL_VERSION = 1;

export const SYNC_HELLO_EVENT = 'sync-hello';
export const SESSION_SUBSCRIBE_EVENT = 'session-subscribe';
export const SESSION_UNSUBSCRIBE_EVENT = 'session-unsubscribe';

/** Subscriptions honoured per socket (hello entries beyond it, and subscribes
 *  past it, get `too_many_subscriptions`). */
export const SYNC_MAX_SUBS = 16;
export const SYNC_DEFAULT_LIMIT = 200;
export const SYNC_MAX_LIMIT = 500;
/** `headSeq - afterSeq` above this returns the latest page instead of the
 *  increment (spec §4.3). Server-configurable; the ack echoes the live value. */
export const SYNC_DEFAULT_GAP_THRESHOLD = 500;
/** Client-side ack deadlines (spec §3.4). */
export const SYNC_ACK_TIMEOUT_MS = 5_000;
export const SYNC_FIRST_HELLO_TIMEOUT_MS = 2_000;

/** Hard cap on the request array, far above SYNC_MAX_SUBS: a longer array is a
 *  client bug (`invalid_request`), a slightly longer one is answered per sub. */
export const SYNC_HELLO_MAX_REQUEST_SUBS = 64;

export const SYNC_HELLO_ERRORS = ['disabled', 'unsupported_client', 'invalid_request', 'rate_limited', 'unavailable'] as const;
export const SYNC_SUB_ERRORS = ['unsupported_client', 'invalid_request', 'rate_limited', 'unavailable', 'not_found', 'too_many_subscriptions', 'disabled'] as const;
export type SyncHelloError = typeof SYNC_HELLO_ERRORS[number];
export type SyncSubError = typeof SYNC_SUB_ERRORS[number];

/** Read-side whitelist: unknown codes fold to `unavailable` (retry with backoff). */
export function readSyncError<T extends string>(raw: unknown, known: readonly T[]): T | 'unavailable' {
  return typeof raw === 'string' && (known as readonly string[]).includes(raw) ? raw as T : 'unavailable';
}

const sessionIdSchema = z.string().min(1).max(128);
const afterSeqSchema = z.number().int().min(0).nullable();
/** Any positive limit is accepted and clamped to SYNC_MAX_LIMIT by the server. */
const limitSchema = z.number().int().min(1).optional();

export const syncSubRequestSchema = z.object({
  sid: sessionIdSchema,
  /** null = cold: return the latest page (like before_seq=MAX). */
  afterSeq: afterSeqSchema,
  limit: limitSchema,
});
export type SyncSubRequest = z.infer<typeof syncSubRequestSchema>;

export const syncHelloRequestSchema = z.object({
  v: z.number().int(),
  subs: z.array(syncSubRequestSchema).max(SYNC_HELLO_MAX_REQUEST_SUBS),
  /** 'connect' | 'resume' | 'handover' | 'retry' — diagnostics only. */
  reason: z.string().max(32).optional(),
});
export type SyncHelloRequest = z.infer<typeof syncHelloRequestSchema>;

export const sessionSubscribeRequestSchema = z.object({
  v: z.number().int(),
  sid: sessionIdSchema,
  afterSeq: afterSeqSchema,
  limit: limitSchema,
});
export type SessionSubscribeRequest = z.infer<typeof sessionSubscribeRequestSchema>;

export const sessionUnsubscribeRequestSchema = z.object({
  v: z.number().int(),
  sid: sessionIdSchema,
});
export type SessionUnsubscribeRequest = z.infer<typeof sessionUnsubscribeRequestSchema>;

/** Byte-for-byte the REST `/v3/sessions/:id/messages` message shape, so the
 *  web merge entry never needs to know which path a message came from. */
export const syncMessageSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  content: z.unknown(),
  localId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type SyncMessage = z.infer<typeof syncMessageSchema>;

export const syncSubResultOkSchema = z.object({
  sid: z.string(),
  ok: z.literal(true),
  /** Session.seq in the same statement snapshot as `messages`. */
  headSeq: z.number().int(),
  /** seq ascending. The latest page when afterSeq was null or gapTooLarge. */
  messages: z.array(syncMessageSchema),
  /** More forward messages exist: continue with afterSeq = last seq. */
  hasMore: z.boolean(),
  gapTooLarge: z.literal(true).optional(),
  /** Smallest seq in `messages` when they are the latest page. */
  oldestSeq: z.number().int().optional(),
});
export const syncSubResultErrorSchema = z.object({
  sid: z.string(),
  ok: z.literal(false),
  error: z.string(),
  retryAfterMs: z.number().optional(),
});
export const syncSubResultSchema = z.union([syncSubResultOkSchema, syncSubResultErrorSchema]);
export type SyncSubResultOk = z.infer<typeof syncSubResultOkSchema>;
export type SyncSubResultError = Omit<z.infer<typeof syncSubResultErrorSchema>, 'error'> & { error: SyncSubError };
export type SyncSubResult = SyncSubResultOk | SyncSubResultError;

export const syncLimitsSchema = z.object({
  maxSubs: z.number().int(),
  maxLimit: z.number().int(),
  gapThreshold: z.number().int(),
});
export type SyncLimits = z.infer<typeof syncLimitsSchema>;

export const syncHelloAckOkSchema = z.object({
  ok: z.literal(true),
  v: z.number().int(),
  serverTime: z.number(),
  limits: syncLimitsSchema,
  /** One per request sub, same order. */
  results: z.array(syncSubResultSchema),
});
export const syncHelloAckErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  retryAfterMs: z.number().optional(),
});
export const syncHelloAckSchema = z.union([syncHelloAckOkSchema, syncHelloAckErrorSchema]);
export type SyncHelloAckOk = z.infer<typeof syncHelloAckOkSchema>;
export type SyncHelloAckError = Omit<z.infer<typeof syncHelloAckErrorSchema>, 'error'> & { error: SyncHelloError };
export type SyncHelloAck = SyncHelloAckOk | SyncHelloAckError;

export type SessionUnsubscribeAck = { ok: true } | { ok: false; error: SyncSubError };

// ---------------------------------------------------------------- v2 (reserved)
// Defined only so nothing else claims these names (spec §3.5, §7). Not emitted
// by any v1 server; v1 clients have no handler and drop them.

export const SYNC_V2_SESSION_MESSAGES_EVENT = 'session-messages';
export const SYNC_V2_SESSION_HEAD_EVENT = 'session-head';
export const SYNC_V2_SESSION_UNSUBSCRIBED_EVENT = 'session-unsubscribed';

export const syncV2SessionMessagesSchema = z.object({
  v: z.number().int(),
  sid: z.string(),
  headSeq: z.number().int(),
  messages: z.array(syncMessageSchema),
});
export const syncV2SessionHeadSchema = z.object({
  v: z.number().int(),
  sid: z.string(),
  headSeq: z.number().int(),
  updatedAt: z.number(),
});
export const syncV2SessionUnsubscribedSchema = z.object({
  v: z.number().int(),
  sid: z.string(),
  /** 'revoked' | 'deleted' */
  reason: z.string(),
});
