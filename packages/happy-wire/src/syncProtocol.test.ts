import { describe, expect, it } from 'vitest';
import {
  readSyncError,
  SYNC_HELLO_ERRORS,
  SYNC_SUB_ERRORS,
  sessionSubscribeRequestSchema,
  sessionUnsubscribeRequestSchema,
  syncHelloAckSchema,
  syncHelloRequestSchema,
  syncSubResultSchema,
} from './syncProtocol';

describe('sync protocol v1', () => {
  it('accepts the spec request shapes, cold and warm', () => {
    expect(syncHelloRequestSchema.safeParse({
      v: 1,
      subs: [{ sid: 's1', afterSeq: null }, { sid: 's2', afterSeq: 40, limit: 50 }],
      reason: 'resume',
    }).success).toBe(true);
    expect(sessionSubscribeRequestSchema.safeParse({ v: 1, sid: 's1', afterSeq: 0 }).success).toBe(true);
    expect(sessionUnsubscribeRequestSchema.safeParse({ v: 1, sid: 's1' }).success).toBe(true);
  });

  it('rejects malformed requests', () => {
    for (const bad of [
      {},
      { v: 1 },
      { v: 1, subs: [{ sid: '', afterSeq: null }] },
      { v: 1, subs: [{ sid: 's', afterSeq: -1 }] },
      { v: 1, subs: [{ sid: 's', afterSeq: 1.5 }] },
      { v: 1, subs: [{ sid: 's' }] },
      { v: 1, subs: [{ sid: 's', afterSeq: null, limit: 0 }] },
      { v: 1, subs: Array.from({ length: 65 }, (_, i) => ({ sid: `s${i}`, afterSeq: null })) },
    ]) {
      expect(syncHelloRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('ignores unknown fields (additive wire)', () => {
    const parsed = syncHelloRequestSchema.parse({ v: 1, subs: [{ sid: 's', afterSeq: 1, future: true }], future: 'x' });
    expect(parsed).toEqual({ v: 1, subs: [{ sid: 's', afterSeq: 1 }] });
  });

  it('parses success and error acks, with unknown error codes kept parseable', () => {
    const ok = {
      ok: true, v: 1, serverTime: 1, limits: { maxSubs: 16, maxLimit: 500, gapThreshold: 500 },
      results: [
        { sid: 's1', ok: true, headSeq: 3, hasMore: false, messages: [
          { id: 'm', seq: 3, content: { t: 'encrypted', c: 'x' }, localId: null, createdAt: 1, updatedAt: 1 },
        ] },
        { sid: 's2', ok: true, headSeq: 900, hasMore: false, gapTooLarge: true, oldestSeq: 701, messages: [] },
        { sid: 's3', ok: false, error: 'not_found' },
        { sid: 's4', ok: false, error: 'some_future_code' },
      ],
    };
    expect(syncHelloAckSchema.safeParse(ok).success).toBe(true);
    expect(syncHelloAckSchema.safeParse({ ok: false, error: 'rate_limited', retryAfterMs: 500 }).success).toBe(true);
    expect(syncSubResultSchema.safeParse({ sid: 's', ok: false, error: 'brand_new' }).success).toBe(true);
  });

  it('reads error codes through a whitelist', () => {
    expect(readSyncError('not_found', SYNC_SUB_ERRORS)).toBe('not_found');
    expect(readSyncError('disabled', SYNC_HELLO_ERRORS)).toBe('disabled');
    expect(readSyncError('brand_new', SYNC_SUB_ERRORS)).toBe('unavailable');
    expect(readSyncError(undefined, SYNC_HELLO_ERRORS)).toBe('unavailable');
  });
});
