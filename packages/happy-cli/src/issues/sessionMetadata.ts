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
