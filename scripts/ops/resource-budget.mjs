#!/usr/bin/env node
/**
 * resource-budget —— 这台机器的配额到底还剩多少，以及谁会先撞墙。
 *
 * 为什么需要它：**配额是按账号的，磁盘是按机器的，而这两个数从来没有人放在
 * 一起看过。** 2026-09-03 一天之内撞了两次墙，两次都是事后才知道：
 *   - `MAX_SESSIONS_PER_ACCOUNT` 撞了 500 → 有人把它改成 100000 → 没留下理由；
 *   - `session_state` 写速率桶把整个账号锁了一小时（B-307），而稳态用量只有
 *     上限的 0.7%。
 * 两次的共同点不是数字选错了，是**没有任何东西会在撞墙前吭一声**。
 *
 * 这个脚本只读，回答三个问题：
 *   1. 每个账号用掉了各项配额的百分之几；
 *   2. 单调增长的那些（消息数/字节）按最近 14 天的速度，还有多少天撞墙；
 *   3. **超售比**：`SIGNUP_MAX_ACCOUNTS × 每账号字节额度` 对上磁盘剩余空间。
 *      注册是开放的，所以这一项才是真正的风险面。
 *
 * 上限从两个事实源读，不在这里抄第二份：代码里的 fallback 直接从
 * `configuredResourceLimit('NAME', <expr>)` 解析，生产覆盖值从运行中的容器
 * 环境变量读。改了代码或改了 env，这里跟着变。
 *
 * 数据库怎么连（B-661，2026-10-21 起与生产现状一致）：生产库是 RDS `vh-pg`，
 * 只能经 vh-sg 上的 PgBouncer（`vh-pgbouncer`，库别名 `happy`）到达。脚本在
 * `--container`（默认 vh-pgbouncer，它自带 psql）里跑 psql，连接串取自运行中
 * server 容器的 `DATABASE_URL`，**经 stdin 传入**（不进任何进程参数、不落盘、
 * 不打印）；所有 SQL 包在 `BEGIN READ ONLY … COMMIT` 里。数据库容量从 RDS 读
 * （本机 `aws`：AllocatedStorage + CloudWatch FreeStorageSpace），超售比对的是
 * 数据库剩余空间；`--rds none` 时退回主机磁盘（自建、库在本机的部署）。主机
 * 磁盘照常报告——镜像吃掉的是它。旧默认 `--host vh-us` + 容器 happy-postgres
 * 已失效：vh-us 2026-09-07 起停服并已退役（docs/operations.md）。
 *
 * 用法：
 *   node scripts/ops/resource-budget.mjs                 # 默认 vh-sg + RDS vh-pg
 *   node scripts/ops/resource-budget.mjs --host vh-sg --top 8
 *   node scripts/ops/resource-budget.mjs --rds none      # 库在主机本地：超售比对主机磁盘
 *   node scripts/ops/resource-budget.mjs --warn 70       # 超过 70% 就非零退出
 *   node scripts/ops/resource-budget.mjs --days 45       # 45 天内会撞墙就非零退出
 *
 * 退出码：0 = 都在阈值内；1 = 有账号越过 --warn，或预计 --days 天内撞墙；
 *          2 = 用法/连接错误。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve(import.meta.dirname, '../..');

function fail(message) {
    console.error(`resource-budget: ${message}`);
    process.exit(2);
}

export function parseArgs(argv) {
    const opts = { host: 'vh-sg', container: 'vh-pgbouncer', server: null, rds: 'vh-pg', region: 'ap-southeast-1', top: 5, warn: 80, days: 30 };
    for (let i = 0; i < argv.length; i += 1) {
        const next = () => {
            const value = argv[i + 1];
            if (value === undefined) fail(`${argv[i]} needs a value`);
            i += 1;
            return value;
        };
        switch (argv[i]) {
            case '--host': opts.host = next(); break;
            case '--container': opts.container = next(); break;
            case '--server': opts.server = next(); break;
            case '--rds': opts.rds = next(); break;
            case '--region': opts.region = next(); break;
            case '--top': opts.top = Number.parseInt(next(), 10); break;
            case '--warn': opts.warn = Number.parseFloat(next()); break;
            case '--days': opts.days = Number.parseInt(next(), 10); break;
            case '--help': case '-h':
                console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0]);
                process.exit(0);
                break;
            default: fail(`unknown option ${argv[i]}`);
        }
    }
    return opts;
}

function ssh(host, command, input) {
    try {
        return execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, command], {
            input: input ?? '',
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
        });
    } catch (error) {
        fail(`ssh ${host} failed: ${error.stderr?.toString().trim() || error.message}`);
    }
}

/**
 * SQL goes in on stdin — nested shell quoting is how these scripts rot. The
 * first stdin line on the host is the server's own `DATABASE_URL` (piped from
 * `printenv`, so the credential never appears in argv, a log or this process);
 * the psql container reads it with `read` and psql takes the rest as the
 * script. Prisma's query parameters (`connection_limit`, `pgbouncer`, …) are
 * not libpq options, so the query string is cut off. Read-only by construction.
 */
