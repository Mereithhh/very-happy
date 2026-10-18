/**
 * B-630: what a failed Gemini turn says, and which failures are worth one more try.
 *
 * The texts are the ones runGemini used to pick inline (quota, rate limit, auth for Workspace
 * accounts, model not found, empty response); they moved here so they are tested, reported
 * once per turn as a service line (not as the assistant speaking), and so the retry decision
 * stops at transient failures — before, every error Gemini wrapped as JSON-RPC -32603 (a 404
 * for a model that does not exist included) was retried three times.
 */
import { isAgentExitError } from '@/agent/acp/acpAgentExit';

export type GeminiFailureKind = 'exited' | 'quota' | 'rate-limit' | 'auth' | 'not-found' | 'empty' | 'not-installed' | 'other';

export type GeminiFailure = {
    kind: GeminiFailureKind;
    /** The service line the session shows. */
    message: string;
};

type ErrorFacts = { code: unknown; details: string; message: string; whole: string; empty: boolean };

function factsOf(error: unknown): ErrorFacts {
    if (error instanceof Error) {
        const record = error as Error & { code?: unknown; data?: { details?: unknown }; details?: unknown };
        const details = typeof record.data?.details === 'string' ? record.data.details : (typeof record.details === 'string' ? record.details : '');
        return { code: record.code, details, message: error.message, whole: `${details} ${error.message}`, empty: false };
    }
    if (error && typeof error === 'object') {
        const record = error as { code?: unknown; status?: unknown; response?: { status?: unknown }; data?: { details?: unknown }; details?: unknown; message?: unknown; error?: { message?: unknown } };
        const details = typeof record.data?.details === 'string' ? record.data.details : (typeof record.details === 'string' ? record.details : '');
        const message = typeof record.message === 'string' ? record.message : (typeof record.error?.message === 'string' ? record.error.message : '');
        let whole = `${details} ${message}`;
        try { whole += ` ${JSON.stringify(error)}`; } catch { /* ignore */ }
        return { code: record.code ?? record.status ?? record.response?.status, details, message, whole, empty: Object.keys(error).length === 0 };
    }
    return { code: undefined, details: '', message: String(error), whole: String(error), empty: false };
}

function quotaResetSuffix(text: string): string {
    const match = text.match(/reset after (\d+h)?(\d+m)?(\d+s)?/i);
    if (!match) return '';
    const parts = match.slice(1).filter(Boolean).join('');
    return parts ? ` Quota resets in ${parts}.` : '';
}

const EMPTY_RESPONSE = /empty response|Model stream ended/i;
/** A transient upstream condition Gemini CLI reports through the prompt error. */
const TRANSIENT = /overloaded|UNAVAILABLE|\b503\b|ECONNRESET|socket hang up|ETIMEDOUT/i;

/** Whether one more attempt at the same prompt makes sense. */
export function isRetryableGeminiError(error: unknown): boolean {
    if (isAgentExitError(error)) return false;
    const facts = factsOf(error);
    if (/exhausted|quota|capacity/i.test(facts.whole)) return false;
    return EMPTY_RESPONSE.test(facts.whole) || TRANSIENT.test(facts.whole);
}

export function describeGeminiFailure(error: unknown, ctx: { model: string }): GeminiFailure {
    if (isAgentExitError(error)) {
        return { kind: 'exited', message: `Process exited unexpectedly: ${error.message}` };
    }
    const f = factsOf(error);
    if (f.code === 404 || /notFound|\b404\b/.test(f.details) || /not found|\b404\b/.test(f.message)) {
        return { kind: 'not-found', message: `Gemini error: model "${ctx.model}" not found. Available models: gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite` };
    }
    if (EMPTY_RESPONSE.test(f.whole)) {
        return { kind: 'empty', message: 'Gemini error: the API returned an empty response after retries. This is usually temporary — please try again.' };
    }
    if (f.code === 429 || /\b429\b|rateLimitExceeded|RESOURCE_EXHAUSTED|Rate limit exceeded|Resource exhausted/i.test(f.whole)) {
        return { kind: 'rate-limit', message: 'Gemini error: API rate limit exceeded. Please wait a moment and try again.' };
    }
    if (/quota|exhausted|capacity/i.test(f.whole)) {
        return { kind: 'quota', message: `Gemini error: quota exceeded.${quotaResetSuffix(f.whole)} Try another model (gemini-2.5-flash-lite) or wait for the quota to reset.` };
    }
    if (f.code === -32000 || /Authentication required/i.test(f.whole)) {
        return {
            kind: 'auth',
            message: 'Gemini error: authentication required. For Google Workspace accounts set a Google Cloud project: `very-happy gemini project set <your-project-id>`; or use another Google account: `very-happy connect gemini`. Guide: https://goo.gle/gemini-cli-auth-docs#workspace-gca',
        };
    }
    if (f.empty) {
        return { kind: 'not-installed', message: 'Gemini error: failed to start Gemini. Is the "gemini" CLI installed? Run: npm install -g @google/gemini-cli' };
    }
    const text = (f.details || f.message || 'process error occurred').replace(/\s+/g, ' ').trim();
    return { kind: 'other', message: `Gemini error: ${text.length > 400 ? `${text.slice(0, 399)}…` : text}` };
}

/** The retry notice the session shows between attempts (B-622's shape for Codex). */
export function describeGeminiRetry(attempt: number, maxAttempts: number, error: unknown): string {
    const f = factsOf(error);
    const why = EMPTY_RESPONSE.test(f.whole) ? 'an empty response' : 'a transient API error';
    return `Gemini is retrying after ${why} (attempt ${attempt}/${maxAttempts})`;
}
