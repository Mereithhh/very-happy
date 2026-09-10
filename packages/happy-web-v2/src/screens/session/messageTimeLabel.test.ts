import { describe, expect, it } from 'vitest';
import { compactMessageTime, messageTimestamp, messageTimestampRange } from './messageTimestamp';

const timestamp = Date.UTC(2026, 8, 11, 3, 5, 59);

describe('compact message time', () => {
    it.each(['en', 'en-US', 'zh-Hans', 'zh-Hant', 'ja', 'ru'])('uses two-digit 24-hour local time for %s', locale => {
        expect(compactMessageTime(timestamp, locale, 'UTC')).toBe('03:05');
        expect(compactMessageTime(timestamp, locale, 'Asia/Singapore')).toBe('11:05');
        expect(compactMessageTime(timestamp + 12 * 60 * 60 * 1000, locale, 'UTC')).toBe('15:05');
    });

    it('renders midnight as 00 and respects the selected timezone across dates', () => {
        const beforeMidnight = Date.UTC(2026, 8, 11, 23, 59, 59);
        expect(compactMessageTime(beforeMidnight, 'en', 'UTC')).toBe('23:59');
        expect(compactMessageTime(beforeMidnight + 1000, 'en', 'UTC')).toBe('00:00');
        expect(compactMessageTime(beforeMidnight, 'en', 'Asia/Singapore')).toBe('07:59');
    });

    it.each([undefined, null, NaN, Infinity, -1, 0, 1e20])('omits unavailable or invalid time %s', value => {
        expect(compactMessageTime(value, 'en', 'UTC')).toBeUndefined();
    });

    it('keeps compact labels and full hover dates separate when sharing formatter caches', () => {
        expect(compactMessageTime(timestamp, 'en', 'UTC')).toBe('03:05');
        expect(messageTimestamp(timestamp, 'en', 'UTC')).toBe('09/11/2026, 03:05:59 UTC');
        expect(messageTimestampRange([timestamp, timestamp + 1000], 'en', 'UTC'))
            .toBe('09/11/2026, 03:05:59 UTC – 09/11/2026, 03:06:00 UTC');
        expect(compactMessageTime(timestamp + 1000, 'en', 'UTC')).toBe('03:06');
    });
});
