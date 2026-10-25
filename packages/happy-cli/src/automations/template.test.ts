import { describe, expect, it } from 'vitest';
import { AUTOMATION_ATTENTION_REASON_MAX_CHARS, AUTOMATION_SUMMARY_MAX_CHARS, AutomationReportSchema } from '@slopus/happy-wire';
import { clipAutomationReport, clipText, describeAction, describeTrigger, formatNow, parseDuration, renderAction, renderTemplate, triggerFromFlags } from './template';

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

    it('B-767: clipText never splits a surrogate pair and counts the marker toward the limit', () => {
        const emoji = '😀'; // 2 UTF-16 units
        expect(clipText('ab😀cd', 3)).toBe('ab');
        expect(clipText('ab😀cd', 4)).toBe('ab😀');
        expect(clipText('ab😀cd', 3, 'tail')).toBe('cd');
        expect(clipText('ab😀cd', 4, 'tail')).toBe('😀cd');
        expect(clipText('ab😀cd', 4, 'head', '…')).toBe('ab…');
        expect(clipText('ab😀cd', 4, 'tail', '…')).toBe('…cd');
        expect(clipText(emoji.repeat(5), 6, 'head', '…')).toBe(`${emoji.repeat(2)}…`);
        expect(clipText('ab', 2, 'head', '…')).toBe('ab');
    });

    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const [label, unit] of [['ASCII', 'a'], ['CJK', '漂'], ['emoji', '😀'], ['mixed', '漂移a😀']] as const) {
        it(`B-767: clips a 600-char attention and 5000-char summary/error (${label}) so the server schema accepts them`, () => {
            const long = (n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
            const input = { status: 'done' as const, needsAttention: true, summary: long(5000), error: long(5000), attentionReason: long(600) };
            // zod >= 4.6 measures .max() in code points, so a 5000-unit emoji string
            // may already pass; the clip (UTF-16 units) is the stricter bound either way.
            const overByCodePoints = [...input.summary].length > AUTOMATION_SUMMARY_MAX_CHARS;
            expect(AutomationReportSchema.safeParse(input).success).toBe(!overByCodePoints && [...input.attentionReason].length <= AUTOMATION_ATTENTION_REASON_MAX_CHARS);
            const { report, clipped } = clipAutomationReport(input);
            expect(AutomationReportSchema.safeParse(report).success).toBe(true);
            expect(clipped.map(c => [c.field, c.from])).toEqual([['summary', 5000], ['error', 5000], ['attentionReason', 600]]);
            for (const c of clipped) {
                const value = report[c.field]!;
                expect(value.length).toBe(c.to);
                expect(value.length).toBeLessThanOrEqual(c.field === 'attentionReason' ? AUTOMATION_ATTENTION_REASON_MAX_CHARS : AUTOMATION_SUMMARY_MAX_CHARS);
                expect(value.length).toBeGreaterThanOrEqual((c.field === 'attentionReason' ? AUTOMATION_ATTENTION_REASON_MAX_CHARS : AUTOMATION_SUMMARY_MAX_CHARS) - 1);
                expect(value.endsWith('…')).toBe(true);
                expect(lone.test(value)).toBe(false);
                expect(input[c.field].startsWith(value.slice(0, -1))).toBe(true);
            }
            expect(report.needsAttention).toBe(true);
        });
    }

    it('B-767: leaves in-limit and absent report fields untouched', () => {
        const input = { status: 'failed' as const, summary: 'x'.repeat(AUTOMATION_SUMMARY_MAX_CHARS), error: null, attentionReason: '😀'.repeat(256) };
        expect(clipAutomationReport(input)).toEqual({ report: input, clipped: [] });
    });
});
