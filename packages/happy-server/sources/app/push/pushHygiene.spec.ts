import { describe, expect, it } from 'vitest';
import {
    PUSH_PAYLOAD_BUDGET_BYTES,
    TTL_COMPLETION_S,
    TTL_DECISION_S,
    TTL_TEST_S,
    SEEN_KV_MAX_BYTES,
    buildWebPushPayload,
    capSeenAt,
    parseSeenKvValue,
    pushTargetKey,
    selectSeenWatermark,
    webPushTopic,
    webPushTtlSeconds,
} from './pushHygiene';

const DAY = 24 * 60 * 60 * 1000;

describe('webPushTopic (RFC 8030 §5.4)', () => {
    it('is ≤32 chars of the URL-safe base64 alphabet, stable per key, distinct across keys', () => {
        for (const key of ['cmabc123', 't:term-1', 'test', 'x'.repeat(500), '会话/?#']) {
            const topic = webPushTopic(key);
            expect(topic.length).toBeLessThanOrEqual(32);
            expect(topic).toMatch(/^[A-Za-z0-9_-]+$/);
            expect(webPushTopic(key)).toBe(topic);
        }
        expect(webPushTopic('a')).not.toBe(webPushTopic('b'));
        expect(webPushTopic('cmabc123')).not.toContain('cmabc123');
    });
});

describe('webPushTtlSeconds', () => {
    it('decision 24h, completion 6h, test 5min, unknown → the longer decision TTL', () => {
        expect(webPushTtlSeconds('permission')).toBe(TTL_DECISION_S);
        expect(webPushTtlSeconds('question')).toBe(TTL_DECISION_S);
        expect(webPushTtlSeconds('done')).toBe(TTL_COMPLETION_S);
        expect(webPushTtlSeconds('completed')).toBe(TTL_COMPLETION_S);
        expect(webPushTtlSeconds('test')).toBe(TTL_TEST_S);
        expect(webPushTtlSeconds(undefined)).toBe(TTL_DECISION_S);
        expect(webPushTtlSeconds('brand-new-kind')).toBe(TTL_DECISION_S);
        expect(TTL_DECISION_S).toBe(86400);
        expect(TTL_COMPLETION_S).toBe(21600);
    });
});

describe('pushTargetKey (mirrors the SW vhPushKey)', () => {
    it('sessionId first, then /session and /terminal urls, test kind, else null', () => {
        expect(pushTargetKey({ sessionId: 's1', url: '/session/other' })).toBe('s1');
        expect(pushTargetKey({ url: '/session/s2' })).toBe('s2');
        expect(pushTargetKey({ url: '/terminal/m1?tid=t9' })).toBe('t:t9');
        expect(pushTargetKey({ url: '/terminal/m1' })).toBeNull();
        expect(pushTargetKey({ url: '/session/pending-1' })).toBeNull();
        expect(pushTargetKey({ kind: 'test', url: '/settings/notifications' })).toBe('test');
        expect(pushTargetKey({})).toBeNull();
        expect(pushTargetKey({ url: 'https://evil/session/x' })).toBeNull();
    });
});

describe('parseSeenKvValue', () => {
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    it('decodes the web KV blob and drops junk', () => {
        expect(parseSeenKvValue(enc({ seen: { a: 5, b: -1, c: 'x', '': 3, d: 7 } }))).toEqual({ a: 5, d: 7 });
        expect(parseSeenKvValue(new TextEncoder().encode('not json'))).toEqual({});
        expect(parseSeenKvValue(enc({ seen: [1, 2] }))).toEqual({});
        expect(parseSeenKvValue(null)).toEqual({});
    });
    it('treats an oversized blob (>64KB) as empty (review #4)', () => {
        const seen: Record<string, number> = {};
        for (let i = 0; i < 3000; i++) seen[`session-${i}-${'x'.repeat(10)}`] = 1_700_000_000_000 + i;
        const raw = enc({ seen });
        expect(raw.length).toBeGreaterThan(SEEN_KV_MAX_BYTES);
        expect(parseSeenKvValue(raw)).toEqual({});
    });
});

describe('capSeenAt (review #1)', () => {
    it('clamps future stamps to the server write time, keeps older ones', () => {
        expect(capSeenAt({ a: 500, b: 90 }, 100)).toEqual({ a: 100, b: 90 });
        expect(capSeenAt({ a: 500 }, NaN)).toEqual({ a: 500 });
    });
});

describe('selectSeenWatermark', () => {
    const now = 100 * DAY;
    it('keeps the last 7 days newest-first, capped by count', () => {
        const seen: Record<string, number> = { old: now - 8 * DAY, a: now - 1000, b: now - 2000, c: now - 3000 };
        expect(selectSeenWatermark(seen, now, 10_000)).toEqual({ a: now - 1000, b: now - 2000, c: now - 3000 });
        expect(Object.keys(selectSeenWatermark(seen, now, 10_000, 2)!)).toEqual(['a', 'b']);
    });
    it('respects the byte budget and returns null when nothing fits', () => {
        const seen: Record<string, number> = {};
        for (let i = 0; i < 100; i++) seen[`session-${i}`] = now - i;
        const picked = selectSeenWatermark(seen, now, 200)!;
        expect(Buffer.byteLength(',"seen":' + JSON.stringify(picked))).toBeLessThanOrEqual(200);
        expect(Object.keys(picked).length).toBeGreaterThan(0);
        expect(selectSeenWatermark(seen, now, 5)).toBeNull();
        expect(selectSeenWatermark({}, now, 10_000)).toBeNull();
    });
});

describe('buildWebPushPayload', () => {
    const now = 100 * DAY;
    const base = { title: 'T', body: 'B', data: { sessionId: 's1', kind: 'done' } };
    it('adds sentAt always and seen only when available', () => {
        expect(buildWebPushPayload(base, null, now)).toEqual({ ...base, sentAt: now });
        expect(buildWebPushPayload(base, { s1: now - 5 }, now)).toEqual({ ...base, sentAt: now, seen: { s1: now - 5 } });
    });
    it('never grows the payload past the budget', () => {
        const seen: Record<string, number> = {};
        for (let i = 0; i < 40; i++) seen[`k${'x'.repeat(60)}${i}`] = now - i;
        const big = { ...base, body: 'y'.repeat(3000) };
        const p = buildWebPushPayload(big, seen, now);
        expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(PUSH_PAYLOAD_BUDGET_BYTES);
        const huge = { ...base, body: 'y'.repeat(3600) };
        expect(buildWebPushPayload(huge, seen, now).seen).toBeUndefined();
    });
});