export function psqlRemoteCommand(container, server) {
    return `{ docker exec ${server} printenv DATABASE_URL; cat; } | docker exec -i ${container} sh -c `
        + `'read -r U; exec psql "\${U%%\\?*}" -X -q -t -A -F"|" -v ON_ERROR_STOP=1 -f -'`;
}

export function readOnlySql(sql) {
    return `BEGIN READ ONLY;\n${sql.trim().replace(/;?\s*$/, ';')}\nCOMMIT;\n`;
}

function psql(opts, sql) {
    return ssh(opts.host, psqlRemoteCommand(opts.container, opts.serverContainer), readOnlySql(sql))
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split('|'));
}

/** The running server container, so env overrides come from what is actually live. */
function resolveServerContainer(opts) {
    if (opts.server) return opts.server;
    const names = ssh(opts.host, 'docker ps --format "{{.Names}}"').split('\n').map((n) => n.trim());
    const found = names.find((name) => /^happy-server-/.test(name)) ?? names.find((name) => name === 'happy-server');
    if (!found) fail('no happy-server container is running; pass --server');
    return found;
}

/**
 * Code fallbacks, parsed out of the server sources rather than copied here —
 * a second copy of these numbers would drift and quietly lie.
 *
 * Two call shapes exist. Most are `configuredResourceLimit('NAME', <literal>)`.
 * The state-bytes pair picks BOTH name and fallback with a ternary, so names
 * and literals are paired positionally there. Anything else is reported as
 * unresolved and shows as `unset` — never silently dropped, because an omitted
 * limit makes the entitlement total look SMALLER than it is, i.e. the risk
 * look smaller. (The first version of this script did exactly that: it lost
 * session_state's 256M and under-reported oversubscription by a quarter.)
 */
function readCodeFallbacks() {
    const root = join(repoRoot, 'packages/happy-server/sources');
    const fallbacks = new Map();
    const unresolved = new Set();
    const mentioned = new Set();

    const callText = (source, from) => {
        let depth = 0;
        for (let i = from; i < source.length; i += 1) {
            if (source[i] === '(') depth += 1;
            else if (source[i] === ')') {
                depth -= 1;
                if (depth === 0) return source.slice(from, i + 1);
            }
        }
        return null;
    };

    const walk = (dir) => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) { walk(path); continue; }
            if (!entry.endsWith('.ts') || entry.includes('.spec.') || entry.includes('.test.')) continue;
            const source = readFileSync(path, 'utf8');
            for (const name of source.match(/\b(MAX|SIGNUP|HTTP)_[A-Z0-9_]+\b/g) ?? []) mentioned.add(name);
            let at = source.indexOf('configuredResourceLimit(');
            while (at !== -1) {
                const text = callText(source, source.indexOf('(', at));
                if (text) {
                    const names = [...text.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);
                    const numbers = [...text.matchAll(/(?<![\w'])(\d[\d_]*(?:\s*\*\s*\d[\d_]*)*)(?![\w'])/g)]
                        .map((m) => Number(new Function(`return ${m[1].replaceAll('_', '')}`)()));
                    if (names.length > 0 && names.length === numbers.length) {
                        names.forEach((name, index) => fallbacks.set(name, numbers[index]));
                    } else {
                        names.forEach((name) => unresolved.add(name));
                        // The one legitimate non-literal call is the generic
                        // helper's own `options.envName`; every other unnamed
                        // call is a real gap and must be visible.
                        if (names.length === 0 && entry !== 'resourceLimits.ts') {
                            unresolved.add(`<non-literal name in ${entry}>`);
                        }
                    }
                }
                at = source.indexOf('configuredResourceLimit(', at + 1);
            }
        }
    };
    walk(root);

    // envName/fallback pairs reach configuredResourceLimit through a variable,
    // so the write-rate buckets have to be picked up from their call sites.
    const rateSource = readFileSync(join(root, 'app/state/accountStateStore.ts'), 'utf8')
        + readFileSync(join(root, 'app/api/sessionMessageStore.ts'), 'utf8');
    for (const match of rateSource.matchAll(/envName:\s*'([A-Z0-9_]+)',\s*\n\s*fallback:\s*([\d_]+)/g)) {
        fallbacks.set(match[1], Number(match[2].replaceAll('_', '')));
    }

    // Coverage check: any per-account limit the sources mention but we could
    // not resolve is called out by name.
    for (const name of mentioned) {
        if (/_PER_ACCOUNT$/.test(name) && !fallbacks.has(name)) unresolved.add(name);
    }
    return { fallbacks, unresolved: [...unresolved].sort() };
}

