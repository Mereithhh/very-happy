import { describe, expect, it } from 'vitest';
import { readMainAgentProactive } from '@slopus/happy-wire';
import { mainAgentProactiveCopy, parseCap, withProactive } from '@/assistant/mainAgentProactive';

describe('Settings → Main agent → 主动程度', () => {
    it('writes proactive and keeps every other field of the config blob', () => {
        const previous = { v: 1, skillRoots: ['~/skills'], deniedTools: ['mcp__x__*'], quietHours: { enabled: true, start: '23:00', end: '08:00', tz: 'Asia/Singapore' }, future: 42 };
        const next = withProactive(previous, { ...readMainAgentProactive(null), level: 'report', dailyWakes: 5 }, 1000);
        expect(next).toMatchObject({ skillRoots: ['~/skills'], deniedTools: ['mcp__x__*'], quietHours: previous.quietHours, future: 42, updatedAt: 1000 });
        expect(readMainAgentProactive(next)).toMatchObject({ level: 'report', dailyWakes: 5 });
    });

    it('caps are whole numbers inside the bounds', () => {
        expect(parseCap('24', 'dailyWakes')).toBe(24);
        expect(parseCap('300,000', 'dailyTokens')).toBe(300_000);
        expect(parseCap('0', 'dailyWakes')).toBe(0);
        expect(parseCap('201', 'dailyWakes')).toBeNull();
        expect(parseCap('1.5', 'dailyWakes')).toBeNull();
        expect(parseCap('', 'dailyTokens')).toBeNull();
    });

    it('has the three levels in both languages', () => {
        for (const lang of ['zh-Hans', 'en']) {
            const copy = mainAgentProactiveCopy(lang);
            expect([copy.levelOff, copy.levelReport, copy.levelFollow].every(Boolean)).toBe(true);
            expect(Object.keys(copy.levelHint).sort()).toEqual(['follow', 'off', 'report']);
        }
        expect(mainAgentProactiveCopy('zh-Hans').levelReport).toBe('只汇报');
        expect(mainAgentProactiveCopy('zh-Hans').levelFollow).toBe('主动跟进');
    });
});
