/**
 * B-307 on a real Postgres (PGlite): a refused request must not consume budget.
 *
 * The production incident this encodes: `session_state` sat at its 600/min
 * ceiling for an hour on an account whose steady-state use is 4–5 units/min.
 * Every client in this codebase retries a failed state write (the shared
 * `backoff` never gives up and caps its delay at one second), and the old
 * UPSERT charged the cost before comparing — so the retries kept buying the
 * bucket back the instant each window reset, and session CREATION, which
 * shares that bucket, was refused the whole time.
 *
 * Mock-based tests cannot show this: the behaviour lives entirely in the SQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('rate limiter self-lock (B-307, PGlite)', () => {
    const root = mkdtempSync(join(tmpdir(), 'very-happy-rate-selflock-'));
    const pgliteDir = join(root, 'db');
    let allowAuthRequest: typeof import('./authRateLimiter').allowAuthRequest;

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite';
        process.env.PGLITE_DIR = pgliteDir;
        process.env.HANDY_MASTER_SECRET = 'rate-selflock-integration-master';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({
            pgliteDir,
            migrationsDir: join(process.cwd(), 'prisma', 'migrations'),
        });
        ({ allowAuthRequest } = await import('./authRateLimiter'));
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    const limit = { max: 5, windowMs: 60_000 };

    it('a hammering client cannot spend the NEXT window it was refused in', async () => {
        const key = `selflock:${Math.random().toString(36).slice(2)}`;
        let t = 1_000_000;

        // Fill the window.
        for (let i = 0; i < 5; i += 1) {
            expect(await allowAuthRequest(key, limit, undefined, t + i)).toBe(true);
        }
        // 500 refused retries — the shape of a ≤1s infinite backoff loop.
        for (let i = 0; i < 500; i += 1) {
            expect(await allowAuthRequest(key, limit, undefined, t + 100 + i)).toBe(false);
        }

        // The window turns over. Before B-307 the refused retries had already
        // been added to the count, so the fresh window opened over its ceiling
        // and an unrelated caller (session creation) was refused too.
        t += 61_000;
        expect(await allowAuthRequest(key, limit, undefined, t)).toBe(true);
    });

    it('a refused expensive request leaves room for a cheaper one in the same window', async () => {
        const key = `selflock-cost:${Math.random().toString(36).slice(2)}`;
        const t = 2_000_000;

        expect(await allowAuthRequest(key, { ...limit, cost: 4 }, undefined, t)).toBe(true);
        expect(await allowAuthRequest(key, { ...limit, cost: 4 }, undefined, t + 1)).toBe(false);
        // count is still 4 of 5 — not 8 — so this genuinely fits.
        expect(await allowAuthRequest(key, { ...limit, cost: 1 }, undefined, t + 2)).toBe(true);
        expect(await allowAuthRequest(key, { ...limit, cost: 1 }, undefined, t + 3)).toBe(false);
    });

    it('a request costlier than the whole window is refused without opening a bucket', async () => {
        const key = `selflock-huge:${Math.random().toString(36).slice(2)}`;
        const t = 3_000_000;

        expect(await allowAuthRequest(key, { ...limit, cost: 99 }, undefined, t)).toBe(false);
        // It charged nothing, so the window is untouched for everyone else.
        for (let i = 0; i < 5; i += 1) {
            expect(await allowAuthRequest(key, limit, undefined, t + 1 + i)).toBe(true);
        }
    });

    it('still enforces the ceiling — this is not a disabled limiter', async () => {
        const key = `selflock-enforce:${Math.random().toString(36).slice(2)}`;
        const t = 4_000_000;
        for (let i = 0; i < 5; i += 1) {
            expect(await allowAuthRequest(key, limit, undefined, t + i)).toBe(true);
        }
        expect(await allowAuthRequest(key, limit, undefined, t + 10)).toBe(false);
        expect(await allowAuthRequest(key, limit, undefined, t + 59_000)).toBe(false);
    });
});