function bytes(n) {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}G`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}M`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)}K`;
    return `${n}`;
}

function pad(value, width, left = false) {
    const text = String(value);
    return left ? text.padStart(width) : text.padEnd(width);
}

function table(rows) {
    if (rows.length === 0) return;
    const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column]).length)));
    for (const [index, row] of rows.entries()) {
        console.log('  ' + row.map((cell, column) => pad(cell, widths[column], column > 1)).join('  '));
        if (index === 0) console.log('  ' + widths.map((width) => '─'.repeat(width)).join('  '));
    }
}

/**
 * Database capacity when it lives on RDS: allocated storage and the latest
 * CloudWatch FreeStorageSpace, read with the operator's local `aws` (vh-sg
 * itself has no AWS CLI). Read-only API calls. `null` = not available — the
 * report then says so instead of comparing against the wrong disk.
 */
function rdsCapacity(opts) {
    if (!opts.rds || opts.rds === 'none') return null;
    const aws = (args) => execFileSync('aws', [...args, '--region', opts.region, '--output', 'json'], { encoding: 'utf8', timeout: 30_000 });
    try {
        const inst = JSON.parse(aws(['rds', 'describe-db-instances', '--db-instance-identifier', opts.rds])).DBInstances?.[0];
        const allocated = Number(inst?.AllocatedStorage) * 1024 ** 3;
        const end = new Date();
        const start = new Date(end.getTime() - 60 * 60 * 1000);
        const stats = JSON.parse(aws(['cloudwatch', 'get-metric-statistics', '--namespace', 'AWS/RDS', '--metric-name', 'FreeStorageSpace',
            '--dimensions', `Name=DBInstanceIdentifier,Value=${opts.rds}`, '--start-time', start.toISOString(), '--end-time', end.toISOString(),
            '--period', '300', '--statistics', 'Minimum']));
        const latest = (stats.Datapoints ?? []).sort((a, b) => Date.parse(b.Timestamp) - Date.parse(a.Timestamp))[0];
        return { allocated, free: latest ? Number(latest.Minimum) : undefined, maxAllocated: inst?.MaxAllocatedStorage ? Number(inst.MaxAllocatedStorage) * 1024 ** 3 : undefined };
    } catch (error) {
        return { error: error.stderr?.toString().trim().split('\n')[0] || error.message };
    }
}

function main() {
const opts = parseArgs(process.argv.slice(2));
const serverContainer = resolveServerContainer(opts);
opts.serverContainer = serverContainer;
const { fallbacks, unresolved } = readCodeFallbacks();

const envLines = ssh(opts.host, `docker exec ${serverContainer} env`).split('\n');
const env = new Map();
for (const line of envLines) {
    const cut = line.indexOf('=');
    if (cut > 0 && /^(MAX_|SIGNUP_)/.test(line)) env.set(line.slice(0, cut), line.slice(cut + 1));
}

const limitOf = (name) => {
    const override = env.get(name);
    const value = override !== undefined && override !== '' ? Number.parseInt(override, 10) : fallbacks.get(name);
    return { value: Number.isFinite(value) ? value : undefined, source: override !== undefined ? 'env' : 'code' };
};

// ── usage ────────────────────────────────────────────────────────────────────
const [[accounts, withMessages, sessionCount, machineCount]] = psql(opts, `
SELECT (SELECT count(*) FROM "Account"),
       (SELECT count(*) FROM "Account" WHERE "messageCount" > 0),
       (SELECT count(*) FROM "Session"),
       (SELECT count(*) FROM "Machine");
