/**
 * What a failed Codex turn tells the user (B-487).
 *
 * Codex puts the backend's HTTP error body, JSON-encoded, in
 * `turn.error.message` — e.g. `{"type":"error","status":400,"error":{"type":
 * "invalid_request_error","message":"The 'gpt-6-sol' model is not supported
 * when using Codex with a ChatGPT account."}}` (codex 0.150.0 + ChatGPT
 * sign-in, probed 2026-09-24). The inner `error.message` is the sentence the
 * user needs; the envelope is noise.
 *
 * A turn that throws before Codex reports anything (a JSON-RPC rejection of
 * turn/start, or our own pre-flight refusal) used to be flattened into
 * "Process exited unexpectedly" with the reason dropped. Only a real process
 * or transport loss deserves that generic line.
 */

/** Unwrap a JSON-encoded API error body to its human sentence. */
export function readableCodexErrorText(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) return trimmed;
    try {
        const body = JSON.parse(trimmed) as { error?: { message?: unknown } | string; message?: unknown };
        const inner = typeof body.error === 'object' && body.error ? body.error.message : undefined;
        const message = typeof inner === 'string' && inner.trim() ? inner
            : typeof body.error === 'string' && body.error.trim() ? body.error
            : typeof body.message === 'string' && body.message.trim() ? body.message
            : null;
        return message ? message.trim() : trimmed;
    } catch {
        return trimmed;
    }
}

/** The failure carried by a task_complete / turn_aborted event, or null. */
export function describeCodexFailure(msg: any): string | null {
    const hasFailure = msg?.status === 'failed' || (msg?.error !== undefined && msg?.error !== null);
    if (!hasFailure) return null;
    const err = msg.error;
    if (typeof err === 'string' && err.length > 0) return readableCodexErrorText(err);
    if (err && typeof err === 'object' && typeof err.message === 'string' && err.message.length > 0) {
        return readableCodexErrorText(err.message);
    }
    return 'Unknown error';
}

/** Losing the app-server itself — the only case the generic line is right for. */
const TRANSPORT_LOSS = /^Codex process (exited|disconnected)\b|stdin not writable| timed out after \d+ms/;

/**
 * The reason to show for an error thrown out of a turn, or null when the
 * process/transport died and the generic "Process exited unexpectedly" (with
 * its restart action) is the honest message.
 */
export function describeThrownTurnError(error: unknown): string | null {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    if (!message.trim() || TRANSPORT_LOSS.test(message)) return null;
    return readableCodexErrorText(message);
}
