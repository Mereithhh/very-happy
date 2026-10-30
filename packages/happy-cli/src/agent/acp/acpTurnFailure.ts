/**
 * B-629: one line for a turn an ACP agent did not finish, in the words the agent gave
 * (Orca keeps the provider's own `data.details`, src/main/acp/acp-turn-failures.ts).
 * The shapes: the agent process died (AgentExitError, with its stderr tail), a JSON-RPC
 * error object the SDK rejects with (`{code, message, data?: {details?}}`), or an Error.
 */
import { isAgentExitError } from './acpAgentExit';

const MAX_DETAIL_CHARS = 400;

function detailOf(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error && typeof error === 'object') {
        const record = error as { message?: unknown; data?: unknown; code?: unknown };
        const data = record.data && typeof record.data === 'object' ? record.data as { details?: unknown } : null;
        const details = typeof data?.details === 'string' ? data.details : null;
        const message = typeof record.message === 'string' ? record.message : null;
        const text = details && message && details !== message ? `${message}: ${details}` : (details ?? message);
        if (text) return text;
        try { return JSON.stringify(error); } catch { return String(error); }
    }
    return String(error);
}

function oneLine(text: string): string {
    const folded = text.replace(/\s+/g, ' ').trim();
    return folded.length > MAX_DETAIL_CHARS ? `${folded.slice(0, MAX_DETAIL_CHARS - 1)}…` : folded;
}

export type AcpTurnFailure = {
    /** The service line the session shows. */
    message: string;
    /**
     * B-845b: the agent's own reason, carried as the failed `turn-end`'s `error` so
     * `sessions read` says why (pi's rejected /compact: `data.details` "Nothing to compact").
     */
    error: string;
    /** The agent process is gone: the next prompt needs a fresh one. */
    exited: boolean;
};

export function describeAcpTurnFailure(agentName: string, error: unknown): AcpTurnFailure {
    if (isAgentExitError(error)) {
        // The web styles this prefix as a process failure (serviceEvent.ts).
        const detail = oneLine(error.message);
        return { message: `Process exited unexpectedly: ${detail}`, error: detail, exited: true };
    }
    const detail = oneLine(detailOf(error));
    return { message: `${agentName} error: ${detail}`, error: detail, exited: false };
}
