import { afterAll, describe, expect, it } from 'vitest';
import { nextCronAfter, parseCron, isValidTimeZone, canonicalTimeZone, instantOf, wallClockOf, CronParseError } from './cron';
import { initialRunAt, nextIntervalAfter, nextRunAfter, normalizeTrigger } from './schedule';

const iso = (ms: number | null) => ms === null ? null : new Date(ms).toISOString();
const at = (s: string) => Date.parse(s);
const next = (expr: string, tz: string, after: string) => iso(nextCronAfter(parseCron(expr), tz, at(after)));

describe('cron parsing', () => {
    it('expands lists, ranges, steps, names and aliases', () => {
        const f = parseCron('*/15 9-17/4 1,15 jan,JUL mon-fri');
        expect([...f.minute]).toEqual([0, 15, 30, 45]);
        expect([...f.hour]).toEqual([9, 13, 17]);
        expect([...f.dom]).toEqual([1, 15]);
        expect([...f.month]).toEqual([1, 7]);
        expect([...f.dow]).toEqual([1, 2, 3, 4, 5]);
        expect(f.domRestricted && f.dowRestricted).toBe(true);
        expect([...parseCron('0 0 * * 7').dow]).toEqual([0]);
        expect(parseCron('@daily')).toEqual(parseCron('0 0 * * *'));
        expect(parseCron('@weekly').dowRestricted).toBe(true);
    });
    it('rejects malformed expressions', () => {
        for (const bad of ['0 9 * *', '60 * * * *', '0 24 * * *', '0 0 0 * *', '0 0 * 13 *', '0 0 * * 8', '5-3 * * * *', '*/0 * * * *', 'a * * * *', '1,,2 * * * *', '1/2/3 * * * *']) {
            expect(() => parseCron(bad), bad).toThrow(CronParseError);
        }
    });
    it('validates and canonicalizes IANA zones', () => {
        expect(isValidTimeZone('Asia/Singapore')).toBe(true);
        expect(isValidTimeZone('Not/AZone')).toBe(false);
        expect(canonicalTimeZone('asia/singapore')).toBe('Asia/Singapore');
        expect(canonicalTimeZone('utc')).toBe('UTC');
        expect(canonicalTimeZone('Mars/Olympus')).toBeNull();
    });
});

