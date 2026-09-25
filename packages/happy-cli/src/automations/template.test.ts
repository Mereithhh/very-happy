import { describe, expect, it } from 'vitest';
import { clipText, describeAction, describeTrigger, formatNow, parseDuration, renderAction, renderTemplate, triggerFromFlags } from './template';

const context = { runId: 'run-1', automationName: 'nightly', now: Date.UTC(2026, 8, 25, 1, 2, 3) };

describe('automation templates', () => {
    it('renders payload paths, run/automation names and now, leaving unknown placeholders alone', () => {
        const payload = JSON.stringify({ conversationId: 'c-9', nested: { n: 3, list: [1, 2] }, flag: false });
        const text = 'id={{payload.conversationId}} n={{ payload.nested.n }} list={{payload.nested.list}} flag={{payload.flag}} missing=[{{payload.nope.x}}] run={{run.id}} name={{automation.name}} keep={{unknown}} raw={{payload}}';
        expect(renderTemplate(text, { ...context, payload })).toBe(`id=c-9 n=3 list=[1,2] flag=false missing=[] run=run-1 name=nightly keep={{unknown}} raw=${payload}`);
        expect(renderTemplate('{{now}}', context)).toBe('2026-09-25T01:02:03.000Z');
        expect(renderTemplate('{{now}}', { ...context, tz: 'Asia/Singapore' })).toBe('2026-09-25T09:02:03+08:00');
        expect(formatNow(context.now, 'Not/AZone')).toBe('2026-09-25T01:02:03.000Z');
    });
    it('treats a non-JSON payload as raw text only', () => {
        expect(renderTemplate('[{{payload}}] [{{payload.a}}]', { ...context, payload: 'plain text' })).toBe('[plain text] []');
        expect(renderTemplate('[{{payload}}]', { ...context, payload: null })).toBe('[]');
    });
    it('renders every user string of an action', () => {
        const payload = '{"a":"X"}';
        expect(renderAction({ kind: 'spawn', agent: 'claude', directory: '/d', prompt: 'do {{payload.a}}', sticky: { key: '{{payload.a}}' } }, { ...context, payload }))
            .toEqual({ kind: 'spawn', agent: 'claude', directory: '/d', prompt: 'do X', sticky: { key: '{{payload.a}}' } });
        expect(renderAction({ kind: 'script', command: ['echo', '{{payload.a}}', '{{run.id}}'], env: { V: '{{automation.name}}' } }, { ...context, payload }))
            .toEqual({ kind: 'script', command: ['echo', 'X', 'run-1'], env: { V: 'nightly' } });
        expect(renderAction({ kind: 'send', sessionId: 's', prompt: '{{run.id}}' }, context)).toEqual({ kind: 'send', sessionId: 's', prompt: 'run-1' });
    });
    it('clips head or tail', () => {
        expect(clipText('abcdef', 3)).toBe('abc');
        expect(clipText('abcdef', 3, 'tail')).toBe('def');
        expect(clipText('ab', 3)).toBe('ab');
    });
});

describe('durations and triggers', () => {
    it('parses compound durations and rejects garbage', () => {
        expect(parseDuration('90s')).toBe(90_000);
        expect(parseDuration('1h30m')).toBe(5_400_000);
        expect(parseDuration('2d')).toBe(172_800_000);
        expect(parseDuration('250ms')).toBe(250);
        expect(parseDuration('1500')).toBe(1500);
        expect(() => parseDuration('5 minutes')).toThrow('Invalid duration');
        expect(() => parseDuration('')).toThrow('Invalid duration');
    });
    it('builds exactly one trigger from flags', () => {
        expect(triggerFromFlags({ cron: '0 9 * * *', tz: 'Asia/Singapore' })).toEqual({ kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Singapore' });
        expect(triggerFromFlags({ every: '5m' }, 1000)).toEqual({ kind: 'interval', everyMs: 300_000, anchorAt: 1000 });
        expect(triggerFromFlags({ at: '2026-10-01T00:00:00Z' })).toEqual({ kind: 'once', at: Date.UTC(2026, 9, 1) });
        expect(triggerFromFlags({ manual: true })).toEqual({ kind: 'manual' });
        expect(triggerFromFlags({})).toBeUndefined();
        expect(() => triggerFromFlags({ cron: '* * * * *' })).toThrow('--tz');
        expect(() => triggerFromFlags({ every: '5m', manual: true })).toThrow('exactly one');
        expect(() => triggerFromFlags({ at: 'tomorrow' })).toThrow('ISO 8601');
        expect(() => triggerFromFlags({ tz: 'UTC' })).toThrow('--tz only');
    });
    it('describes triggers and actions for listings', () => {
        expect(describeTrigger({ kind: 'interval', everyMs: 300_000, anchorAt: 1 })).toBe('every 5m');
        expect(describeTrigger({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' })).toBe('cron 0 9 * * * (UTC)');
        expect(describeAction({ kind: 'spawn', agent: 'codex', directory: '/r', prompt: 'p', sticky: { key: '{{payload.id}}' } })).toBe('spawn codex in /r (sticky {{payload.id}})');
        expect(describeAction({ kind: 'script', command: ['a', 'b'] })).toBe('script a b');
    });
});
