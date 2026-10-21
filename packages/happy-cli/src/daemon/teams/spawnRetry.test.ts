import { describe, expect, it } from 'vitest';
import { afterStartupFailure, consumeOwnerRetry, ownerRetryPending, spawnGate, startupFailureMessage, TEAM_SPAWN_MAX_ATTEMPTS } from './spawnRetry';
import type { TeamEffectReceipt } from './journal';

const base: TeamEffectReceipt = { operationId: 'op1', teamId: 't', claimId: 'c', phase: 'spawning', directory: '/w', repository: '/r', branch: 'b', scopeFile: '/s' };

describe('B-689 team spawn retry policy', () => {
    it('backs off 10s/30s/60s/120s and then stops at the attempt budget', () => {
        let receipt = base;
        const waits: (number | undefined)[] = [];
        for (let i = 0; i < TEAM_SPAWN_MAX_ATTEMPTS; i++) {
            receipt = afterStartupFailure({ ...receipt, phase: 'spawning' }, 1000);
            waits.push(receipt.retryAt === undefined ? undefined : receipt.retryAt - 1000);
        }
        expect(waits).toEqual([10_000, 30_000, 60_000, 120_000, undefined]);
        expect(receipt).toMatchObject({ phase: 'prepared', spawnFailures: 5, directory: '/w', scopeFile: '/s' });
        expect(spawnGate(receipt, 10 ** 12)).toBe('exhausted');
        expect(startupFailureMessage('boom', receipt, 1000)).toBe('boom (automatic retries exhausted after 5 attempts; use Retry launch after fixing the cause)');
    });
    it('gates a prepared relaunch on its retry time; a fresh launch always runs', () => {
        const failed = afterStartupFailure(base, 0);
        expect(spawnGate({ ...base, phase: 'prepared' }, 0)).toBe('run');
        expect(spawnGate(failed, 9_999)).toBe('wait');
        expect(spawnGate(failed, 10_000)).toBe('run');
        expect(startupFailureMessage('boom', failed, 0)).toBe('boom (automatic retry 2/5 in 10s)');
    });
    it('acts on each owner retry exactly once and resets the budget', () => {
        const exhausted: TeamEffectReceipt = { ...base, phase: 'prepared', spawnFailures: 5 };
        expect(ownerRetryPending({}, exhausted)).toBe(false);
        expect(ownerRetryPending({ retryRequestedAt: 5 }, exhausted)).toBe(true);
        const consumed = consumeOwnerRetry({ retryRequestedAt: 5 }, { ...exhausted, sessionId: 'stale' });
        expect(consumed).toMatchObject({ phase: 'prepared', spawnFailures: 0, retryConsumed: 5 });
        expect(consumed.sessionId).toBeUndefined();
        expect(ownerRetryPending({ retryRequestedAt: 5 }, consumed)).toBe(false);
        expect(spawnGate(consumed, 0)).toBe('run');
    });
});
