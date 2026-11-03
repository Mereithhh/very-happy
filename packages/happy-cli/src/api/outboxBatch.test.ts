import { describe, expect, it } from 'vitest'
import { OUTBOX_BATCH_LIMITS, outboxItemBytes, planOutboxBatch, type OutboxItem } from './outboxBatch'

const item = (bytes: number, backfill = false, id = 'l'): OutboxItem => ({ content: 'x'.repeat(bytes), localId: id, ...(backfill ? { backfill: true } : {}) })

describe('B-880 planOutboxBatch', () => {
    it('empty outbox → nothing to send', () => {
        expect(planOutboxBatch([])).toBeNull()
    })

    it('small messages go 100 per POST (the server maximum), not 50', () => {
        const items = Array.from({ length: 250 }, () => item(100, true))
        expect(planOutboxBatch(items)).toEqual({ kind: 'send', count: 100, backfill: true })
    })

    it('a batch never exceeds the request body budget (the 413 that stalled a replay forever)', () => {
        // 50 envelopes with ~60 KB Write inputs: the old fixed batch of 50 was ~3 MB.
        const items = Array.from({ length: 50 }, () => item(80_000, true))
        const plan = planOutboxBatch(items)
        expect(plan).toEqual({ kind: 'send', count: 9, backfill: true })
        const bytes = items.slice(0, 9).reduce((sum, i) => sum + outboxItemBytes(i), 0)
        expect(bytes).toBeLessThanOrEqual(OUTBOX_BATCH_LIMITS.maxBytes)
        expect(bytes + outboxItemBytes(items[9])).toBeGreaterThan(OUTBOX_BATCH_LIMITS.maxBytes)
    })

    it('one large message still goes alone, under the per-item limit', () => {
        expect(planOutboxBatch([item(900_000), item(10)])).toEqual({ kind: 'send', count: 1, backfill: false })
    })

    it('a message that can never fit one request is reported, not retried forever', () => {
        expect(planOutboxBatch([item(OUTBOX_BATCH_LIMITS.maxItemBytes), item(10)])).toEqual({ kind: 'oversize', bytes: OUTBOX_BATCH_LIMITS.maxItemBytes + 33 })
        // … and does not ride inside a batch either
        expect(planOutboxBatch([item(10), item(OUTBOX_BATCH_LIMITS.maxItemBytes)])).toEqual({ kind: 'send', count: 1, backfill: false })
    })

    it('a backfill batch never carries a live message (only the replay carries the backfill header)', () => {
        expect(planOutboxBatch([item(10, true), item(10, true), item(10), item(10, true)])).toEqual({ kind: 'send', count: 2, backfill: true })
        expect(planOutboxBatch([item(10), item(10, true)])).toEqual({ kind: 'send', count: 1, backfill: false })
    })
})
