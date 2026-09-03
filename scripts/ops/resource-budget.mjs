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
 * 用法：
 *   node scripts/ops/resource-budget.mjs                 # 默认连 vh-us
 *   node scripts/ops/resource-budget.mjs --host vh-us --top 8
 *   node scripts/ops/resource-budget.mjs --warn 70       # 超过 70% 就非零退出
 *   node scripts/ops/resource-budget.mjs --days 45       # 45 天内会撞墙就非零退出
 *
 * 退出码：0 = 都在阈值内；1 = 有账号越过 --warn，或预计 --days 天内撞墙；
 *          2 = 用法/连接错误。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');

function fail(message) {
    console.error(`resource-budget: ${message}`);
    process.exit(2);
}

function parseArgs(argv) {
    const opts = { host: 'vh-us', container: 'happy-postgres', server: null, top: 5, warn: 80, days: 30 };
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

/** SQL goes in on stdin — nested shell quoting is how these scripts rot. */
function psql(opts, sql) {
    const command = `docker exec -i ${opts.container} sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -F"|" -f -'`;
    return ssh(opts.host, command, sql)
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

const opts = parseArgs(process.argv.slice(2));
const serverContainer = resolveServerContainer(opts);
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

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\nhost ${opts.host} · server ${serverContainer}`);
console.log(`accounts ${accounts} (${withMessages} with messages) · sessions ${sessionCount} · machines ${machineCount}`);
console.log(`database ${bytes(+dbSize)} · disk ${bytes(disk[1])} used of ${bytes(disk[0])}, ${bytes(disk[2])} free\n`);

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
const ratio = entitled / (disk[2] || 1);

console.log(`\nper-account byte entitlement  ${bytes(perAccountEntitlement)}  (${byteLimits.length} limits)`);
console.log(`signup mode ${env.get('SIGNUP_MODE') ?? 'unset'} · cap ${env.get('SIGNUP_MAX_ACCOUNTS') ?? 'unlimited'}`);
console.log(`worst case  ${maxAccounts} × ${bytes(perAccountEntitlement)} = ${bytes(entitled)} against ${bytes(disk[2])} free  →  ${ratio.toFixed(1)}× oversubscribed`);
if (ratio > 1) {
    console.log('  ⚠ the per-account limits cannot protect this disk: a few heavy accounts fill it');
    console.log('    before any of them is refused. Lower SIGNUP_MAX_ACCOUNTS, lower the byte');
    console.log('    limits, or accept it deliberately and write down why (docs/operations.md).');
}
if (unresolved.length > 0) {
    console.log(`\nunresolved fallbacks (shown as "unset", NOT counted in the entitlement above):`);
    console.log(`  ${unresolved.join('\n  ')}`);
}

process.exit(warned ? 1 : 0);
