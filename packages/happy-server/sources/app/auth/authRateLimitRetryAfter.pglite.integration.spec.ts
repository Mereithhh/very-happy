/**
 * B-668 on a real Postgres (PGlite): the per-address daily email-code budget
 * is 10, and a refusal reports when the LONGEST blocking bucket resets.
 *
 * The incident: someone signing in on several devices hit the old 3/day cap on
 * day one, was locked for ~24 h, and the web said "Wait a minute". The bucket
 * semantics live in SQL, so this drives the production limiter + reset lookup.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('auth rate-limit retryAfter (B-668, PGlite)', () => {
    const root = mkdtempSync(join(tmpdir(), 'very-happy-rate-retry-after-'));
    const pgliteDir = join(root, 'db');
    let limiter: typeof import('./authRateLimiter');
    let response: typeof import('./authRateLimitResponse');
    let routes: typeof import('@/app/api/routes/accountAuthRoutes');

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite';
        process.env.PGLITE_DIR = pgliteDir;
        process.env.HANDY_MASTER_SECRET = 'rate-retry-after-integration-master';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({
            pgliteDir,
            migrationsDir: join(process.cwd(), 'prisma', 'migrations'),
        });
        limiter = await import('./authRateLimiter');
        response = await import('./authRateLimitResponse');
        routes = await import('@/app/api/routes/accountAuthRoutes');
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    const at = (nowMs: number) => ({
        consume: (key: string, options: { max: number; windowMs: number; cost?: number }) =>
            limiter.allowAuthRequest(key, options, undefined, nowMs),
        retryAfter: (buckets: ReadonlyArray<import('./authRateLimiter').AuthRateBucket>) =>
            limiter.authRateLimitRetryAfterSeconds(buckets, undefined, nowMs),
    });

    it('allows sends 4-10 of a day, refuses the 11th until the day bucket resets', async () => {
        const email = `person-${Math.random().toString(36).slice(2)}@example.com`;
        const buckets = routes.emailCodeRateBuckets('203.0.113.9', email, {
            globalDailySendLimit: 1_000,
            globalMonthlySendLimit: 10_000,
        });
        const start = 1_800_000_000_000;
        const elevenMinutes = 11 * 60_000;
        // Space sends so the 3-per-10-minute burst bucket never refuses: sends
        // 1–3 in window 0, 4–6 in window 1, 7–9 in window 2, 10 in window 3.
        const sendTimes = Array.from({ length: 10 }, (_, i) => start + Math.floor(i / 3) * elevenMinutes + (i % 3) * 1_000);
        for (const [index, t] of sendTimes.entries()) {
            expect(await response.rateLimitRetryAfter(buckets, at(t)), `send ${index + 1}`).toBeNull();
        }

        const eleventh = sendTimes[9] + 2_000;
        const retryAfter = await response.rateLimitRetryAfter(buckets, at(eleventh));
        // Day bucket opened at `start`; the burst bucket (2/3 used) is not blocking.
        expect(retryAfter).toBe(Math.ceil((start + 24 * 60 * 60_000 - eleventh) / 1000));
        expect(retryAfter).toBeGreaterThan(23 * 60 * 60);

        // Still refused just before the reset, admitted after it.
        const dayReset = start + 24 * 60 * 60_000;
        expect(await response.rateLimitRetryAfter(buckets, at(dayReset - 1_000))).toBe(1);
        expect(await response.rateLimitRetryAfter(buckets, at(dayReset + 1))).toBeNull();
    });

    it('the 4th send inside 10 minutes reports the burst window, not the day', async () => {
        const email = `burst-${Math.random().toString(36).slice(2)}@example.com`;
        const buckets = routes.emailCodeRateBuckets('203.0.113.10', email, {
            globalDailySendLimit: 1_000,
            globalMonthlySendLimit: 10_000,
        });
        const start = 1_810_000_000_000;
        for (let i = 0; i < 3; i++) expect(await response.rateLimitRetryAfter(buckets, at(start + i))).toBeNull();
        const fourth = start + 2 * 60_000;
        expect(await response.rateLimitRetryAfter(buckets, at(fourth))).toBe(8 * 60);
    });

    it('several blocking buckets: answers the longest, even past the refusing one', async () => {
        const id = Math.random().toString(36).slice(2);
        const minute = { key: `multi:${id}:minute`, max: 1, windowMs: 60_000 };
        const hour = { key: `multi:${id}:hour`, max: 1, windowMs: 60 * 60_000 };
        const t = 1_820_000_000_000;
        expect(await response.rateLimitRetryAfter([minute, hour], at(t))).toBeNull();
        // The minute bucket refuses first; the sequential consumer never reaches
        // the hour bucket, yet the hour bucket is the one that decides the retry.
        expect(await response.rateLimitRetryAfter([minute, hour], at(t + 10_000))).toBe(60 * 60 - 10);
        // After the minute bucket resets, the hour bucket still blocks with the same deadline.
        expect(await response.rateLimitRetryAfter([minute, hour], at(t + 120_000))).toBe(60 * 60 - 120);
    });
});
