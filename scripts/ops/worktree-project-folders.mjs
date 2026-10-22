#!/usr/bin/env node
/**
 * worktree-project-folders — B-755 read-only inventory of projects whose folder
 * is a team member's throwaway worktree (`<happy home>/teams/worktrees/<op id>`).
 * Such a folder makes every unrelated session working in that worktree get
 * 「这个会话在『…』项目的目录下，加入项目？」. Prints one line per bad folder with
 * the repository it resolves to (following worktrees cut from worktrees), so
 * the owner can repair it from the project page (「改成仓库 …」). Never writes.
 *
 *   node scripts/ops/worktree-project-folders.mjs [--host vh-sg] [--container vh-pgbouncer] [--server <container>] [--json]
 *   node scripts/ops/worktree-project-folders.mjs --print-sql
 *
 * Same connection path as resource-budget.mjs (docs/operations.md): psql inside
 * the PgBouncer container, the server container's DATABASE_URL piped on stdin
 * (never in argv or output), every statement inside BEGIN READ ONLY … COMMIT.
 * Account ids are shortened to 8 characters.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const host = arg('--host', 'vh-sg');
const container = arg('--container', 'vh-pgbouncer');
const sql = readFileSync(new URL('./worktree-project-folders.sql', import.meta.url), 'utf8');
if (args.includes('--print-sql')) { process.stdout.write(sql); process.exit(0); }

function ssh(command, input = '') {
    try {
        return execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, command], { input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    } catch (error) {
        console.error(`worktree-project-folders: ssh ${host} failed: ${error.stderr?.toString().trim() || error.message}`);
        process.exit(2);
    }
}
const server = arg('--server', null) ?? ssh('docker ps --format "{{.Names}}"').split('\n').map(n => n.trim()).find(n => /^happy-server-/.test(n) || n === 'happy-server');
if (!server) { console.error('worktree-project-folders: no happy-server container is running; pass --server'); process.exit(2); }
const psql = query => ssh(
    `{ docker exec ${server} printenv DATABASE_URL; cat; } | docker exec -i ${container} sh -c 'read -r U; exec psql "\${U%%\\?*}" -X -q -t -A -F"|" -v ON_ERROR_STOP=1 -f -'`,
    `BEGIN READ ONLY;\n${query.trim().replace(/;?\s*$/, ';')}\nCOMMIT;\n`,
).split('\n').map(l => l.trim()).filter(l => l && l !== 'BEGIN' && l !== 'COMMIT').map(l => l.split('|'));

const worktreeId = path => path?.replace(/\\/g, '/').match(/\/teams\/worktrees\/([^/]+)(?:\/|$)/)?.[1] ?? null;
const literal = value => `'${String(value).replace(/'/g, "''")}'`;
const rows = psql(sql).map(([projectId, name, accountId, archived, machineId, path, primary, operationId, source]) => ({ projectId, name, accountId, archived: archived === 't', machineId, path, primary: primary === 't', operationId, source: source || null }));
for (const row of rows) {
    // Follow a source that is itself a worktree (a team launched from another team's worktree), at most 8 hops.
    let repository = row.source;
    for (let hop = 0; repository && worktreeId(repository) && hop < 8; hop++) {
        const [next] = psql(`SELECT o."state"->>'directory' FROM "TeamOperation" o JOIN "AgentTeam" t ON t."id" = o."teamId" WHERE o."id" = ${literal(worktreeId(repository))} AND t."accountId" = ${literal(row.accountId)} AND o."state"->>'type' = 'spawn'`);
        repository = next?.[0] || null;
    }
    row.repository = repository && !worktreeId(repository) ? repository : null;
    row.accountId = row.accountId.slice(0, 8);
}
if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
else if (rows.length === 0) console.log('No project folder is a team worktree.');
else for (const r of rows) console.log(`${r.projectId}  ${r.name}${r.archived ? ' (archived)' : ''}  account ${r.accountId}  ${r.path}${r.primary ? ' [primary]' : ''}  →  ${r.repository ?? 'repository unknown (remove the folder, add the repository path)'}`);
