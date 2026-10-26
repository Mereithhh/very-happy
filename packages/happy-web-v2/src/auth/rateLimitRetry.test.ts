// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { retryAfterMagnitude, retryAfterSecondsFromError } from './rateLimitRetry';
import { rateLimitedMessage } from './rateLimitMessage';
import { setLanguage, t } from '@/text';

describe('B-668 retryAfter magnitude', () => {
    it.each([
        [1, 'seconds', 1],
        [45, 'seconds', 45],
        [59.2, 'minutes', 1], // ceil(59.2) = 60 s → one minute
        [60, 'minutes', 1],
        [61, 'minutes', 2],
        [8 * 60, 'minutes', 8],
        [7 * 60 + 30, 'minutes', 8],
        [3599, 'hours', 1],
        [3600, 'hours', 1],
        [23 * 3600 + 5, 'hours', 23],
        [23 * 3600 + 40 * 60, 'hours', 24],
        [47 * 3600, 'hours', 47],
        [3 * 86_400, 'days', 3],
        [0, 'seconds', 1],
    ] as const)('%s s → %s %s', (seconds, unit, count) => {
        expect(retryAfterMagnitude(seconds)).toEqual({ unit, count });
    });
});

describe('B-668 retryAfter from an axios error', () => {
    it('prefers the body, then the Retry-After delta-seconds header', async () => {
        expect(retryAfterSecondsFromError({ response: { data: { error: 'too_many_requests', retryAfter: 480 }, headers: { 'retry-after': '9' } } })).toBe(480);
        expect(retryAfterSecondsFromError({ response: { data: { error: 'too_many_requests' }, headers: { 'retry-after': '82805' } } })).toBe(82_805);
        expect(retryAfterSecondsFromError({ response: { data: {}, headers: { get: (name: string) => (name === 'retry-after' ? '30' : null) } } })).toBe(30);
    });

    it('returns undefined for old servers, junk and HTTP-dates', async () => {
        expect(retryAfterSecondsFromError({ response: { status: 429, data: { error: 'too_many_requests' }, headers: {} } })).toBeUndefined();
        expect(retryAfterSecondsFromError({ response: { data: { retryAfter: -3 }, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } } })).toBeUndefined();
        expect(retryAfterSecondsFromError(new Error('network'))).toBeUndefined();
        expect(retryAfterSecondsFromError(undefined)).toBeUndefined();
    });
});

describe('B-668 rate-limited copy', () => {
    afterEach(() => setLanguage('en'));

    it('names the real wait in Chinese, without 请', async () => {
        await setLanguage('zh-Hans');
        expect(rateLimitedMessage(t, 23 * 3600 + 5)).toBe('尝试次数过多，23 小时后再试。');
        expect(rateLimitedMessage(t, 8 * 60)).toBe('尝试次数过多，8 分钟后再试。');
        expect(rateLimitedMessage(t, undefined)).toBe('尝试次数过多，稍后再试。');
    });

    it('names the real wait in English', async () => {
        expect(rateLimitedMessage(t, 23 * 3600 + 5)).toBe('Too many attempts. Try again in 23 hours.');
        expect(rateLimitedMessage(t, 8 * 60)).toBe('Too many attempts. Try again in 8 minutes.');
        expect(rateLimitedMessage(t, 1)).toBe('Too many attempts. Try again in 1 second.');
    });

    it('falls back to a generic line without retryAfter — never "a minute"', async () => {
        const fallback = rateLimitedMessage(t, undefined);
        expect(fallback).toBe('Too many attempts. Try again later.');
        expect(fallback).not.toMatch(/minute/i);
    });
});
