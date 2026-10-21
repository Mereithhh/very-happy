import type { TeamOperation } from '@slopus/happy-wire';
import type { TeamEffectReceipt } from './journal';

/**
 * B-689: a team launch whose wrapper is confirmed gone (it exited, or was
 * stopped after the spawn window) failed definitively — no live writer can
 * exist — so the same claim and worktree may be launched again. Transient
 * causes (network resets under load) recover by themselves; others stop after
 * a few backed-off attempts and wait for the owner's「重试启动」
 * (`retry-operation` → op.retryRequestedAt).
 *
 * An uncertain spawn (daemon died mid-spawn) is still never retried
 * automatically; only an owner retry, after confirming the old process is
 * gone, moves it back to `prepared`.
 */
/** Published as machine metadata `teamRetryVersion`: 1 = spawn relaunch. */
export const TEAM_RETRY_CAPABILITY_VERSION = 1;

export const TEAM_SPAWN_RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000] as const;
export const TEAM_SPAWN_MAX_ATTEMPTS = TEAM_SPAWN_RETRY_DELAYS_MS.length + 1;

/** An owner retry the daemon has not acted on yet. */
export function ownerRetryPending(op: Pick<TeamOperation, 'retryRequestedAt'>, receipt: Pick<TeamEffectReceipt, 'retryConsumed'>): boolean {
    return typeof op.retryRequestedAt === 'number' && op.retryRequestedAt !== receipt.retryConsumed;
}

export type SpawnGate = 'run' | 'wait' | 'exhausted';

export function spawnGate(receipt: TeamEffectReceipt, now: number): SpawnGate {
    if (receipt.phase !== 'prepared' || !receipt.spawnFailures) return 'run';
    if (receipt.retryAt === undefined) return 'exhausted';
    return now < receipt.retryAt ? 'wait' : 'run';
}

/** Receipt after a definitive startup failure: back to `prepared`, next retry scheduled (or none). */
export function afterStartupFailure(receipt: TeamEffectReceipt, now: number): TeamEffectReceipt {
    const spawnFailures = (receipt.spawnFailures ?? 0) + 1;
    const delay = TEAM_SPAWN_RETRY_DELAYS_MS[spawnFailures - 1];
    const { sessionId: _sessionId, retryAt: _retryAt, ...rest } = receipt;
    return { ...rest, phase: 'prepared', spawnFailures, ...(delay !== undefined ? { retryAt: now + delay } : {}) };
}

export function startupFailureMessage(error: string, receipt: TeamEffectReceipt, now: number): string {
    const attempt = receipt.spawnFailures ?? 1;
    const next = receipt.retryAt !== undefined
        ? `automatic retry ${attempt + 1}/${TEAM_SPAWN_MAX_ATTEMPTS} in ${Math.max(1, Math.round((receipt.retryAt - now) / 1000))}s`
        : `automatic retries exhausted after ${attempt} attempts; use Retry launch after fixing the cause`;
    return `${error} (${next})`;
}

/** An owner retry resets the automatic budget. */
export function consumeOwnerRetry(op: Pick<TeamOperation, 'retryRequestedAt'>, receipt: TeamEffectReceipt): TeamEffectReceipt {
    const { retryAt: _retryAt, sessionId: _sessionId, ...rest } = receipt;
    return { ...rest, phase: 'prepared', spawnFailures: 0, retryConsumed: op.retryRequestedAt };
}
