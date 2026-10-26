/**
 * B-836 QA16 on a real Postgres (PGlite): several windows are charged
 * all-or-nothing. Before the fix feedback charged the day bucket, then the
 * hour bucket refused — 15 refused retries left day=20 and the account could
 * not send feedback again that day.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

describe('allowAuthRequests: all-or-nothing windows (B-836, PGlite)', () => {
    const root = mkdtempSync(join(tmpdir(), 'very-happy-rate-all-'));
    const pgliteDir = join(root, 'db');
    let allowAuthRequests: typeof import('./authRateLimiter').allowAuthRequests;
    let db: PrismaClient;

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite';
        process.env.PGLITE_DIR = pgliteDir;
        process.env.HANDY_MASTER_SECRET = 'rate-all-integration-master';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir, migrationsDir: join(process.cwd(), 'prisma', 'migrations') });
        ({ allowAuthRequests } = await import('./authRateLimiter'));
        ({ db } = await import('@/storage/db'));
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    const windows = () => {
        const id = Math.random().toString(36).slice(2);
        return [
            { key: `all-day:${id}`, max: 20, windowMs: 24 * 3_600_000 },
            { key: `all-hour:${id}`, max: 5, windowMs: 3_600_000 },
        ];
    };
    const count = async (key: string) => {
        const row = await db.authRateLimitBucket.findUnique({ where: { key } });
        return row ? Number(row.count) : 0;
    };

    it('both fit: each window is charged exactly once', async () => {
        const [day, hour] = windows();
        expect(await allowAuthRequests([day, hour], 1_000_000)).toBe(true);
        expect([await count(day.key), await count(hour.key)]).toEqual([1, 1]);
    });

    it('hour refuses: day is not charged, and the next hour is accepted', async () => {
        const [day, hour] = windows();
        const t = 2_000_000;
        for (let i = 0; i < 5; i += 1) expect(await allowAuthRequests([day, hour], t + i)).toBe(true);
        for (let i = 0; i < 15; i += 1) expect(await allowAuthRequests([day, hour], t + 100 + i)).toBe(false);
        expect([await count(day.key), await count(hour.key)]).toEqual([5, 5]);
        // QA16's repro: the hour window turns over and the day still has room.
        expect(await allowAuthRequests([day, hour], t + 3_600_001)).toBe(true);
        expect([await count(day.key), await count(hour.key)]).toEqual([6, 1]);
    });

    it('day refuses: hour is not charged', async () => {
        const [day, hour] = windows();
        const fullDay = { ...day, max: 2 };
        const t = 3_000_000;
        expect(await allowAuthRequests([fullDay, hour], t)).toBe(true);
        expect(await allowAuthRequests([fullDay, hour], t + 1)).toBe(true);
        expect(await allowAuthRequests([fullDay, hour], t + 2)).toBe(false);
        expect([await count(day.key), await count(hour.key)]).toEqual([2, 2]);
        // Same order reversed: the refusing window comes first, the later one untouched.
        expect(await allowAuthRequests([hour, fullDay], t + 3)).toBe(false);
        expect(await count(hour.key)).toBe(2);
    });

    it('concurrent submits never overspend either window', async () => {
        const [day, hour] = windows();
        const results = await Promise.all(Array.from({ length: 12 }, () => allowAuthRequests([day, hour], 4_000_000)));
        expect(results.filter(Boolean)).toHaveLength(5);
        expect([await count(day.key), await count(hour.key)]).toEqual([5, 5]);
    });
});
