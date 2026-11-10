/**
 * B-913 — did this Claude turn end because the model / upstream API failed?
 * Pure; the launcher feeds it SDK frames and asks at the result.
 *
 * Shapes seen (SDK 0.3.322, sdk.d.ts + the 11-05 Lead transcript):
 *  - Claude Code ends a turn whose API call failed (a 400, or a 529 after its
 *    own retries ran out) with a synthetic assistant frame: `error` set
 *    ('invalid_request' | 'overloaded' | 'unknown' | …), `message.model`
 *    `<synthetic>`, text `API Error: 400 …`; the result frame then carries
 *    `is_error: true` (older runtimes: not always — the assistant frame alone
 *    decides).
 *  - `subtype: 'error_during_execution'` — the run itself failed.
 *
 * Not a turn failure (each already has its own card / line — one signal per
 * thing): sign-in / account problems (claude-auth card, account banners), a
 * process exit (claude-process-exit), limits the user set (max turns / budget),
 * a stop the user asked for (handled before the result reaches here).
 */
import { summarizeTurnError, turnErrorStatus, type TurnFailure } from '@slopus/happy-wire';

const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'cloud_credential_error']);
const AUTH_TEXT = /authentication_failed|failed to authenticate|oauth session expired|invalid api key|please run \/login/i;
const USER_LIMIT_SUBTYPES = new Set(['error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries']);

const textOf = (content: unknown): string => Array.isArray(content)
    ? content.map((block: any) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n').trim()
    : typeof content === 'string' ? content.trim() : '';

export function createClaudeTurnFailureDetector() {
    let apiError: { kind: string; text: string } | null = null;

    return {
        /** A new turn: forget the last one's assistant error. */
        reset(): void {
            apiError = null;
        },
        observe(message: unknown): void {
            const m = message as any;
            if (m?.type !== 'assistant' || m.parent_tool_use_id) return;
            const text = textOf(m.message?.content);
            const kind = typeof m.error === 'string' && m.error ? m.error : null;
            if (kind || (m.message?.model === '<synthetic>' && /^API Error\b/i.test(text))) {
                apiError = { kind: kind ?? 'unknown', text };
            } else if (text) {
                // a real answer after a retried error: the turn recovered
                apiError = null;
            }
        },
        /** At the result frame: the failure to report, or null. */
        conclude(result: { subtype?: string; is_error?: boolean; result?: unknown; errors?: unknown } | undefined, now: number = Date.now()): TurnFailure | null {
            const resultText = typeof result?.result === 'string' ? result.result
                : Array.isArray(result?.errors) ? result!.errors.filter((e): e is string => typeof e === 'string').join('\n') : '';
            const failedResult = !!result && (result.subtype !== 'success' || result.is_error === true);
            // One verdict per turn: a later turn (a task notification wakes the
            // session without a pulled prompt) must not inherit this error.
            const lastApiError = apiError;
            apiError = null;
            let raw: string | null = null;
            if (lastApiError) {
                if (AUTH_ERRORS.has(lastApiError.kind) || AUTH_TEXT.test(lastApiError.text)) return null;
                raw = lastApiError.text || resultText || lastApiError.kind;
            } else if (failedResult) {
                if (USER_LIMIT_SUBTYPES.has(String(result!.subtype))) return null;
                if (AUTH_TEXT.test(resultText)) return null;
                raw = resultText || String(result!.subtype);
            }
            if (raw === null) return null;
            return { at: now, summary: summarizeTurnError(raw), provider: 'claude', status: turnErrorStatus(raw) };
        },
    };
}

export type ClaudeTurnFailureDetector = ReturnType<typeof createClaudeTurnFailureDetector>;