describe('nextCronAfter', () => {
    it('evaluates wall clock in the requested zone', () => {
        expect(next('0 9 * * *', 'Asia/Singapore', '2026-09-25T00:59:00Z')).toBe('2026-09-25T01:00:00.000Z');
        expect(next('0 9 * * *', 'Asia/Singapore', '2026-09-25T01:00:00Z')).toBe('2026-09-26T01:00:00.000Z');
        expect(next('0 9 * * *', 'UTC', '2026-09-25T01:00:00Z')).toBe('2026-09-25T09:00:00.000Z');
    });
    it('is strictly after and truncates seconds', () => {
        expect(next('30 8 * * *', 'UTC', '2026-01-01T08:30:00.000Z')).toBe('2026-01-02T08:30:00.000Z');
        expect(next('30 8 * * *', 'UTC', '2026-01-01T08:29:59.999Z')).toBe('2026-01-01T08:30:00.000Z');
        expect(next('* * * * *', 'UTC', '2026-01-01T08:29:10.000Z')).toBe('2026-01-01T08:30:00.000Z');
    });
    it('applies Vixie day-of-month OR day-of-week when both are restricted', () => {
        // 2026-10-01 is a Thursday; "1st or Monday" fires on the 1st then Monday the 5th.
        expect(next('0 0 1 * mon', 'UTC', '2026-09-30T12:00:00Z')).toBe('2026-10-01T00:00:00.000Z');
        expect(next('0 0 1 * mon', 'UTC', '2026-10-01T00:00:00Z')).toBe('2026-10-05T00:00:00.000Z');
        // only dow restricted: every Monday
        expect(next('0 0 * * mon', 'UTC', '2026-10-01T00:00:00Z')).toBe('2026-10-05T00:00:00.000Z');
        // only dom restricted
        expect(next('0 0 15 * *', 'UTC', '2026-10-01T00:00:00Z')).toBe('2026-10-15T00:00:00.000Z');
    });
    it('jumps months and handles leap days', () => {
        expect(next('0 0 29 2 *', 'UTC', '2026-01-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
        expect(next('0 12 31 * *', 'UTC', '2026-02-01T00:00:00Z')).toBe('2026-03-31T12:00:00.000Z');
        expect(nextCronAfter(parseCron('0 0 31 2 *'), 'UTC', at('2026-01-01T00:00:00Z'))).toBeNull();
    });
    const dstCases: Array<[string, string, string, string]> = [
        // New York springs forward 2026-03-08 02:00 -> 03:00: 02:30 is in the gap.
        ['30 2 * * *', 'America/New_York', '2026-03-07T12:00:00Z', '2026-03-08T07:00:00.000Z'],
        ['30 2 * * *', 'America/New_York', '2026-03-08T07:00:00Z', '2026-03-09T06:30:00.000Z'],
        // New York falls back 2026-11-01: 01:30 occurs twice; fire on the first only.
        ['30 1 * * *', 'America/New_York', '2026-10-31T12:00:00Z', '2026-11-01T05:30:00.000Z'],
        ['30 1 * * *', 'America/New_York', '2026-11-01T05:30:00Z', '2026-11-02T06:30:00.000Z'],
        ['0 * * * *', 'America/New_York', '2026-11-01T05:00:00Z', '2026-11-01T07:00:00.000Z'],
        ['0 9 * * *', 'America/New_York', '2026-03-07T14:00:00Z', '2026-03-08T13:00:00.000Z'],
        ['0 9 * * *', 'America/New_York', '2026-03-08T13:00:00Z', '2026-03-09T13:00:00.000Z'],
        // London falls back 2026-10-25 02:00 BST -> 01:00 GMT: 01:30 BST (00:30Z) once, then 01:30 GMT next day.
        ['30 1 * * *', 'Europe/London', '2026-10-24T12:00:00Z', '2026-10-25T00:30:00.000Z'],
        ['30 1 * * *', 'Europe/London', '2026-10-25T00:30:00Z', '2026-10-26T01:30:00.000Z'],
        // London springs forward 2026-03-29 01:00 GMT -> 02:00 BST: 01:30 is in the gap -> 01:00Z.
        ['30 1 * * *', 'Europe/London', '2026-03-28T12:00:00Z', '2026-03-29T01:00:00.000Z'],
        ['30 1 * * *', 'Europe/London', '2026-03-29T01:00:00Z', '2026-03-30T00:30:00.000Z'],
        // Santiago springs forward 2026-09-06 00:00 (-04) -> 01:00 (-03): midnight is in the gap -> 04:00Z.
        ['0 0 * * *', 'America/Santiago', '2026-09-05T12:00:00Z', '2026-09-06T04:00:00.000Z'],
        ['0 0 * * *', 'America/Santiago', '2026-09-06T04:00:00Z', '2026-09-07T03:00:00.000Z'],
        // Santiago falls back 2026-04-05 00:00 (-03) -> 23:00 (-04) on 04-04: 23:30 twice, first only.
        ['30 23 * * *', 'America/Santiago', '2026-04-04T12:00:00Z', '2026-04-05T02:30:00.000Z'],
        ['30 23 * * *', 'America/Santiago', '2026-04-05T02:30:00Z', '2026-04-06T03:30:00.000Z'],
        // Lord Howe (30-minute shift) falls back 2026-04-05 02:00 (+11) -> 01:30 (+10:30): 01:45 twice.
        ['45 1 * * *', 'Australia/Lord_Howe', '2026-04-04T00:00:00Z', '2026-04-04T14:45:00.000Z'],
        ['45 1 * * *', 'Australia/Lord_Howe', '2026-04-04T14:45:00Z', '2026-04-05T15:15:00.000Z'],
        // Lord Howe springs forward 2026-10-04 02:00 (+10:30) -> 02:30 (+11): 02:15 is in the gap -> 15:30Z.
        ['15 2 * * *', 'Australia/Lord_Howe', '2026-10-03T00:00:00Z', '2026-10-03T15:30:00.000Z'],
        ['15 2 * * *', 'Australia/Lord_Howe', '2026-10-03T15:30:00Z', '2026-10-04T15:15:00.000Z'],
    ];
    const runDstCases = () => { for (const [expr, tz, after, expected] of dstCases) expect(next(expr, tz, after), `${expr} ${tz} after ${after}`).toBe(expected); };
    it('moves DST-gap wall clocks to the first instant after the gap and fires fall-back overlaps once', runDstCases);
    describe('is independent of the process time zone', () => {
        const originalTz = process.env.TZ;
        afterAll(() => { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; });
        it.each(['UTC', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe', 'America/Santiago'])('under TZ=%s', tz => {
            process.env.TZ = tz;
            // Prove the process zone actually switched (Node re-reads TZ on assignment).
            expect(new Date(Date.UTC(2026, 0, 15, 12)).getTimezoneOffset() + (wallClockOf(tz, Date.UTC(2026, 0, 15, 12)) - Date.UTC(2026, 0, 15, 12)) / 60_000).toBe(0);
            runDstCases();
            expect(iso(instantOf('Europe/London', Date.UTC(2026, 9, 25, 1, 30)))).toBe('2026-10-25T00:30:00.000Z');
            expect(iso(instantOf('America/Santiago', Date.UTC(2026, 8, 6, 0, 0)))).toBe('2026-09-06T04:00:00.000Z');
            expect(iso(instantOf('Australia/Lord_Howe', Date.UTC(2026, 9, 4, 2, 15)))).toBe('2026-10-03T15:30:00.000Z');
            expect(iso(wallClockOf('Asia/Kolkata', Date.UTC(2026, 0, 1, 0, 0)))).toBe('2026-01-01T05:30:00.000Z');
        });
    });
});

describe('nextRunAfter', () => {
    it('keeps the interval phase and merges missed periods into one', () => {
        const anchor = at('2026-01-01T00:00:00Z');
        expect(nextIntervalAfter(anchor, 300_000, anchor - 1)).toBe(anchor);
        expect(nextIntervalAfter(anchor, 300_000, anchor)).toBe(anchor + 300_000);
        expect(nextIntervalAfter(anchor, 300_000, anchor + 299_999)).toBe(anchor + 300_000);
        // offline for 3 hours and 7 seconds: single next occurrence on the original phase
        expect(iso(nextIntervalAfter(anchor, 300_000, anchor + 3 * 3_600_000 + 7_000))).toBe('2026-01-01T03:05:00.000Z');
        expect(nextRunAfter({ kind: 'interval', everyMs: 60_000, anchorAt: anchor }, anchor + 90_000)).toBe(anchor + 120_000);
        expect(nextRunAfter({ kind: 'interval', everyMs: 60_000 }, anchor)).toBe(anchor + 60_000);
    });
    it('handles once and manual', () => {
        const t = at('2026-05-01T00:00:00Z');
        expect(nextRunAfter({ kind: 'once', at: t }, t - 1)).toBe(t);
        expect(nextRunAfter({ kind: 'once', at: t }, t)).toBeNull();
        expect(nextRunAfter({ kind: 'manual' }, t)).toBeNull();
        // A once configured in the past is still due initially, then retired.
        expect(initialRunAt({ kind: 'once', at: t }, t + 5)).toBe(t);
        expect(initialRunAt({ kind: 'manual' }, t)).toBeNull();
        expect(initialRunAt({ kind: 'interval', everyMs: 60_000, anchorAt: t }, t)).toBe(t + 60_000);
    });
    it('a cron schedule missed many times yields exactly one next run after now', () => {
        const now = at('2026-09-25T10:00:00Z');
        expect(iso(nextRunAfter({ kind: 'cron', expr: '*/5 * * * *', tz: 'UTC' }, now))).toBe('2026-09-25T10:05:00.000Z');
    });
    it('normalizes triggers and rejects invalid cron or zone', () => {
        const now = at('2026-09-25T10:00:00Z');
        expect(normalizeTrigger({ kind: 'interval', everyMs: 60_000 }, now)).toEqual({ kind: 'interval', everyMs: 60_000, anchorAt: now });
        expect(normalizeTrigger({ kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Singapore' }, now)).toEqual({ kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Singapore' });
        expect(normalizeTrigger({ kind: 'cron', expr: ' 0 9 * * * ', tz: 'asia/singapore' }, now)).toEqual({ kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Singapore' });
        expect(() => normalizeTrigger({ kind: 'cron', expr: '0 9 * *', tz: 'UTC' }, now)).toThrow(expect.objectContaining({ code: 'invalid_cron', status: 400 }));
        expect(() => normalizeTrigger({ kind: 'cron', expr: '0 0 31 2 *', tz: 'UTC' }, now)).toThrow(expect.objectContaining({ code: 'invalid_cron' }));
        expect(() => normalizeTrigger({ kind: 'cron', expr: '0 9 * * *', tz: 'Mars/Olympus' }, now)).toThrow(expect.objectContaining({ code: 'invalid_timezone', status: 400 }));
    });
});
