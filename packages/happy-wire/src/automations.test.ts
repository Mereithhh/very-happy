import { describe, expect, it } from 'vitest';
import { AutomationActionSchema, AutomationCreateSchema, AutomationNameSchema, AutomationReportSchema, AutomationTriggerSchema, isAutomationRunTerminal } from './automations';

describe('automation wire schemas', () => {
    it('constrains names and interval floors', () => {
        expect(AutomationNameSchema.safeParse('daily-tanka.v2').success).toBe(true);
        expect(AutomationNameSchema.safeParse('Daily').success).toBe(false);
        expect(AutomationNameSchema.safeParse('-lead').success).toBe(false);
        expect(AutomationTriggerSchema.safeParse({ kind: 'interval', everyMs: 59_999 }).success).toBe(false);
        expect(AutomationTriggerSchema.safeParse({ kind: 'interval', everyMs: 60_000 }).success).toBe(true);
        expect(AutomationTriggerSchema.safeParse({ kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Singapore' }).success).toBe(true);
    });
    it('keeps agent and permissionMode open strings so newer daemons are not rejected', () => {
        const parsed = AutomationActionSchema.parse({ kind: 'spawn', agent: 'future-agent', directory: '/repo', prompt: 'go', permissionMode: 'some-new-mode', model: null });
        expect(parsed).toMatchObject({ agent: 'future-agent', permissionMode: 'some-new-mode', model: null });
        expect(AutomationActionSchema.safeParse({ kind: 'script', command: [] }).success).toBe(false);
        expect(AutomationActionSchema.safeParse({ kind: 'script', command: ['echo', 'hi'], env: { A: '1' } }).success).toBe(true);
    });
    it('requires a claimId on reports and allows lease-only renewals', () => {
        expect(AutomationReportSchema.safeParse({ claimId: 'c1' }).success).toBe(true);
        expect(AutomationReportSchema.safeParse({ status: 'done' }).success).toBe(false);
        expect(AutomationReportSchema.safeParse({ claimId: 'c1', status: 'expired' }).success).toBe(false);
        expect(AutomationCreateSchema.safeParse({ name: 'x', machineId: 'm', trigger: { kind: 'manual' }, action: { kind: 'send', sessionId: 's', prompt: 'p' } }).success).toBe(true);
    });
    it('classifies terminal statuses', () => {
        for (const s of ['done', 'failed', 'skipped', 'expired', 'cancelled']) expect(isAutomationRunTerminal(s)).toBe(true);
        for (const s of ['queued', 'claimed', 'running', 'unknown']) expect(isAutomationRunTerminal(s)).toBe(false);
    });
});
