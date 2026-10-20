import { z } from 'zod';
import type { AssistantToolRegistrar } from '@/assistant/assistantTools';
import { ProjectRequestError, ProjectsUnsupportedError, sharedProjectsClient, type ProjectsClient } from './client';
import { formatContextForTool } from './prompt';

/**
 * B-645 `project_context` / `project_note` MCP tools. Registered
 * unconditionally (not by membership — that would change the tools prefix and
 * may force an MCP reconnect); a session outside any project gets
 * `not in a project`. They execute in the owning session process, which stamps
 * its own session id as author (the agent cannot fill it). Same transports as
 * the peer tools: in-process for Claude/ACP, forwarded by name by the Codex
 * stdio bridge.
 */

export const PROJECT_TOOL_NAMES = ['project_context', 'project_note'] as const;
export type ProjectToolName = typeof PROJECT_TOOL_NAMES[number];

export const PROJECT_TOOL_SCHEMAS: Record<ProjectToolName, { title: string; description: string; readOnly: boolean; inputSchema: Record<string, z.ZodTypeAny> }> = {
    project_context: {
        title: 'Read Project Context',
        readOnly: true,
        description: 'Read this session\'s Very Happy project: instructions, decisions in effect, recent log entries, other sessions and unread messages. By default returns only what changed since you last read it (≤2KB); full=true returns everything. Returns "not in a project" when the session has no project.',
        inputSchema: {
            section: z.enum(['instructions', 'log', 'sessions', 'messages']).optional().describe('Only this part'),
            full: z.boolean().optional().describe('Everything, not just changes since your last read'),
        },
    },
    project_note: {
        title: 'Write Project Note',
        readOnly: false,
        description: 'Append to the project log what other sessions will need: kind "decision" (changes how they work), "finding" (they would otherwise redo it) or "handoff" (when you stop). Not progress. Takes effect immediately; the user can revoke it. To change an entry, write a new one with supersedes; revoke=true with supersedes withdraws your own entry.',
        inputSchema: {
            kind: z.enum(['decision', 'finding', 'handoff']).describe('decision | finding | handoff'),
            title: z.string().min(1).max(200).describe('One line'),
            body: z.string().max(4000).optional().describe('Details (≤4KB)'),
            supersedes: z.string().min(1).max(128).optional().describe('Entry it replaces: "#12" or its id'),
            revoke: z.boolean().optional().describe('With supersedes: withdraw that entry (only your own) instead of writing a new one'),
        },
    },
};

export type ProjectToolExecutor = (name: ProjectToolName, args: any) => Promise<{ text: string }>;

function describeError(error: unknown): string {
    if (error instanceof ProjectsUnsupportedError) return 'This Very Happy server does not support projects yet.';
    if (error instanceof ProjectRequestError) {
        if (error.code === 'project_note_quota_exceeded' && typeof error.details.suggestion === 'string') return error.details.suggestion;
        if (error.code === 'not_a_project_member') return 'not in a project';
        if (error.code) return `Project request failed: ${error.code}`;
        return 'Project request failed';
    }
    // Plain errors carry our own text (e.g. forwarded through the Codex bridge).
    return error instanceof Error && error.message ? error.message : 'Project request failed';
}

export function createProjectToolExecutor(sessionId: () => string, client: ProjectsClient = sharedProjectsClient()): ProjectToolExecutor {
    return async (name, args) => {
        const sid = sessionId();
        if (name === 'project_context') {
            const full = args?.full === true;
            const ctx = await client.context(sid, { full });
            return { text: formatContextForTool(ctx, { full, section: typeof args?.section === 'string' ? args.section : undefined }) };
        }
        const membership = await client.membership(sid);
        if (!membership.projectId) return { text: 'not in a project' };
        if (args?.revoke) {
            if (!args?.supersedes) throw new Error('revoke needs supersedes (the entry to withdraw)');
            const { entry } = await client.revoke(membership.projectId, String(args.supersedes), sid);
            return { text: `revoked #${entry.seq}` };
        }
        const { entry } = await client.note(membership.projectId, {
            kind: String(args?.kind), title: String(args?.title ?? ''), authorSessionId: sid,
            ...(typeof args?.body === 'string' && args.body ? { body: args.body } : {}),
            ...(typeof args?.supersedes === 'string' ? { supersedes: args.supersedes } : {}),
        });
        return { text: `recorded #${entry.seq}${entry.supersedes ? ' (supersedes an earlier entry)' : ''}` };
    };
}

export function registerProjectTools(server: AssistantToolRegistrar, execute: ProjectToolExecutor): void {
    for (const name of PROJECT_TOOL_NAMES) {
        const spec = PROJECT_TOOL_SCHEMAS[name];
        server.registerTool(name, {
            description: spec.description, title: spec.title, inputSchema: spec.inputSchema,
            annotations: { readOnlyHint: spec.readOnly, idempotentHint: spec.readOnly, openWorldHint: false, destructiveHint: false },
        }, async (args: any) => {
            try { return { content: [{ type: 'text' as const, text: (await execute(name, args ?? {})).text }], isError: false }; }
            catch (error) { return { content: [{ type: 'text' as const, text: describeError(error) }], isError: true }; }
        });
    }
}
