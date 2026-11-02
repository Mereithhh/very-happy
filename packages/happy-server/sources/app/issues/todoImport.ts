import { randomUUID } from 'node:crypto';
import {
    BUILTIN_TODO_PREFIX, ISSUE_LIMITS, issueFromLegacyTodo, legacyTodoReimportAction, parseBuiltinTodo, sortBuiltinTodos,
    type BuiltinTodo, type IssueTodoImportResult,
} from '@slopus/happy-wire';
import { db } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { emitComment, emitIssue, runIssueTx, assertIssuesEnabled } from './store';

/**
 * B-872 lazy Todos import (`specs/2026-11-issues.md` §8). Reads the
 * account's `vh.todo.v1.*` KV records (never writes or deletes them),
 * validates each with `parseBuiltinTodo` (invalid ones are counted and left
 * alone) and upserts one issue per todo keyed by `(accountId, legacyTodoId)`.
 * Re-runnable: an unchanged KV version is skipped; a newer one overwrites an
 * issue nobody touched since its import, otherwise the issue wins and a system
 * comment keeps the KV text (conflict). Small chunks keep each SERIALIZABLE
 * transaction short; a concurrent import racing on the unique key retries the
 * chunk and then skips what the other one created.
 *
 * `updatedAt` is the import time (not the todo's) so clients syncing by
 * `updatedSince` see imported issues; the todo's own time is kept in
 * `createdAt` / `statusChangedAt` / `completedAt`.
 */

const KV_READ_LIMIT = 1000;
const CHUNK = 50;

function decodeKv(key: string, value: Uint8Array): BuiltinTodo | null {
    try {
        return parseBuiltinTodo(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)), key);
    } catch { return null; }
}

export async function importLegacyTodos(accountId: string): Promise<IssueTodoImportResult> {
    assertIssuesEnabled();
    const rows = await db.userKVStore.findMany({
        where: { accountId, key: { startsWith: BUILTIN_TODO_PREFIX }, value: { not: null } },
        orderBy: { key: 'asc' }, take: KV_READ_LIMIT, select: { key: true, value: true, version: true },
    });
    const result: IssueTodoImportResult = { imported: 0, updated: 0, skipped: 0, conflicts: 0, invalid: 0 };
    const valid: { todo: BuiltinTodo; version: number }[] = [];
    for (const row of rows) {
        const todo = row.value ? decodeKv(row.key, row.value) : null;
        if (todo) valid.push({ todo, version: row.version });
        else result.invalid++;
    }
    const versions = new Map(valid.map(v => [v.todo.id, v.version]));
    const ordered = sortBuiltinTodos(valid.map(v => v.todo)).sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i < ordered.length; i += CHUNK) {
        const chunk = ordered.slice(i, i + CHUNK);
        const counts = await runIssueTx(tx => importChunk(tx, accountId, chunk, versions));
        result.imported += counts.imported; result.updated += counts.updated; result.skipped += counts.skipped; result.conflicts += counts.conflicts;
    }
    return result;
}

async function importChunk(tx: Tx, accountId: string, todos: BuiltinTodo[], versions: Map<string, number>): Promise<Omit<IssueTodoImportResult, 'invalid'>> {
    const out = { imported: 0, updated: 0, skipped: 0, conflicts: 0 };
    const existing = new Map((await tx.issue.findMany({ where: { accountId, legacyTodoId: { in: todos.map(t => t.id) } } })).map(r => [r.legacyTodoId!, r]));
    let live = await tx.issue.count({ where: { accountId, deletedAt: null } });
    for (const todo of todos) {
        const version = versions.get(todo.id)!;
        const fields = issueFromLegacyTodo(todo, version);
        const now = new Date();
        const prior = existing.get(todo.id);
        if (!prior) {
            if (live >= ISSUE_LIMITS.issuesPerAccount) { out.skipped++; continue; }
            const seq = await tx.issueSequence.upsert({ where: { accountId }, create: { accountId, last: 1 }, update: { last: { increment: 1 } } });
            const row = await tx.issue.create({ data: {
                id: randomUUID(), accountId, number: seq.last, title: fields.title, description: fields.description, status: fields.status,
                assigneeKind: 'none', assignee: { kind: 'none' }, sortOrder: fields.sortOrder, createdBy: { kind: 'import' },
                legacyTodoId: fields.legacyTodoId, legacyTodoVersion: version, importedAt: now,
                createdAt: new Date(fields.createdAt), updatedAt: now, statusChangedAt: new Date(fields.updatedAt),
                completedAt: fields.completedAt ? new Date(fields.completedAt) : null,
            } });
            emitIssue(tx, row);
            live++;
            out.imported++;
            continue;
        }
        const action = legacyTodoReimportAction({
            kvVersion: version, importedVersion: prior.legacyTodoVersion ?? 0,
            issueChangedSinceImport: !prior.importedAt || prior.updatedAt.getTime() > prior.importedAt.getTime() || !!prior.deletedAt,
        });
        if (action === 'skip') { out.skipped++; continue; }
        if (action === 'update') {
            const row = await tx.issue.update({ where: { id: prior.id }, data: {
                title: fields.title, description: fields.description, sortOrder: fields.sortOrder, legacyTodoVersion: version, importedAt: now, updatedAt: now,
                ...(fields.status !== prior.status ? { status: fields.status, statusChangedAt: new Date(fields.updatedAt), statusRunId: null, completedAt: fields.completedAt ? new Date(fields.completedAt) : null } : {}),
                version: { increment: 1 },
            } });
            emitIssue(tx, row);
            out.updated++;
            continue;
        }
        // Both sides changed: the issue wins; the KV text is kept as a system entry, and this KV version counts as seen.
        const comment = await tx.issueComment.create({ data: {
            id: randomUUID(), issueId: prior.id, accountId, kind: 'field', authorKind: 'import',
            body: [`Legacy todo changed after import (${todo.status}):`, todo.title, todo.note].filter(Boolean).join('\n'),
            data: { legacyTodoVersion: version, conflict: true },
        } });
        emitComment(tx, comment);
        // Not a visible change (legacyTodoVersion is not in the view): no version bump, `updatedAt` kept so the issue still counts as edited.
        await tx.issue.update({ where: { id: prior.id }, data: { legacyTodoVersion: version } });
        out.conflicts++;
    }
    return out;
}
