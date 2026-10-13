import { describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/ops', () => ({ sessionBash: vi.fn() }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: {}, machines: {} }) } }));

import { createSlotPool } from './slotPool';
import { rowsForReanchor } from './useGitFileDiff';

const rows = [{ type: 'add' as const, text: 'x', oldNo: null, newNo: 1 }];

describe('rowsForReanchor (review 中1)', () => {
    it('never re-anchors against -w rows, even after the toggle went off', () => {
        expect(rowsForReanchor({ phase: 'ready', rows, loadedAt: 1, ignoreWhitespace: true }, true)).toBeNull();
        expect(rowsForReanchor({ phase: 'ready', rows, loadedAt: 1, ignoreWhitespace: false }, true)).toBe(rows);
        expect(rowsForReanchor({ phase: 'ready', rows, loadedAt: 1, ignoreWhitespace: false }, false)).toBeNull();
        expect(rowsForReanchor({ phase: 'loading' }, true)).toBeNull();
    });
});

describe('createSlotPool (review 低4)', () => {
    it('hands a released slot to the next waiter: a late caller cannot make it max+1', async () => {
        const pool = createSlotPool(2);
        let running = 0;
        let peak = 0;
        const job = async () => {
            if (!(await pool.acquire({ cancelled: false }))) return;
            running++; peak = Math.max(peak, running);
            await Promise.resolve();
            running--;
            pool.release();
        };
        const first = [job(), job(), job()];
        // a caller that arrives exactly while a slot is being handed over
        await Promise.resolve();
        const late = job();
        await Promise.all([...first, late]);
        expect(peak).toBeLessThanOrEqual(2);
        expect(pool.inFlight).toBe(0);
    });
    it('a cancelled waiter settles false and never takes a slot', async () => {
        const pool = createSlotPool(1);
        expect(await pool.acquire({ cancelled: false })).toBe(true);
        const t1 = { cancelled: false };
        const t2 = { cancelled: false };
        const w1 = pool.acquire(t1);
        const w2 = pool.acquire(t2);
        pool.cancel(t1);
        expect(await w1).toBe(false);
        expect(pool.waiting).toBe(1);
        t2.cancelled = true;               // cancelled without pool.cancel: skipped at release
        pool.release();
        expect(await w2).toBe(false);
        expect(pool.inFlight).toBe(0);
        expect(await pool.acquire({ cancelled: true })).toBe(false);
    });
});
