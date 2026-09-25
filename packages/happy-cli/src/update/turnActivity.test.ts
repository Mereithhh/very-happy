import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TURN_BUSY_TTL_MS, TURN_LEASE_MS, TurnActivityTracker, TurnReporter } from './turnActivity';

describe('TurnActivityTracker (B-466, daemon side)', () => {
    it('is busy from turn_started until turn_ended, forget, or TTL expiry', () => {
        const t = new TurnActivityTracker();
        expect(t.hasActiveTurn(0)).toBe(false);
        t.apply('s1', 'turn_started', 1_000);
        expect(t.hasActiveTurn(1_000)).toBe(true);
        expect(t.activeSessions(1_000)).toEqual(['s1']);
        t.apply('s1', 'turn_ended', 2_000);
        expect(t.hasActiveTurn(2_000)).toBe(false);

        t.apply('s2', 'turn_started', 5_000);
        t.forget('s2');
        expect(t.hasActiveTurn(5_000)).toBe(false);

        // a lost turn_ended cannot pin the machine forever
        t.apply('s3', 'turn_started', 10_000);
        expect(t.hasActiveTurn(10_000 + TURN_BUSY_TTL_MS)).toBe(true);
        expect(t.hasActiveTurn(10_000 + TURN_BUSY_TTL_MS + 1)).toBe(false);
        // a renewal extends it
        t.apply('s3', 'turn_started', 10_000);
        t.apply('s3', 'turn_started', 10_000 + TURN_LEASE_MS);
        expect(t.hasActiveTurn(10_000 + TURN_LEASE_MS + TURN_BUSY_TTL_MS)).toBe(true);
    });

    it('one busy session among idle ones keeps the machine busy; ended/unknown ones do not', () => {
        const t = new TurnActivityTracker();
        t.apply('idle', 'turn_started', 0);
        t.apply('idle', 'turn_ended', 1);
        t.apply('busy', 'turn_started', 1);
        expect(t.activeSessions(2)).toEqual(['busy']);
        expect(t.hasActiveTurn(2)).toBe(true);
    });
});

describe('TurnReporter (B-466, wrapper side)', () => {
    it('reports edges only, renews the lease while thinking, and stays silent when idle', () => {
        const send = vi.fn();
        const r = new TurnReporter(send);
        expect(r.observe(false, 0)).toBeNull();
        expect(r.observe(true, 1_000)).toBe('turn_started');
        expect(r.observe(true, 3_000)).toBeNull();          // heartbeat, no edge
        expect(r.observe(true, 1_000 + TURN_LEASE_MS - 1)).toBeNull();
        expect(r.observe(true, 1_000 + TURN_LEASE_MS)).toBe('turn_started'); // renewal
        expect(r.observe(false, 70_000)).toBe('turn_ended');
        expect(r.observe(false, 72_000)).toBeNull();
        expect(r.observe(true, 80_000)).toBe('turn_started'); // fresh edge resets the lease clock
        expect(send.mock.calls.map((c) => c[0])).toEqual(['turn_started', 'turn_started', 'turn_ended', 'turn_started']);
    });
});

describe('daemon wiring (B-466)', () => {
    // Verified with scripts/dev/mutation-check.mjs (see PR).
    const run = readFileSync(join(__dirname, '..', 'daemon', 'run.ts'), 'utf8');
    const apiSession = readFileSync(join(__dirname, '..', 'api', 'apiSession.ts'), 'utf8');
    const controlServer = readFileSync(join(__dirname, '..', 'daemon', 'controlServer.ts'), 'utf8');

    it('gates install AND handover on "no turn in flight", not on wrappers or terminals', () => {
        expect(run).toContain('idle: () => !turnActivity.hasActiveTurn() && !backgroundTasks.hasAny(),');
        expect(run).toContain('if (bundleReplaced && !teamWorker?.busy && !automationRunner?.busy && !updateController.isRunning() && !turnActivity.hasActiveTurn() && !backgroundTasks.hasAny()) {');
        expect(run).toContain('if (teamWorker?.busy || automationRunner?.busy || updateController.isRunning() || turnActivity.hasActiveTurn() || backgroundTasks.hasAny()) return;');
        expect(run).not.toMatch(/idle: \(\) =>[^\n]*hasLiveTerminals/);
        expect(run).not.toMatch(/idle: \(\) =>[^\n]*pidToTrackedSession\.size/);
        // an exited wrapper releases its mark
        expect(run).toContain("if (session?.happySessionId) turnActivity.forget(session.happySessionId);");
        expect(run).toContain('onSessionTurnEvent: (sessionId, event) => turnActivity.apply(sessionId, event),');
    });

    it('every wrapper reports turn edges from its keepAlive heartbeat', () => {
        expect(apiSession).toContain('this.turnReporter.observe(thinking);');
        expect(apiSession).toContain("new TurnReporter((event) => void notifyDaemonTurnEvent(this.sessionId, event)");
    });

    it('the control server accepts turn events and never routes them into the assistant sink', () => {
        expect(controlServer).toContain("event: z.enum(['completed', 'needs_input', 'auth_failed', 'turn_started', 'turn_ended', 'background_tasks']),");
        expect(controlServer).toContain("if (event === 'turn_started' || event === 'turn_ended') {");
    });
});
