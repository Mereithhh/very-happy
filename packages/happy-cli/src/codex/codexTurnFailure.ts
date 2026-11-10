/**
 * B-913 — the Codex half of "the model / upstream API ended this turn with an
 * error": a `task_complete` / `turn_aborted` that carries a failure
 * (`describeCodexFailure`). Account problems are not turn failures — they keep
 * their own banners (401 → account rejected, another org's history → history
 * rejected); an app-server crash never reaches here (B-625 / B-901 lines).
 */
import { summarizeTurnError, turnErrorStatus, type TurnFailure } from '@slopus/happy-wire';
import { isCodexAuthRejection, isHistoryRejectedError } from '@/agentProfiles/codexAccount';

export function codexTurnFailure(failure: string | null, now: number = Date.now()): TurnFailure | null {
    if (!failure) return null;
    if (isCodexAuthRejection(failure) || isHistoryRejectedError(failure)) return null;
    return { at: now, summary: summarizeTurnError(failure), provider: 'codex', status: turnErrorStatus(failure) };
}