`);

const perAccount = psql(opts, `
SELECT a.id,
       a."messageCount",
       a."messageBytes",
       coalesce(s.sessions, 0),
       coalesce(s.state_bytes, 0),
       coalesce(m.machines, 0)
FROM "Account" a
LEFT JOIN (SELECT "accountId", count(*) sessions,
                  sum(octet_length(metadata) + coalesce(octet_length("agentState"), 0)) state_bytes
           FROM "Session" GROUP BY "accountId") s ON s."accountId" = a.id
LEFT JOIN (SELECT "accountId", count(*) machines FROM "Machine" GROUP BY "accountId") m ON m."accountId" = a.id
ORDER BY a."messageCount" DESC
LIMIT ${Math.max(1, opts.top)};
`).map(([id, messages, messageBytes, sessions, stateBytes, machines]) => ({
    id, messages: +messages, messageBytes: +messageBytes,
    sessions: +sessions, stateBytes: +stateBytes, machines: +machines,
}));

const growth = new Map(psql(opts, `
SELECT s."accountId", count(*) / 14.0
FROM "SessionMessage" msg JOIN "Session" s ON s.id = msg."sessionId"
WHERE msg."createdAt" > now() - interval '14 days'
GROUP BY s."accountId";
`).map(([id, perDay]) => [id, Number(perDay)]));

const [[dbSize]] = psql(opts, 'SELECT pg_database_size(current_database());');
const disk = ssh(opts.host, "df -B1 --output=size,used,avail / | tail -1").trim().split(/\s+/).map(Number);
const rds = rdsCapacity(opts);

/**
 * Where the disk ACTUALLY goes. Account quotas were the obvious suspect and
 * were wrong by two orders of magnitude: on 2026-09-03 the database was 201MB
 * while docker images were 22.9GB, 15.7GB of it reclaimable — every blue-green
 * deploy leaves another ~2.2GB image behind, and we ship several times a day.
 * Any budget report that omits this is measuring the wrong thing.
 */
function dockerFootprint(host) {
    const rows = ssh(host, 'docker system df --format "{{.Type}}|{{.TotalCount}}|{{.Active}}|{{.Size}}|{{.Reclaimable}}"')
        .split('\n').map((line) => line.trim()).filter(Boolean).map((line) => line.split('|'));
    return rows.map(([type, total, active, size, reclaimable]) => ({ type, total, active, size, reclaimable }));
}
const docker = dockerFootprint(opts.host);

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\nhost ${opts.host} · server ${serverContainer}`);
console.log(`accounts ${accounts} (${withMessages} with messages) · sessions ${sessionCount} · machines ${machineCount}`);
console.log(`database ${bytes(+dbSize)}${rds && !rds.error ? ` on RDS ${opts.rds} · ${bytes(rds.allocated)} allocated${rds.free !== undefined ? `, ${bytes(rds.free)} free` : ''}${rds.maxAllocated ? ` (autoscale to ${bytes(rds.maxAllocated)})` : ''}` : ''}`);
if (rds?.error) console.log(`  RDS ${opts.rds}: capacity unavailable (${rds.error}) — oversubscription below falls back to the host disk`);
console.log(`host disk ${bytes(disk[1])} used of ${bytes(disk[0])}, ${bytes(disk[2])} free`);
for (const row of docker) {
    if (row.type !== 'Images' && row.type !== 'Local Volumes') continue;
    console.log(`docker ${row.type.toLowerCase().padEnd(13)} ${row.size} in ${row.total} (${row.active} active) · ${row.reclaimable} reclaimable`);
}
console.log('');

