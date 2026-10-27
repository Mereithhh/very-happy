// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { AutomationRun } from '@slopus/happy-wire';
import { automationRunOutcome } from './automationRunWatch';

const run = (patch: Partial<AutomationRun>): AutomationRun => ({ id: 'r', automationName: 'Nightly', status: 'queued', sessionId: null, error: null, ...patch } as AutomationRun);

describe('automationRunOutcome (立即运行)', () => {
    it('a session the store did not have is new; one it had (sticky) is a delivery', () => {
        expect(automationRunOutcome(run({ status: 'running', sessionId: 's1' }), new Set())).toEqual({ kind: 'session', sessionId: 's1', reused: false });
        expect(automationRunOutcome(run({ status: 'running', sessionId: 's1' }), new Set(['s1']))).toEqual({ kind: 'session', sessionId: 's1', reused: true });
    });
    it('failed / expired carry the reason; other ends without a session stay quiet; else pending', () => {
        expect(automationRunOutcome(run({ status: 'failed', error: 'machine_offline' }), new Set())).toEqual({ kind: 'failed', error: 'machine_offline' });
        expect(automationRunOutcome(run({ status: 'expired' }), new Set())).toEqual({ kind: 'failed', error: 'expired' });
        expect(automationRunOutcome(run({ status: 'skipped', summary: 'previous run still active' }), new Set())).toEqual({ kind: 'failed', error: 'previous run still active' });
        expect(automationRunOutcome(run({ status: 'done' }), new Set())).toEqual({ kind: 'quiet' });
        expect(automationRunOutcome(run({ status: 'queued' }), new Set())).toEqual({ kind: 'pending' });
    });
});
