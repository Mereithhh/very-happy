import { describe, expect, it } from 'vitest';
import { planClaudeStartup } from './startupPlan';

describe('planClaudeStartup (B-512)', () => {
    it('daemon spawns skip machine registration and the daemon check', () => {
        expect(planClaudeStartup({ startedBy: 'daemon', reconnect: false })).toEqual({
            registerMachine: false,
            ensureDaemonRunning: false,
            sessionClientBeforeWebhook: true,
        });
    });

    it('terminal (and unspecified) launches keep both', () => {
        for (const startedBy of ['terminal', undefined] as const) {
            const plan = planClaudeStartup({ startedBy, reconnect: false });
            expect(plan.registerMachine).toBe(true);
            expect(plan.ensureDaemonRunning).toBe(true);
        }
    });

    it('only fresh sessions open the socket before the webhook', () => {
        expect(planClaudeStartup({ startedBy: 'daemon', reconnect: true }).sessionClientBeforeWebhook).toBe(false);
        expect(planClaudeStartup({ startedBy: 'terminal', reconnect: true }).sessionClientBeforeWebhook).toBe(false);
        expect(planClaudeStartup({ startedBy: 'terminal', reconnect: false }).sessionClientBeforeWebhook).toBe(true);
    });
});
