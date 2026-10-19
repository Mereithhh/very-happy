/**
 * B-636: keep only the listed accounts; everything hanging off the others goes.
 *
 * The schema declares `onDelete: Cascade` on only some relations, so a plain
 * `DELETE FROM "Account"` fails on the first restricted foreign key. Instead
 * the foreign-key graph is read from information_schema and walked depth-first
 * from "Account": children are deleted before their parents with nested
 * `IN (SELECT …)` predicates, so no row is ever orphaned and no constraint is
 * ever violated. Tables that only point AT accounts from the parent side
 * (GithubUser) are swept afterwards when nothing references them any more.
 *
 * Always run as a dry run first: the report lists every table and row count.
 */
import type { Prisma, PrismaClient } from '@prisma/client';

type Database = PrismaClient | Prisma.TransactionClient;

interface ForeignKey { constraint: string; child: string; childColumns: string[]; parent: string; parentColumns: string[] }

export interface PruneReport {
    keptAccounts: number;
    deletedAccounts: number;
    /** table → rows deleted (or that would be), in deletion order. */
    rows: Array<{ table: string; count: number }>;
}

export async function loadForeignKeys(client: Database): Promise<ForeignKey[]> {
    const rows = await client.$queryRawUnsafe<Array<{ constraint: string; child: string; child_column: string; parent: string; parent_column: string; position: number }>>(`
        SELECT tc.constraint_name AS "constraint", tc.table_name AS "child", kcu.column_name AS "child_column",
               ccu.table_name AS "parent", ccu.column_name AS "parent_column", kcu.ordinal_position AS "position"
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
        ORDER BY tc.constraint_name, kcu.ordinal_position`);
    const byConstraint = new Map<string, ForeignKey>();
    for (const row of rows) {
        const fk = byConstraint.get(row.constraint) ?? { constraint: row.constraint, child: row.child, childColumns: [], parent: row.parent, parentColumns: [] };
        if (!fk.childColumns.includes(row.child_column)) fk.childColumns.push(row.child_column);
        if (!fk.parentColumns.includes(row.parent_column)) fk.parentColumns.push(row.parent_column);
        byConstraint.set(row.constraint, fk);
    }
    return [...byConstraint.values()];
}

const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;
const tuple = (columns: string[]) => columns.length === 1 ? q(columns[0]) : `(${columns.map(q).join(', ')})`;

/** Deletion plan: (table, predicate) pairs, children before parents; the predicate of each step nests its parent's. */
export function planDeletion(foreignKeys: ForeignKey[], root: string, rootPredicate: string): Array<{ table: string; predicate: string }> {
    const steps: Array<{ table: string; predicate: string }> = [];
    const visit = (table: string, predicate: string, path: string[]) => {
        for (const fk of foreignKeys) {
            if (fk.parent !== table) continue;
            if (fk.child === table) throw new Error(`self-referencing foreign key ${fk.constraint} on ${table} is not supported`);
            if (path.includes(fk.child)) continue; // cycle: the other path already covers it
            const childPredicate = `${tuple(fk.childColumns)} IN (SELECT ${fk.parentColumns.map(q).join(', ')} FROM ${q(fk.parent)} WHERE ${predicate})`;
            visit(fk.child, childPredicate, [...path, fk.child]);
        }
        steps.push({ table, predicate });
    };
    visit(root, rootPredicate, [root]);
    return steps;
}

export async function pruneAccounts(client: Database, options: { keep: string[]; apply: boolean }): Promise<PruneReport> {
    const keep = [...new Set(options.keep.map((id) => id.trim()).filter(Boolean))];
    if (keep.length === 0) throw new Error('refusing to prune every account: the keep list is empty');
    const present = await client.$queryRawUnsafe<Array<{ id: string }>>(`SELECT "id" FROM "Account" WHERE "id" = ANY($1::text[])`, keep);
    const missing = keep.filter((id) => !present.some((row) => row.id === id));
    if (missing.length > 0) throw new Error(`keep list names accounts that do not exist: ${missing.join(', ')}`);

    const rootPredicate = `"id" <> ALL(ARRAY[${keep.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')}]::text[])`;
    const steps = planDeletion(await loadForeignKeys(client), 'Account', rootPredicate);
    // GithubUser sits on the PARENT side of Account: decide now which rows only doomed accounts point at.
    const doomedGithub = (await client.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "GithubUser"
         WHERE "id" IN (SELECT "githubUserId" FROM "Account" WHERE ${rootPredicate})
           AND "id" NOT IN (SELECT "githubUserId" FROM "Account" WHERE NOT (${rootPredicate}) AND "githubUserId" IS NOT NULL)`,
    )).map((row) => row.id);
    const report: PruneReport = { keptAccounts: keep.length, deletedAccounts: 0, rows: [] };
    for (const step of steps) {
        let count: number;
        if (options.apply) {
            count = await client.$executeRawUnsafe(`DELETE FROM ${q(step.table)} WHERE ${step.predicate}`);
        } else {
            count = Number((await client.$queryRawUnsafe<Array<{ count: unknown }>>(`SELECT COUNT(*) AS "count" FROM ${q(step.table)} WHERE ${step.predicate}`))[0]?.count ?? 0);
        }
        if (count > 0 || step.table === 'Account') report.rows.push({ table: step.table, count });
        if (step.table === 'Account') report.deletedAccounts = count;
    }
    if (doomedGithub.length > 0) {
        if (options.apply) await client.$executeRawUnsafe(`DELETE FROM "GithubUser" WHERE "id" = ANY($1::text[])`, doomedGithub);
        report.rows.push({ table: 'GithubUser', count: doomedGithub.length });
    }
    return report;
}
