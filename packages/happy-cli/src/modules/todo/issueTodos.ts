import { isIssueClosed, ISSUE_LIMITS, ISSUE_STATUSES, type BuiltinTodoList, type BuiltinTodoRecord, type IssueView } from '@slopus/happy-wire';
import { IssueRequestError, type IssuesClient } from '@/issues/client';

/**
 * B-874 (spec §8): `very-happy todo` as an alias layer over Issues. A todo is
 * an issue with no assignee; output keeps the KV record shape (plus `key`) so
 * scripts and the official skill keep working: list = unassigned and open
 * (`--all` adds closed), add = an unassigned `todo` issue (Q10), complete =
 * done, reopen = todo, edit = PATCH with `ifVersion`, delete = soft delete.
 * The caller falls back to the KV client when the server has no Issues.
 */

export type TodoAliasRecord = BuiltinTodoRecord & { key: string };

export function issueToTodoRecord(issue: IssueView): TodoAliasRecord {
    return {
        schemaVersion: 1, id: issue.id, key: issue.key, title: issue.title, note: issue.description,
        status: isIssueClosed(issue.status) ? 'done' : 'open', order: issue.sortOrder,
        createdAt: issue.createdAt, updatedAt: issue.updatedAt, version: issue.version,
    };
}

const OPEN = ISSUE_STATUSES.filter(s => !isIssueClosed(s)).join(',');
const CONFLICT = 'Todo version conflict; read the latest task before deciding what to change.';

export type TodoAliasCommand = { action: 'list' | 'get' | 'add' | 'edit' | 'complete' | 'reopen' | 'delete'; id?: string; version?: number; title?: string; note?: string; all?: boolean };

async function find(client: IssuesClient, ref: string): Promise<IssueView | null> {
    try { return (await client.get(ref)).issue; }
    catch (error) {
        if (!(error instanceof IssueRequestError && error.code === 'issue_not_found')) throw error;
    }
    // An id from before the import (`vh.todo.v1.<id>`) still resolves through `legacyTodoId`.
    const { issues } = await client.list({ assigneeKind: 'none', limit: ISSUE_LIMITS.listMax });
    return issues.find(issue => issue.legacyTodoId === ref) ?? null;
}

export async function runTodoViaIssues(command: TodoAliasCommand, client: IssuesClient): Promise<unknown> {
    if (command.action === 'list') {
        const { issues, nextCursor } = await client.list({ assigneeKind: 'none', ...(command.all ? {} : { status: OPEN }), limit: ISSUE_LIMITS.listMax });
        const records = issues.map(issueToTodoRecord).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
        const list: BuiltinTodoList = { records, truncated: nextCursor !== null, invalidCount: 0 };
        return list;
    }
    if (command.action === 'add') {
        if (command.title!.trim().length > ISSUE_LIMITS.titleChars) throw new Error(`Todo title must contain 1–${ISSUE_LIMITS.titleChars} characters on this server`);
        const { issue } = await client.create({ title: command.title!.trim(), description: command.note ?? '', status: 'todo', assignee: { kind: 'none' }, requestId: command.id! });
        return issueToTodoRecord(issue);
    }
    const issue = await find(client, command.id!);
    // A soft-deleted issue is a deleted todo (KV tombstone semantics): get answers null.
    if (command.action === 'get') return issue && !issue.deletedAt ? issueToTodoRecord(issue) : null;
    if (!issue || issue.deletedAt) throw new Error('Todo not found; it may have been deleted.');
    if (issue.version !== command.version) throw new Error(CONFLICT);
    try {
        if (command.action === 'delete') { await client.remove(issue.id); return { id: issue.id, deleted: true }; }
        const patch = command.action === 'edit'
            ? { ...(command.title !== undefined ? { title: command.title.trim() } : {}), ...(command.note !== undefined ? { description: command.note } : {}) }
            : { status: command.action === 'complete' ? 'done' as const : 'todo' as const };
        return issueToTodoRecord((await client.update(issue.id, { ...patch, ifVersion: issue.version })).issue);
    } catch (error) {
        if (error instanceof IssueRequestError && error.code === 'issue_version_conflict') throw new Error(CONFLICT);
        throw error;
    }
}
