import type { IssueCommentView, IssueView } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { prependToMessage } from '@/projects/prompt';
import { IssuesUnsupportedError, sharedIssuesClient, type IssuesClient } from './client';

/**
 * B-874 next-turn issue digest (spec §5, third layer). Before a turn that is
 * already going to run (the owner typed into the session), an issue session
 * gets ≤1 line when the owner changed the issue's status / assignee / fields
 * since the last turn: `[Issue VH-12 now todo (in_review → todo by owner); description updated]`.
 * Comments are not digested: a routed comment arrives as its own message.
 *
 * Never starts a turn; every failure (old server, timeout, unbound yet) sends
 * the message unchanged. The first turn only sets the cursor: that turn is the
 * issue prompt itself.
 */

export function buildIssueDigestLine(issue: Pick<IssueView, 'key' | 'status'>, entries: readonly IssueCommentView[]): string | null {
    const human = entries.filter(e => e.author.kind === 'user' && !e.deletedAt);
    const statuses = human.filter(e => e.kind === 'status');
    const parts: string[] = [];
    if (statuses.length) {
        const from = (statuses[0].data as { from?: unknown } | null)?.from;
        parts.push(`now ${issue.status}${typeof from === 'string' ? ` (${from} → ${issue.status} by owner)` : ' (changed by owner)'}`);
    }
    if (human.some(e => e.kind === 'assign')) parts.push('assignee changed');
    const fields = new Set<string>();
    for (const e of human) if (e.kind === 'field') for (const f of ((e.data as { fields?: unknown } | null)?.fields as unknown[] | undefined) ?? []) if (typeof f === 'string') fields.add(f);
    if (fields.size) parts.push(`${[...fields].join(', ')} updated`);
    if (!parts.length) return null;
    return `[Issue ${issue.key} ${parts.join('; ')}]`;
}

export type IssueDigestDeps = {
    sessionId: () => string | null | undefined;
    /** Only sessions the issue worker started carry VH_ISSUE_ID; others never call the server. */
    enabled?: () => boolean;
    client?: IssuesClient;
    timeoutMs?: number;
};

export function createIssueDigest(deps: IssueDigestDeps) {
    const client = deps.client ?? sharedIssuesClient();
    const enabled = deps.enabled ?? (() => !!process.env.VH_ISSUE_ID);
    const timeoutMs = deps.timeoutMs ?? 1500;
    let cursor: number | null = null;
    return {
        cursor: () => cursor,
        async decorate(message: string): Promise<string> {
            const sid = deps.sessionId();
            if (!sid || !enabled() || client.isDisabled()) return message;
            try {
                if (cursor === null) {
                    const ctx = await client.session(sid, undefined, timeoutMs);
                    // Not bound yet (the daemon completes the dispatch after this first message): try next turn.
                    if (ctx.issue) cursor = ctx.asOf;
                    return message;
                }
                const ctx = await client.session(sid, cursor, timeoutMs);
                if (!ctx.issue) return message;
                cursor = ctx.asOf;
                return prependToMessage(message, buildIssueDigestLine(ctx.issue, ctx.comments));
            } catch (error) {
                if (!(error instanceof IssuesUnsupportedError)) logger.debug(`[issues] digest skipped: ${String(error)}`);
                return message;
            }
        },
    };
}
export type IssueDigest = ReturnType<typeof createIssueDigest>;
