import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ISSUE_AGENT_STATUSES, ISSUE_LIMITS, ISSUE_STATUSES, parseIssueRef } from '@slopus/happy-wire';
import type { AssistantToolRegistrar } from '@/assistant/assistantTools';
import { sharedProjectsClient, type ProjectsClient } from '@/projects/client';
import { sharedIssuesClient, type IssuesClient } from './client';
import { describeIssueError, formatIssueDetail, formatIssueLine } from './format';

/**
 * B-874 `issue_*` MCP tools (spec §4). Registered unconditionally like the
 * project tools (a fixed tools prefix); an unbound session gets
 * `issue_not_bound` from the server. They run in the owning session process,
 * which stamps its own session id (the agent cannot fill it). Same transports
 * as the project tools: in-process for Claude / pi (HAPPY_MCP_URL), forwarded
 * by name by the Codex stdio bridge.
 *
 * `issue_update.status` is a plain string on purpose: a `done` / `cancelled`
 * attempt reaches the server and is refused there as `issue_status_forbidden`
 * (the code agents and tests branch on), not as a schema error.
 */

export const ISSUE_TOOL_NAMES = ['issue_get', 'issue_update', 'issue_comment', 'issue_list'] as const;
export type IssueToolName = typeof ISSUE_TOOL_NAMES[number];

export const ISSUE_TOOL_SCHEMAS: Record<IssueToolName, { title: string; description: string; readOnly: boolean; inputSchema: Record<string, z.ZodTypeAny> }> = {
    issue_get: {
        title: 'Read Issue',
        readOnly: true,
        description: 'Read a Very Happy issue: title, status, description, recent timeline and runs. Without `issue` it reads the issue this session is working on.',
        inputSchema: {
            issue: z.string().min(1).max(128).optional().describe('Issue key (VH-12) or id; omit for this session\'s issue'),
        },
    },
    issue_update: {
        title: 'Update Issue Status',
        readOnly: false,
        description: `Set this session's issue status and/or add a comment. Agents may set only ${ISSUE_AGENT_STATUSES.join(', ')}; in_review and blocked need a comment (what you delivered and how it was verified / exactly what you need). Never done or cancelled: only the owner closes an issue.`,
        inputSchema: {
            status: z.string().min(1).max(64).optional().describe(ISSUE_AGENT_STATUSES.join(' | ')),
            comment: z.string().min(1).max(ISSUE_LIMITS.commentBytes).optional().describe('Comment posted on the issue with this change'),
        },
    },
    issue_comment: {
        title: 'Comment on Issue',
        readOnly: false,
        description: 'Comment on the issue this session is working on. Set mention_owner=true only when the owner must answer or decide something; it lands in their 「需要我决策」 list.',
        inputSchema: {
            body: z.string().min(1).max(ISSUE_LIMITS.commentBytes).describe('Markdown comment'),
            mention_owner: z.boolean().optional().describe('Ask the owner (@me)'),
        },
    },
    issue_list: {
        title: 'List Issues',
        readOnly: true,
        description: 'List this account\'s issues (read only), newest first.',
        inputSchema: {
            status: z.array(z.enum(ISSUE_STATUSES)).max(ISSUE_STATUSES.length).optional().describe('Only these statuses'),
            project: z.enum(['current', 'any']).optional().describe('current = this session\'s project only'),
            limit: z.number().int().min(1).max(50).optional(),
        },
    },
};

export type IssueToolExecutor = (name: IssueToolName, args: any) => Promise<{ text: string }>;

export function createIssueToolExecutor(
    sessionId: () => string,
    deps: { client?: IssuesClient; projects?: Pick<ProjectsClient, 'membership'>; scoped?: () => boolean } = {},
): IssueToolExecutor {
    const client = deps.client ?? sharedIssuesClient();
    const scoped = deps.scoped ?? (() => process.env.VH_TEAM_SCOPE_FILE !== undefined);
    return async (name, args) => {
        const sid = sessionId();
        if (name === 'issue_get') {
            const ref = typeof args?.issue === 'string' ? args.issue.trim() : '';
            const ctx = await client.session(sid);
            const bound = ctx.issue && (!ref || matchesRef(ref, ctx.issue));
            if (bound && ctx.issue) {
                const detail = await client.get(ctx.issue.id).catch(() => null);
                return { text: formatIssueDetail({ issue: ctx.issue, comments: ctx.comments, runs: detail?.runs, current: ctx.current, bound: true }) };
            }
            if (!ref) throw new Error('issue_not_bound: This session is not working on an issue (it was not started from one). Pass issue="VH-N" to read another.');
            // Scoped Teams sessions read only their own issue (spec §4).
            if (scoped()) throw new Error('issue_not_bound: Scoped Teams sessions can read only the issue they are working on.');
            const detail = await client.get(ref);
            return { text: formatIssueDetail({ issue: detail.issue, comments: detail.comments, runs: detail.runs }) };
        }
        if (name === 'issue_update') {
            const result = await client.agentUpdate({
                sessionId: sid, requestId: randomUUID(),
                ...(typeof args?.status === 'string' ? { status: args.status } : {}),
                ...(typeof args?.comment === 'string' ? { comment: args.comment } : {}),
            });
            return { text: `${result.issue.key} is ${result.issue.status}${result.comment ? ' (comment posted)' : ''}` };
        }
        if (name === 'issue_comment') {
            const result = await client.agentComment({ sessionId: sid, body: String(args?.body ?? ''), requestId: randomUUID(), ...(args?.mention_owner === true ? { mentionOwner: true } : {}) });
            return { text: `commented on ${result.issue.key}${args?.mention_owner === true ? ' (owner notified)' : ''}` };
        }
        if (scoped()) throw new Error('issue_not_bound: Scoped Teams sessions can read only the issue they are working on (use issue_get).');
        let projectId: string | undefined;
        if (args?.project === 'current') {
            const membership = await (deps.projects ?? sharedProjectsClient()).membership(sid).catch(() => ({ projectId: null }));
            if (!membership.projectId) return { text: 'not in a project' };
            projectId = membership.projectId;
        }
        const list = await client.list({ ...(Array.isArray(args?.status) && args.status.length ? { status: args.status.join(',') } : {}), ...(projectId ? { projectId } : {}), limit: typeof args?.limit === 'number' ? args.limit : 20 });
        return { text: list.issues.length ? list.issues.map(formatIssueLine).join('\n') : 'no issues' };
    };
}

function matchesRef(ref: string, issue: { id: string; number: number }): boolean {
    const parsed = parseIssueRef(ref);
    if (!parsed) return false;
    return 'number' in parsed ? parsed.number === issue.number : parsed.id === issue.id;
}

/** `skip`: names another surface registers instead (B-916b: the main agent's account-level issue_list / issue_comment). */
export function registerIssueTools(server: AssistantToolRegistrar, execute: IssueToolExecutor, skip: readonly string[] = []): void {
    for (const name of ISSUE_TOOL_NAMES) {
        if (skip.includes(name)) continue;
        const spec = ISSUE_TOOL_SCHEMAS[name];
        server.registerTool(name, {
            description: spec.description, title: spec.title, inputSchema: spec.inputSchema,
            annotations: { readOnlyHint: spec.readOnly, idempotentHint: spec.readOnly, openWorldHint: false, destructiveHint: false },
        }, async (args: any) => {
            try { return { content: [{ type: 'text' as const, text: (await execute(name, args ?? {})).text }], isError: false }; }
            catch (error) { return { content: [{ type: 'text' as const, text: describeIssueError(error) }], isError: true }; }
        });
    }
}
