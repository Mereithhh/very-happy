/**
 * Live streaming frames for a Claude SDK session (B-309).
 *
 * These ride a BYPASS channel (`session-stream`), not the persistent message
 * stream: the CLI encrypts a frame with the session key and the server relays
 * it to the account's web clients without storing it, allocating a seq, or
 * being able to read it. Frames are transient by construction — dropped while
 * disconnected (`volatile` emit), never replayed, never part of history.
 *
 * The persistent envelope stream remains the single source of truth. A frame
 * only lets the web paint a DRAFT of what is being generated right now; the
 * draft is replaced (never merged) the moment the persisted message carrying
 * the matching `streamKey` arrives.
 *
 * Wire rules apply as everywhere else: old clients must tolerate unknown
 * frames. New discriminators are therefore additive-only, and a consumer that
 * fails to parse a frame drops that frame alone.
 */

import * as z from 'zod';

/** Cap a single delta so one frame can never approach the relay ceiling.
 *
 *  This is a CHARACTER count (what `z.string().max` measures) while the relay
 *  caps BYTES, so the two are not the same currency: CJK is 3 bytes per
 *  character and encryption plus base64 adds ~4/3 on top. A producer must
 *  therefore flush on ENCODED SIZE (see STREAM_FLUSH_MAX_BYTES in the CLI's
 *  streamRelay), and this value is set low enough that even all-CJK text
 *  stays under the relay's 64KB ceiling if someone implements a second
 *  producer against this constant alone. */
export const STREAM_DELTA_MAX_CHARS = 16 * 1024;

export const sessionStreamBlockKindSchema = z.enum(['text', 'thinking']);
export type SessionStreamBlockKind = z.infer<typeof sessionStreamBlockKindSchema>;

/** A content block began. `mid` is the API message id (from the SDK's
 *  `message_start`), `idx` the content block index within it — together the
 *  stable identity a persisted envelope's `streamKey` matches against. */
export const sessionStreamBlockStartSchema = z.object({
  t: z.literal('block-start'),
  mid: z.string().min(1),
  idx: z.number().int().min(0),
  kind: sessionStreamBlockKindSchema,
});

export const sessionStreamBlockDeltaSchema = z.object({
  t: z.literal('block-delta'),
  mid: z.string().min(1),
  idx: z.number().int().min(0),
  text: z.string().max(STREAM_DELTA_MAX_CHARS),
});

export const sessionStreamBlockEndSchema = z.object({
  t: z.literal('block-end'),
  mid: z.string().min(1),
  idx: z.number().int().min(0),
});

/** Quantified progress for the running-state UI. Every field is optional:
 *  which ones the SDK can supply depends on the phase (thinking tokens only
 *  while extended thinking runs, output tokens only once the model emits). */
export const sessionStreamProgressSchema = z.object({
  t: z.literal('progress'),
  thinkingTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  status: z.enum(['requesting', 'compacting']).optional(),
});

/** The turn produced its result. Drafts that were never claimed by a
 *  persisted message are swept shortly after this. */
export const sessionStreamTurnEndSchema = z.object({
  t: z.literal('turn-end'),
});

export const sessionStreamFrameSchema = z.discriminatedUnion('t', [
  sessionStreamBlockStartSchema,
  sessionStreamBlockDeltaSchema,
  sessionStreamBlockEndSchema,
  sessionStreamProgressSchema,
  sessionStreamTurnEndSchema,
]);

export type SessionStreamFrame = z.infer<typeof sessionStreamFrameSchema>;

/** Identity shared by a live draft block and the envelope that supersedes it. */
export function streamKeyOf(messageId: string, blockIndex: number): string {
  return `${messageId}:${blockIndex}`;
}

/** Parse a decrypted frame, returning null instead of throwing: a single
 *  malformed frame must never take down the stream. */
export function parseSessionStreamFrame(value: unknown): SessionStreamFrame | null {
  const parsed = sessionStreamFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
