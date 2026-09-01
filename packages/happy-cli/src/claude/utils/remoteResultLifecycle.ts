import type { SDKResultMessage } from '../sdk/types';

/**
 * Decide how a remote-mode turn closes from its SDK result frame.
 *
 * A turn is failed when the SDK says so structurally (`subtype !== 'success'`)
 * OR when it is a "successful" frame carrying `is_error: true` — the shape
 * Claude Code uses for API-level failures such as `authentication_failed`
 * (B-275) or rate limits. The session protocol mapper already marks such turns
 * failed for the web; closing them as completed here only produced a `done`
 * push for a turn the user sees as an error, so both paths now agree.
 */
export function applyClaudeResultLifecycle(
    result: SDKResultMessage | undefined,
    callbacks: {
        closeCompleted: () => void;
        closeFailed: (error: string) => void;
        onFailed: (error: string) => void;
        onCompleted: () => void;
    },
): void {
    if (result && (result.subtype !== 'success' || result.is_error === true)) {
        const frame = result as { errors?: string[]; result?: unknown; subtype: string };
        const error = frame.errors?.filter(Boolean).join('\n').trim()
            || (typeof frame.result === 'string' ? frame.result.trim() : '')
            || frame.subtype;
        callbacks.closeFailed(error);
        callbacks.onFailed(error);
        return;
    }
    callbacks.closeCompleted();
    callbacks.onCompleted();
}
