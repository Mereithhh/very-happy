/**
 * Map a todo RPC failure to a translated, human-readable message (B-007).
 *
 * Two rules this file exists to enforce:
 *  - `provider-error` carries the provider's own stderr in `failure.error`.
 *    That string is the single most useful diagnostic the user will ever get
 *    (their script, their bug) — it is shown VERBATIM. Collapsing it into
 *    "unknown error" locks the user out of their own provider.
 *  - `not-configured` is NOT an error: the feature is simply off on that
 *    machine. `isSetupNeeded()` lets the screen render onboarding instead of a
 *    red box; the headline below is only the fallback (toasts).
 *
 * Same shape as fsFailureText.ts, and 'unsupported' keeps fsBrowser's framing:
 * the relay answers identically for "daemon too old" and "machine offline", so
 * the copy names both causes rather than guessing.
 */
import type { TodoFailure } from '@/sync/todoFailure';
import type { t as translate } from '@/text';

export function isSetupNeeded(failure: TodoFailure): boolean {
    return failure.code === 'not-configured';
}

export function todoFailureText(t: typeof translate, failure: TodoFailure): string {
    switch (failure.code) {
        case 'not-configured':
            return t('todos.notConfiguredTitle');
        case 'unsupported':
            return t('todos.unsupported');
        case 'timeout':
            return t('todos.timeout');
        case 'provider-error':
            // verbatim stderr — see the header comment
            return t('todos.providerError', { error: failure.error });
        case 'bad-output':
            return t('todos.badOutput', { error: failure.error });
        case 'unknown':
        default:
            return t('todos.unknownError', { error: failure.error });
    }
}
