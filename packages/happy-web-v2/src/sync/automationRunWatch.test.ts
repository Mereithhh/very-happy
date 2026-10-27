// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { AutomationRun } from '@slopus/happy-wire';
import { automationRunOutcome } from './automationRunWatch';
import { runProblemSummary } from '@/screens/automations/AutomationShared';

const run = (patch: Partial<AutomationRun>): AutomationRun => ({ id: 'r', automationName: 'Nightly', status: 'queued', sessionId: null, error: null, ...patch } as AutomationRun);

describe('automationRunOutcome (立即运行)', () => {
    it('a session the store did not have is new; one it had (sticky) is a delivery', () => {
        expect(automationRunOutcome(run({ status: 'running', sessionId: 's1' }), new Set())).toEqual({ kind: 'session', sessionId: 's1', reused: false });
        expect(automationRunOutcome(run({ status: 'running', sessionId: 's1' }), new Set(['s1']))).toEqual({ kind: 'session', sessionId: 's1', reused: true });
    });
    it('failed / expired carry the reason; other ends without a session stay quiet; else pending', () => {
        expect(automationRunOutcome(run({ status: 'failed', error: 'machine_offline' }), new Set())).toEqual({ kind: 'failed', error: 'machine_offline', skipped: false });
        expect(automationRunOutcome(run({ status: 'expired' }), new Set())).toEqual({ kind: 'failed', error: 'expired', skipped: false });
        expect(automationRunOutcome(run({ status: 'skipped', summary: 'previous run still active' }), new Set())).toEqual({ kind: 'failed', error: 'previous run still active', skipped: true });
        expect(automationRunOutcome(run({ status: 'done' }), new Set())).toEqual({ kind: 'quiet' });
        expect(automationRunOutcome(run({ status: 'queued' }), new Set())).toEqual({ kind: 'pending' });
    });
});

describe('runProblemSummary (QA17 P2-1: worded, not the raw code)', () => {
    it('skip codes and attention reasons get their wording; unknown ones the generic sentence', () => {
        expect(runProblemSummary(run({ status: 'skipped', error: 'previous_run_active', attentionReason: null }))).toBe('previous run still active');
        expect(runProblemSummary(run({ status: 'skipped', error: 'something_new', attentionReason: null }))).toBe('skipped');
        expect(runProblemSummary(run({ status: 'failed', attentionReason: 'machine_offline' }))).toMatch(/offline/i);
        expect(runProblemSummary(run({ status: 'failed', error: 'Error: spawn ENOENT /very/long/raw', attentionReason: null }))).toBe('Run failed');
    });
});
