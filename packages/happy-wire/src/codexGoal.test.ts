import { describe, expect, it } from 'vitest';
import { codexGoalCommandText, codexVersionAtLeast, parseCodexGoalCommand, readCodexGoal } from './codexGoal';

describe('parseCodexGoalCommand (B-953)', () => {
    it('reads the subcommands of Codex\'s TUI', () => {
        expect(parseCodexGoalCommand('/goal')).toEqual({ kind: 'show' });
        expect(parseCodexGoalCommand('  /goal  ')).toEqual({ kind: 'show' });
        expect(parseCodexGoalCommand('/goal pause')).toEqual({ kind: 'pause' });
        expect(parseCodexGoalCommand('/goal resume')).toEqual({ kind: 'resume' });
        expect(parseCodexGoalCommand('/goal clear')).toEqual({ kind: 'clear' });
        expect(parseCodexGoalCommand('/goal make the tests pass\nthen open a PR')).toEqual({ kind: 'set', objective: 'make the tests pass\nthen open a PR' });
    });

    it('accepts what a phone keyboard types', () => {
        expect(parseCodexGoalCommand('／goal　整理周报')).toEqual({ kind: 'set', objective: '整理周报' });
        expect(parseCodexGoalCommand('/Goal整理')).toEqual({ kind: 'set', objective: '整理' });
    });

    it('leaves chat alone', () => {
        expect(parseCodexGoalCommand('please /goal x')).toBeNull();
        expect(parseCodexGoalCommand('/goals')).toBeNull();
        expect(parseCodexGoalCommand('/goal-setting')).toBeNull();
        expect(parseCodexGoalCommand('goal x')).toBeNull();
    });

    it('reads a token budget (VH extension): a positive integer or off, nothing else', () => {
        expect(parseCodexGoalCommand('/goal budget 50000')).toEqual({ kind: 'budget', tokens: 50000 });
        expect(parseCodexGoalCommand('/goal budget off')).toEqual({ kind: 'budget', tokens: null });
        for (const text of ['/goal budget 50k', '/goal budget lots', '/goal budget', '/goal budget 0', '/goal budget -5', '/goal budget 5000 tokens']) {
            expect(parseCodexGoalCommand(text)).toEqual({ kind: 'set', objective: text.slice('/goal '.length) });
        }
    });

    it('takes a subcommand only when it is the whole rest of the line (Lead 11-22)', () => {
        expect(parseCodexGoalCommand('/goal pause the build')).toEqual({ kind: 'set', objective: 'pause the build' });
        expect(parseCodexGoalCommand('/goal clear the cache')).toEqual({ kind: 'set', objective: 'clear the cache' });
        expect(parseCodexGoalCommand('/goal resume work on the parser')).toEqual({ kind: 'set', objective: 'resume work on the parser' });
        expect(parseCodexGoalCommand('/goal Pause')).toEqual({ kind: 'set', objective: 'Pause' });
        expect(parseCodexGoalCommand('/goal  pause ')).toEqual({ kind: 'pause' });
    });

    it('canonicalises for the queue, round-tripping', () => {
        for (const text of ['/goal', '/goal pause', '/goal resume', '/goal clear', '/goal ship it', '/goal budget 5000', '/goal budget off']) {
            const command = parseCodexGoalCommand(text)!;
            expect(parseCodexGoalCommand(codexGoalCommandText(command))).toEqual(command);
        }
    });
});

describe('codexVersionAtLeast', () => {
    it('compares semver against 0.133.0', () => {
        expect(codexVersionAtLeast('0.171.0')).toBe(true);
        expect(codexVersionAtLeast('0.133.0')).toBe(true);
        expect(codexVersionAtLeast('0.132.9')).toBe(false);
        expect(codexVersionAtLeast('0.99.0')).toBe(false);
        expect(codexVersionAtLeast('1.0.0')).toBe(true);
    });
    it('lets an unknown version through (the request answers for itself)', () => {
        expect(codexVersionAtLeast(null)).toBe(true);
        expect(codexVersionAtLeast('dev')).toBe(true);
    });
});

describe('readCodexGoal', () => {
    it('keeps a well-formed goal and drops anything else', () => {
        const goal = { objective: 'x', status: 'budgetLimited', tokenBudget: 10, tokensUsed: 12, timeUsedSeconds: 3, updatedAt: 1 };
        expect(readCodexGoal(goal)).toEqual(goal);
        expect(readCodexGoal(null)).toBeNull();
        expect(readCodexGoal({ ...goal, status: 'nope' })).toBeNull();
        expect(readCodexGoal({ status: 'active' })).toBeNull();
    });
});