const limits = [
    ['MAX_MESSAGES_PER_ACCOUNT', 'messages', (row) => row.messages, false],
    ['MAX_MESSAGE_BYTES_PER_ACCOUNT', 'message bytes', (row) => row.messageBytes, true],
    ['MAX_SESSIONS_PER_ACCOUNT', 'sessions', (row) => row.sessions, false],
    ['MAX_SESSION_STATE_BYTES_PER_ACCOUNT', 'session state', (row) => row.stateBytes, true],
    ['MAX_MACHINES_PER_ACCOUNT', 'machines', (row) => row.machines, false],
];

let warned = false;
const rows = [['limit', 'source', 'limit', 'peak', 'use%', 'account', 'days left']];
for (const [name, label, read, isBytes] of limits) {
    const { value, source } = limitOf(name);
    const worst = perAccount.reduce((best, row) => (read(row) > read(best) ? row : best), perAccount[0]);
    const used = read(worst);
    const pct = value ? (used / value) * 100 : 0;
    if (pct >= opts.warn) warned = true;
    let daysLeft = '—';
    if (value && name.startsWith('MAX_MESSAGE')) {
        const perDay = growth.get(worst.id) ?? 0;
        const rate = name.endsWith('BYTES_PER_ACCOUNT')
            ? perDay * (worst.messages > 0 ? worst.messageBytes / worst.messages : 0)
            : perDay;
        if (rate > 0) {
            daysLeft = Math.round((value - used) / rate);
            // The percentage is the wrong alarm for a monotone counter: 68% of
            // the message cap sounds comfortable and is eleven days out.
            if (daysLeft <= opts.days) warned = true;
        }
    }
    rows.push([
        label,
        source,
        value ? (isBytes ? bytes(value) : value) : 'unset',
        isBytes ? bytes(used) : used,
        value ? `${pct.toFixed(1)}%` : '—',
        worst.id.slice(0, 10),
        daysLeft,
    ]);
}
table(rows);

// ── the number nobody had computed ───────────────────────────────────────────
const byteLimits = [...fallbacks.keys()].filter((name) => name.endsWith('_BYTES_PER_ACCOUNT'));
const perAccountEntitlement = byteLimits.reduce((total, name) => total + (limitOf(name).value ?? 0), 0);
const maxAccounts = Number.parseInt(env.get('SIGNUP_MAX_ACCOUNTS') ?? '0', 10) || Number(accounts);
const entitled = perAccountEntitlement * maxAccounts;
// The account bytes land in the database, so that is the disk they compete for.
const dbFree = rds && !rds.error && rds.free !== undefined ? rds.free : undefined;
const capacityFree = dbFree ?? disk[2];
const capacityLabel = dbFree !== undefined ? `RDS ${opts.rds} free` : 'host disk free';
const ratio = entitled / (capacityFree || 1);

console.log(`\nper-account byte entitlement  ${bytes(perAccountEntitlement)}  (${byteLimits.length} limits)`);
console.log(`signup mode ${env.get('SIGNUP_MODE') ?? 'unset'} · cap ${env.get('SIGNUP_MAX_ACCOUNTS') ?? 'unlimited'}`);
console.log(`worst case  ${maxAccounts} × ${bytes(perAccountEntitlement)} = ${bytes(entitled)} against ${bytes(capacityFree)} ${capacityLabel}  →  ${ratio.toFixed(1)}× oversubscribed`);
if (ratio > 1) {
    console.log('  ⚠ per-account limits cannot protect this disk on their own: a few heavy accounts');
    console.log('    fill it before any of them is refused. On veryhappy.dev this is ACCEPTED —');
    console.log('    signup is deliberately open and the totals are sized as abuse guards, not as');
    console.log('    a capacity plan; the guard that actually catches abuse is the per-minute rate');
    console.log('    bucket, not the total. See docs/operations.md before "fixing" this number.');
}
if (unresolved.length > 0) {
    console.log(`\nunresolved fallbacks (shown as "unset", NOT counted in the entitlement above):`);
    console.log(`  ${unresolved.join('\n  ')}`);
}

process.exit(warned ? 1 : 0);
}

// Importable for tests (`resource-budget.test.mjs`); runs only as a command.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
