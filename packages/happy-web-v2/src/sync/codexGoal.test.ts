import { describe, expect, it } from 'vitest';
import { CODEX_GOAL_CAPABILITY } from '@slopus/happy-wire';
import { goalSupport, goalTone, goalUsage, isGoalCommand, sessionCodexGoal } from './codexGoal';
import { buildCommandItems } from './suggestionCommandItems';
import { AgentStateSchema } from './storageTypes';

const goal = { objective: 'ship it', status: 'active', tokenBudget: 50_000, tokensUsed: 12_345, timeUsedSeconds: 3, updatedAt: 1 };
const codex = (caps: string[] = [CODEX_GOAL_CAPABILITY]) => ({ metadata: { flavor: 'codex', capabilities: caps }, agentState: { codexGoal: goal } });

describe('Codex /goal on the web (B-953)', () => {
    it('decides support from the wrapper capability, never the version', () => {
        expect(goalSupport(codex())).toBe('supported');
        expect(goalSupport(codex([]))).toBe('unsupported');
        expect(goalSupport({ metadata: { flavor: 'claude' } })).toBe('passthrough');
        expect(goalSupport(null)).toBe('passthrough');
    });

    it('recognises the command as the wrapper does', () => {
        expect(isGoalCommand('/goal ship it')).toBe(true);
        expect(isGoalCommand('／Goal')).toBe(true);
        expect(isGoalCommand('/goals')).toBe(false);
        expect(isGoalCommand('my /goal')).toBe(false);
    });

    it('shows the goal only on capable, live sessions', () => {
        expect(sessionCodexGoal(codex())).toEqual(goal);
        expect(sessionCodexGoal(codex([]))).toBeNull();
        expect(sessionCodexGoal({ ...codex(), archivedAt: 5 })).toBeNull();
        expect(sessionCodexGoal({ ...codex(), agentState: { codexGoal: null } })).toBeNull();
    });

    it('keeps the goal through the agentState schema; a malformed one drops only that field', () => {
        expect(AgentStateSchema.parse({ codexGoal: goal }).codexGoal).toEqual(goal);
        const parsed = AgentStateSchema.parse({ codexGoal: { status: 'weird' }, controlledByUser: false });
        expect(parsed.codexGoal).toBeUndefined();
        expect(parsed.controlledByUser).toBe(false);
    });

    it('formats usage and tone', () => {
        expect(goalUsage(goal)).toBe('12k / 50k');
        expect(goalUsage({ tokensUsed: 900, tokenBudget: null })).toBe('900');
        expect(goalUsage({ tokensUsed: 0, tokenBudget: null })).toBeNull();
        expect(goalTone('active')).toBe('active');
        expect(goalTone('complete')).toBe('done');
        expect(goalTone('budgetLimited')).toBe('attention');
        expect(goalTone('paused')).toBe('attention');
    });

    it('lists /goal for Codex, marked unavailable on an older wrapper', () => {
        expect(buildCommandItems([], [], { goal: 'available' }).find((c) => c.command === 'goal')).toMatchObject({ command: 'goal' });
        expect(buildCommandItems([], [], { goal: 'available' }).find((c) => c.command === 'goal')?.unavailable).toBeUndefined();
        expect(buildCommandItems([], [], { goal: 'unavailable' }).find((c) => c.command === 'goal')?.unavailable).toBe(true);
        expect(buildCommandItems([], []).some((c) => c.command === 'goal')).toBe(false);
        // Claude lists its own /goal: shown once
        expect(buildCommandItems(['goal'], [], {}).filter((c) => c.command === 'goal')).toHaveLength(1);
    });
});
