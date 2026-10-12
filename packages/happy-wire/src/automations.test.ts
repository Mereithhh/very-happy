import { describe, expect, it } from 'vitest';
import { AUTOMATION_ACK_BY, AUTOMATION_PRECHECK_MAX_TIMEOUT_MS, AutomationAckSchema, AutomationClaimSchema, AutomationPrecheckSchema, AutomationUpdateSchema, AutomationActionSchema, AutomationCreateSchema, AutomationFireSchema, AutomationNameSchema, AutomationReportSchema, AutomationTriggerSchema, isAutomationRunTerminal } from './automations';

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
    it('accepts daemon and account-level report shapes', () => {
        expect(AutomationReportSchema.safeParse({ claimId: 'c1' }).success).toBe(true);
        expect(AutomationReportSchema.safeParse({ status: 'done', summary: 's' }).success).toBe(true);
        expect(AutomationReportSchema.safeParse({ claimId: 'c1', status: 'expired' }).success).toBe(false);
        expect(AutomationCreateSchema.safeParse({ name: 'x', machineId: 'm', trigger: { kind: 'manual' }, action: { kind: 'send', sessionId: 's', prompt: 'p' } }).success).toBe(true);
    });
    it('limits payload by UTF-8 bytes, not characters', () => {
        expect(AutomationFireSchema.safeParse({ payload: 'a'.repeat(65_536) }).success).toBe(true);
        expect(AutomationFireSchema.safeParse({ payload: '\u4e2d'.repeat(30_000) }).success).toBe(false);
    });
    it('classifies terminal statuses', () => {
        for (const s of ['done', 'failed', 'skipped', 'expired', 'cancelled']) expect(isAutomationRunTerminal(s)).toBe(true);
        for (const s of ['queued', 'claimed', 'running', 'unknown']) expect(isAutomationRunTerminal(s)).toBe(false);
    });
    it('B-508: ack body is optional and open (newer servers may add ackedBy values)', () => {
        expect(AutomationAckSchema.parse({})).toEqual({});
        expect(AutomationAckSchema.parse({ by: 'owner-replied' })).toEqual({ by: 'owner-replied' });
        expect(AutomationAckSchema.safeParse({ by: '' }).success).toBe(false);
        expect(AUTOMATION_ACK_BY).toContain('owner');
    });
    it('B-548: precheck needs exactly one of argv / shell and bounds the timeout', () => {
        expect(AutomationPrecheckSchema.safeParse({ shell: 'test -s inbox.json' }).success).toBe(true);
        expect(AutomationPrecheckSchema.safeParse({ command: ['./has-new.sh'], cwd: '/repo', timeoutMs: 5000, includeOutput: true }).success).toBe(true);
        expect(AutomationPrecheckSchema.safeParse({}).success).toBe(false);
        expect(AutomationPrecheckSchema.safeParse({ shell: 'x', command: ['y'] }).success).toBe(false);
        expect(AutomationPrecheckSchema.safeParse({ shell: '   ' }).success).toBe(false);
        expect(AutomationPrecheckSchema.safeParse({ shell: 'x', timeoutMs: AUTOMATION_PRECHECK_MAX_TIMEOUT_MS + 1 }).success).toBe(false);
        expect(AutomationPrecheckSchema.safeParse({ shell: 'x', timeoutMs: 999 }).success).toBe(false);
    });
    it('B-548: create/update carry precheck (null removes), claim carries capabilities, only the daemon may report skipped', () => {
        const base = { name: 'x', machineId: 'm', trigger: { kind: 'manual' }, action: { kind: 'send', sessionId: 's', prompt: 'p' } };
        expect(AutomationCreateSchema.parse({ ...base, precheck: { shell: 'true' } }).precheck).toEqual({ shell: 'true' });
        expect(AutomationCreateSchema.safeParse({ ...base, precheck: { cwd: '/x' } }).success).toBe(false);
        expect(AutomationUpdateSchema.parse({ version: 1, precheck: null }).precheck).toBeNull();
        expect('precheck' in AutomationUpdateSchema.parse({ version: 1 })).toBe(false);
        expect(AutomationClaimSchema.parse({ machineId: 'm', capabilities: ['precheck'] }).capabilities).toEqual(['precheck']);
        expect(AutomationReportSchema.safeParse({ claimId: 'c', status: 'skipped', error: 'precheck_failed' }).success).toBe(true);
    });
});
