/**
 * What a failed Codex turn tells the user (B-487, B-622).
 *
 * Codex puts the backend's HTTP error body, JSON-encoded, in
 * `turn.error.message` — e.g. `{"type":"error","status":400,"error":{"type":
 * "invalid_request_error","message":"The 'gpt-6-sol' model is not supported
 * when using Codex with a ChatGPT account."}}` (codex 0.150.0 + ChatGPT
 * sign-in, probed 2026-09-24). The inner `error.message` is the sentence the
 * user needs; the envelope is noise.
 *
 * A gateway failure arrives as `unexpected status 504 Gateway Timeout: <html>
 * …</html>, url: https://…/responses` (codex 0.154.0, probed 2026-10-18 with a
 * 504 upstream): status line, raw body, url. The body is usually an nginx
 * boilerplate page or a JSON envelope around one — it is reduced to its one
 * human sentence, or dropped when it only repeats the status.
 *
 * A turn that throws before Codex reports anything (a JSON-RPC rejection of
 * turn/start, or our own pre-flight refusal) used to be flattened into
 * "Process exited unexpectedly" with the reason dropped. Only a real process
 * or transport loss deserves that generic line.
 */

const UNEXPECTED_STATUS = /^unexpected status (\d{3}) ([^:]*?):\s*([\s\S]*?)(?:,\s*url:\s*(\S+))?$/;

/** Unwrap a JSON-encoded API error body to its human sentence. */
export function readableCodexErrorText(text: string): string {
    const trimmed = text.trim();
    const status = UNEXPECTED_STATUS.exec(trimmed);
    if (status) {
        const [, code, reason, rawBody, url] = status;
        const head = `HTTP ${code} ${reason.trim()} from the model API`;
        const detail = readableHttpBody(rawBody, `${code} ${reason}`);
        return `${head}${detail ? `: ${detail}` : ''}${url ? ` (${url})` : ''}`;
    }
    return unwrapJsonMessage(trimmed) ?? trimmed;
}

/** `error.message` / `error` / `message` out of a JSON error envelope, or null when there is none. */
function unwrapJsonMessage(text: string): string | null {
    if (!text.startsWith('{')) return null;
    try {
        const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
        const inner = typeof body.error === 'object' && body.error ? body.error.message : undefined;
        const message = typeof inner === 'string' && inner.trim() ? inner
            : typeof body.error === 'string' && body.error.trim() ? body.error
            : typeof body.message === 'string' && body.message.trim() ? body.message
            : null;
        return message ? message.trim() : null;
    } catch {
        return null;
    }
}

/**
 * The body of an HTTP error reduced to what a person can use: JSON unwrapped,
 * an HTML page reduced to its <title>, whitespace collapsed, and nothing at all
 * when it only repeats the status line ("504 Gateway Time-out").
 */
function readableHttpBody(raw: string, statusLine: string): string | null {
    let body = unwrapJsonMessage(raw.trim()) ?? raw.trim();
    if (/<[a-z!/][^>]*>/i.test(body)) {
        const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
        body = title ? title[1] : body.replace(/<[^>]+>/g, ' ');
    }
    body = body.replace(/\s+/g, ' ').trim();
    if (!body) return null;
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalize(body) === normalize(statusLine)) return null;
    return body.length > 240 ? `${body.slice(0, 240)}…` : body;
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

/**
 * The line for a `turn_retry` event — Codex's own "Reconnecting... 2/5" after a
 * 5xx or a dropped stream (B-622). Shown as it happens, so a turn that is
 * sitting through a retry backoff does not look dead.
 */
export function describeCodexRetry(msg: any): string {
    const message = typeof msg?.message === 'string' ? msg.message.trim() : '';
    const status = typeof msg?.http_status === 'number' ? msg.http_status : null;
    const cause = status ? `HTTP ${status} from the model API` : 'a model API error';
    return message ? `Codex is retrying after ${cause} (${message})` : `Codex is retrying after ${cause}`;
}

/**
 * B-623: the app-server's last stderr lines, carried on the error a dead process
 * rejected a request with (`codexAppServerClient` `proc.on('exit')`), or null.
 */
export function codexStderrTailOf(error: unknown): string | null {
    const tail = (error as { codexStderrTail?: unknown } | null)?.codexStderrTail;
    return typeof tail === 'string' && tail.trim() ? tail.trim() : null;
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
