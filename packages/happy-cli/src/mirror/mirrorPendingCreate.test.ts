/**
 * B-305 — retry policy for a mirror bind whose shadow-session create failed.
 *
 * The production failure these tests encode: the server answered POST
 * /v1/sessions with 429 while a hand-typed claude was starting, the hook was
 * never retried, and that terminal ran claude for hours with no structured-view
 * toggle. See mirrorPendingCreate.ts.
 */
import { describe, it, expect } from 'vitest';
import type { TerminalHookEvent } from './mirrorProtocol';
import {
    PENDING_CREATE_BACKOFF_MS,
    PENDING_CREATE_MAX_AGE_MS,
    backoffForAttempt,
    pendingCreateAfterFailure,
    pendingCreateSupersededBy,
    planPendingCreate,
} from './mirrorPendingCreate';

const T0 = 1_700_000_000_000;

function start(claudeSessionId: string, terminalId = 'term-1'): TerminalHookEvent {
    return { event: 'SessionStart', claudeSessionId, terminalId, source: 'startup' };
}
function end(claudeSessionId: string, terminalId = 'term-1'): TerminalHookEvent {
    return { event: 'SessionEnd', claudeSessionId, terminalId };
}

describe('backoffForAttempt', () => {
    it('walks the ladder and then holds at its last rung', () => {
        expect(backoffForAttempt(1)).toBe(PENDING_CREATE_BACKOFF_MS[0]);
        expect(backoffForAttempt(2)).toBe(PENDING_CREATE_BACKOFF_MS[1]);
        expect(backoffForAttempt(PENDING_CREATE_BACKOFF_MS.length)).toBe(PENDING_CREATE_BACKOFF_MS.at(-1));
        expect(backoffForAttempt(99)).toBe(PENDING_CREATE_BACKOFF_MS.at(-1));
    });

    it('first retry lands inside the one-minute window the write-rate bucket refills on', () => {
        expect(backoffForAttempt(1)).toBeLessThan(60_000);
    });
});

describe('pendingCreateAfterFailure', () => {
    it('records the first failure with the event to replay', () => {
        const pending = pendingCreateAfterFailure(undefined, start('claude-a'), T0);
        expect(pending.attempts).toBe(1);
        expect(pending.firstFailedAt).toBe(T0);
        expect(pending.event.claudeSessionId).toBe('claude-a');
        expect(pending.nextAttemptAt).toBe(T0 + PENDING_CREATE_BACKOFF_MS[0]);
    });

    it('backs off further for the SAME conversation, keeping the original deadline anchor', () => {
        const first = pendingCreateAfterFailure(undefined, start('claude-a'), T0);
        const second = pendingCreateAfterFailure(first, start('claude-a'), T0 + 10_000);
        expect(second.attempts).toBe(2);
        expect(second.firstFailedAt).toBe(T0);
        expect(second.nextAttemptAt).toBe(T0 + 10_000 + PENDING_CREATE_BACKOFF_MS[1]);
    });

    it('restarts the ladder for a DIFFERENT conversation in the same terminal', () => {
        const first = pendingCreateAfterFailure(undefined, start('claude-a'), T0);
        const other = pendingCreateAfterFailure(first, start('claude-b'), T0 + 10_000);
        expect(other.attempts).toBe(1);
        expect(other.firstFailedAt).toBe(T0 + 10_000);
    });
});

describe('planPendingCreate', () => {
    it('waits until the backoff elapses, then retries', () => {
        const pending = pendingCreateAfterFailure(undefined, start('claude-a'), T0);
        expect(planPendingCreate(pending, pending.nextAttemptAt - 1)).toBe('wait');
        expect(planPendingCreate(pending, pending.nextAttemptAt)).toBe('retry');
    });

    it('gives up once the parked event is older than the max age', () => {
        const pending = pendingCreateAfterFailure(undefined, start('claude-a'), T0);
        expect(planPendingCreate(pending, T0 + PENDING_CREATE_MAX_AGE_MS - 1)).toBe('retry');
        expect(planPendingCreate(pending, T0 + PENDING_CREATE_MAX_AGE_MS)).toBe('drop');
    });
});

describe('pendingCreateSupersededBy', () => {
    const pending = pendingCreateAfterFailure(undefined, start('claude-a'), T0);

    it('any SessionStart supersedes — it will park itself again if it also fails', () => {
        expect(pendingCreateSupersededBy(pending, start('claude-b'))).toBe(true);
    });

    it('a SessionEnd for the parked conversation kills it — that claude is gone', () => {
        expect(pendingCreateSupersededBy(pending, end('claude-a'))).toBe(true);
    });

    it('a stale SessionEnd for an OLDER conversation must not discard the parked create', () => {
        // /clear order is SessionEnd(old) → SessionStart(new); a late-arriving
        // end for the old id would otherwise throw away the new pending bind.
        expect(pendingCreateSupersededBy(pending, end('claude-older'))).toBe(false);
    });
});
