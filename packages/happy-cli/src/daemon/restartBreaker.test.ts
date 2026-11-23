import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideRestart, recordRestartAttempt, restartBudget, DEFAULT_MAX_ACCOUNT_RESTARTS, DEFAULT_MAX_RESTARTS, DEFAULT_MAX_TEAM_MODE_RESTARTS, type RestartBudget } from './restartBreaker';

describe('restart circuit breaker', () => {
    it('allows the first restart and reports attempt number', () => {
        const d = decideRestart(0);
        expect(d).toEqual({ allowed: true, attempt: 1 });
    });

    it('allows up to but not beyond the max', () => {
        expect(decideRestart(DEFAULT_MAX_RESTARTS - 1).allowed).toBe(true);
        const blocked = decideRestart(DEFAULT_MAX_RESTARTS);
        expect(blocked.allowed).toBe(false);
        if (!blocked.allowed) expect(blocked.reason).toContain('restart-limit');
    });

    it('honors a custom max', () => {
        expect(decideRestart(1, 1).allowed).toBe(false);
        expect(decideRestart(0, 1).allowed).toBe(true);
    });

    it('records an attempt as a monotonic increment', () => {
        expect(recordRestartAttempt(0)).toBe(1);
        expect(recordRestartAttempt(2)).toBe(3);
    });

    it('a rejected pre-flight does not burn a slot (record is caller-driven)', () => {
        // decideRestart is pure and never mutates; the daemon only calls
        // recordRestartAttempt once it actually spawns. Simulate: 3 pre-flight
        // checks that never spawn leave the count at 0.
        let count = 0;
        for (let i = 0; i < 3; i++) {
            const d = decideRestart(count);
            expect(d.allowed).toBe(true); // still allowed — nothing was recorded
        }
        expect(count).toBe(0);
    });
});

describe('B-850a account restarts', () => {
    it('get a much higher bound than the crash-loop breaker', () => {
        expect(DEFAULT_MAX_ACCOUNT_RESTARTS).toBeGreaterThanOrEqual(10 * DEFAULT_MAX_RESTARTS);
        expect(decideRestart(3, DEFAULT_MAX_ACCOUNT_RESTARTS).allowed).toBe(true);
        expect(decideRestart(DEFAULT_MAX_ACCOUNT_RESTARTS, DEFAULT_MAX_ACCOUNT_RESTARTS).allowed).toBe(false);
    });
});

// B-962c (R77 QA): the second 「恢复团队」 relaunch of a lead hit restart-limit (exit, restore and the
// second exit had used up the 3), so the restore fell back to a fresh session and lost the conversation.
describe('B-962c: exit team mode / restore count on their own', () => {
    // The daemon's bookkeeping (run.ts restartSessionImpl): one count per budget, recorded on spawn.
    function daemonCounts() {
        const counts: Record<RestartBudget, Map<string, number>> = { manual: new Map(), account: new Map(), 'team-mode': new Map() };
        return (id: string, options?: { account?: true; teamMode?: true }) => {
            const { budget, max } = restartBudget(options);
            const prior = counts[budget].get(id) ?? 0;
            const d = decideRestart(prior, max);
            if (d.allowed) counts[budget].set(id, recordRestartAttempt(prior));
            return d.allowed;
        };
    }

    it('three exit/restore rounds keep relaunching the lead (and a live member) in place', () => {
        const restart = daemonCounts();
        for (let round = 1; round <= 3; round++) {
            expect(restart('lead', { teamMode: true })).toBe(true); // 退出团队模式: lead restarts without team env
            expect(restart('lead', { teamMode: true })).toBe(true); // 恢复团队: lead restarts with team env
            expect(restart('member', { teamMode: true })).toBe(true); // a member still live at restore
        }
    });

    it('team-mode restarts leave the crash-loop breaker intact: the 4th manual restart is still refused', () => {
        const restart = daemonCounts();
        for (let i = 0; i < 6; i++) restart('lead', { teamMode: true });
        for (let i = 0; i < DEFAULT_MAX_RESTARTS; i++) expect(restart('lead')).toBe(true);
        expect(restart('lead')).toBe(false);
    });

    it('team-mode restarts are still bounded', () => {
        const restart = daemonCounts();
        for (let i = 0; i < DEFAULT_MAX_TEAM_MODE_RESTARTS; i++) expect(restart('lead', { teamMode: true })).toBe(true);
        expect(restart('lead', { teamMode: true })).toBe(false);
        expect(DEFAULT_MAX_TEAM_MODE_RESTARTS).toBeGreaterThan(DEFAULT_MAX_RESTARTS);
    });

    it('budgets: account wins, then team mode, else the crash-loop count', () => {
        expect(restartBudget(undefined)).toEqual({ budget: 'manual', max: DEFAULT_MAX_RESTARTS });
        expect(restartBudget({ teamMode: true })).toEqual({ budget: 'team-mode', max: DEFAULT_MAX_TEAM_MODE_RESTARTS });
        expect(restartBudget({ account: true })).toEqual({ budget: 'account', max: DEFAULT_MAX_ACCOUNT_RESTARTS });
    });

    it('wiring: the exit-team-mode restart and the restore relaunch use the team-mode count', () => {
        const run = readFileSync(join(__dirname, 'run.ts'), 'utf8');
        const exit = run.slice(run.indexOf('const exitTeamModeForSession = async'), run.indexOf('const restartSession = async'));
        expect(exit).toContain('await restartSession(happySessionId, { keepPublishedPermissionMode: true, teamMode: true });');
        const relaunch = run.slice(run.indexOf('relaunch: async id =>'), run.indexOf('resolveAccount: (agent'));
        expect(relaunch).toContain('? restartSession(id, { keepPublishedPermissionMode: true, teamMode: true })');
        expect(run).toContain('const { budget, max } = restartBudget(options);');
    });
});
