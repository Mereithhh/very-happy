/**
 * B-633: reopening a pi conversation (pi-acp `session/load`) after the agent
 * process died inside a live wrapper, or after the wrapper itself was
 * restarted by the daemon (resume of an offline/archived session).
 * Pure — the wording and the reconnect env contract are unit-tested.
 */
import type { StartSessionResult } from '@/agent/core';

/** The daemon's resume-in-place contract (same env runClaude / runCodex read). */
export type AcpReconnectEnv = {
    sessionId: string;
    encryptionKey: string;
    encryptionVariant: 'legacy' | 'dataKey';
    seq: number;
    metadataVersion: number;
    agentStateVersion: number;
};

export function readAcpReconnectEnv(env: Readonly<Record<string, string | undefined>>): AcpReconnectEnv | null {
    const sessionId = env.HAPPY_RECONNECT_SESSION_ID;
    const encryptionKey = env.HAPPY_RECONNECT_ENCRYPTION_KEY;
    const variant = env.HAPPY_RECONNECT_ENCRYPTION_VARIANT;
    if (!sessionId || !encryptionKey || (variant !== 'legacy' && variant !== 'dataKey')) return null;
    const int = (value: string | undefined) => {
        const n = parseInt(value || '0', 10);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    return {
        sessionId,
        encryptionKey,
        encryptionVariant: variant,
        seq: int(env.HAPPY_RECONNECT_SEQ),
        metadataVersion: int(env.HAPPY_RECONNECT_METADATA_VERSION),
        agentStateVersion: int(env.HAPPY_RECONNECT_AGENT_STATE_VERSION),
    };
}

/**
 * The one line the session shows after a fresh agent process took over.
 * `agent-exit`: the agent died and was restarted in the same wrapper;
 * `resume`: a new wrapper (daemon resume) — only called when it did not reopen.
 */
export function piRestartNotice(
    agentName: string,
    cause: 'agent-exit' | 'resume',
    started: Pick<StartSessionResult, 'resumed' | 'loadFailure'>,
): string {
    const head = cause === 'agent-exit' ? `${agentName} was restarted after its process exited` : `${agentName} was started again`;
    if (started.resumed === 'loaded') return `${head} and reopened the earlier conversation.`;
    if (started.resumed === 'fresh') {
        const why = started.loadFailure ? ` (${oneLine(started.loadFailure)})` : '';
        return `${head} but could not reopen the earlier conversation${why}; it does not remember it (the transcript here is kept).`;
    }
    return `${head}; it does not remember the earlier conversation (the transcript here is kept).`;
}

function oneLine(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

/** What `--resume` may carry: a pi session id (uuid-like), never something that parses as a flag. */
export function sanitizeAgentSessionId(value: unknown): string | null {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null;
}
