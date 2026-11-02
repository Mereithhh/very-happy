/**
 * B-874: `metadata.issue` for a session the daemon's issue worker started
 * (spawn env VH_ISSUE_ID / VH_ISSUE_RUN_ID / VH_ISSUE_KEY). Display only (Web
 * session-header chip, sidebar); the binding that authorizes `issue_*` writes
 * lives on the server (`IssueRun.sessionId`). Also lets the daemon recover an
 * uncertain spawn by run id.
 */
export type SessionIssueMetadata = { id: string; runId?: string; key?: string };

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const KEY = /^[A-Z]+-\d{1,9}$/;

export function issueSessionMetadata(env: NodeJS.ProcessEnv = process.env): { issue?: SessionIssueMetadata } {
    const id = env.VH_ISSUE_ID;
    if (!id || !ID.test(id)) return {};
    const runId = env.VH_ISSUE_RUN_ID && ID.test(env.VH_ISSUE_RUN_ID) ? env.VH_ISSUE_RUN_ID : undefined;
    const key = env.VH_ISSUE_KEY && KEY.test(env.VH_ISSUE_KEY) ? env.VH_ISSUE_KEY : undefined;
    return { issue: { id, ...(runId ? { runId } : {}), ...(key ? { key } : {}) } };
}

/** `metadata.issue` read back from any (server or local) metadata copy; null when absent or malformed. */
export function readSessionIssueMetadata(metadata: unknown): SessionIssueMetadata | null {
    const raw = (metadata as { issue?: unknown } | null | undefined)?.issue;
    if (!raw || typeof raw !== 'object') return null;
    const { id, runId, key } = raw as Record<string, unknown>;
    return issueSessionMetadata({
        ...(typeof id === 'string' ? { VH_ISSUE_ID: id } : {}),
        ...(typeof runId === 'string' ? { VH_ISSUE_RUN_ID: runId } : {}),
        ...(typeof key === 'string' ? { VH_ISSUE_KEY: key } : {}),
    }).issue ?? null;
}

export const ISSUE_ENV_KEYS = ['VH_ISSUE_ID', 'VH_ISSUE_RUN_ID', 'VH_ISSUE_KEY'] as const;

/**
 * B-874c (QA43 P1-1): the spawn env of a relaunched wrapper (auto-restart,
 * Restart/Restore, account switch, crash restart, hibernation wake) — the
 * issue binding comes from the session's metadata, never from whatever the
 * daemon itself inherited. Spread it after `process.env`: every key is set
 * (`undefined` drops an inherited one in child_process).
 */
export function issueRelaunchEnv(metadata: unknown): Record<(typeof ISSUE_ENV_KEYS)[number], string | undefined> {
    const issue = readSessionIssueMetadata(metadata);
    return { VH_ISSUE_ID: issue?.id, VH_ISSUE_RUN_ID: issue?.runId, VH_ISSUE_KEY: issue?.key };
}
