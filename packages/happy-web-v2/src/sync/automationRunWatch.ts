/**
 * 「立即运行」 queues a run; the daemon claims it and starts (or reuses) a
 * session later. This follows the one run until it has a session or ends, then
 * hands over to dispatchFeedback: a session that was not in the store before
 * is new (toast + reveal + 「新」), a reused sticky session is a delivery (toast
 * + reveal), a failed / skipped run shows its reason. Runs without a session (a command
 * action) end quietly — the 「已排队运行」 toast already said it started.
 */
import { AUTOMATION_RUN_TERMINAL_STATUSES, type AutomationRun } from '@slopus/happy-wire';
import { getRun } from './apiAutomations';
import { announceDispatched, announceDispatchFailed } from './dispatchFeedback';
import { storage } from './storage';

export const AUTOMATION_RUN_WATCH_MS = 5 * 60_000;
export const AUTOMATION_RUN_POLL_MS = 2_000;

export type RunOutcome =
    | { kind: 'pending' }
    | { kind: 'session'; sessionId: string; reused: boolean }
    | { kind: 'failed'; error: string }
    | { kind: 'quiet' };

/** Pure: where the run stands. `known` = session ids the store had when the run was queued. */
export function automationRunOutcome(run: AutomationRun, known: ReadonlySet<string>): RunOutcome {
    if (run.sessionId) return { kind: 'session', sessionId: run.sessionId, reused: known.has(run.sessionId) };
    // skipped: 立即运行 started nothing (e.g. the previous run still holds the slot) — say why.
    if (run.status === 'failed' || run.status === 'expired' || run.status === 'skipped') return { kind: 'failed', error: run.error ?? run.summary ?? run.status };
    if (AUTOMATION_RUN_TERMINAL_STATUSES.includes(run.status)) return { kind: 'quiet' };
    return { kind: 'pending' };
}

/** Called after a successful 「立即运行」 with the queued run. */
export function watchAutomationRun(run: AutomationRun): void {
    const known = new Set(Object.keys(storage.getState().sessions));
    const until = Date.now() + AUTOMATION_RUN_WATCH_MS;
    const name = run.automationName;
    const step = (current: AutomationRun) => {
        const outcome = automationRunOutcome(current, known);
        if (outcome.kind === 'session') announceDispatched({ sessionId: outcome.sessionId, name, kind: outcome.reused ? 'delivered' : 'created' });
        else if (outcome.kind === 'failed') announceDispatchFailed({ name, reason: outcome.error });
        else if (outcome.kind === 'pending' && Date.now() < until) setTimeout(tick, AUTOMATION_RUN_POLL_MS);
    };
    const tick = () => {
        Promise.resolve().then(() => getRun(run.id)).then(({ run: next }) => step(next)).catch(() => { if (Date.now() < until) setTimeout(tick, AUTOMATION_RUN_POLL_MS); });
    };
    step(run);
}
