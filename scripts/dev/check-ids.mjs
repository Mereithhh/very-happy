#!/usr/bin/env node
/**
 * check-ids —— 取号 / 验号，**只认 origin/main**。
 *
 * 并行开发下最贵的重复劳动就是编号：B-id、V-id、changelog 文本 key 三家都会撞，
 * 而且撞法不同——B/V 撞了 rebase 冲突看得见，**changelog key 撞了完全不报错**：
 * squash 合并保留先合的一方，后合的一方代码全在、release 条目被静默吞掉
 * （2026-09-03 的 `sep03f`）。纪律全文在 `docs/PROCESS.md` 编号分配那条，这个脚本
 * 只是把它变成一条能跑的命令。
 *
 * 号是**开工时**取的，而 main 在你写代码、跑门禁、做 review 的几小时里一直前进，
 * 所以这不是开工跑一次的事——**每次 rebase 后、开 PR 前都要再跑一次 `--claim`**。
 * 实测复发率：一个 session 内被抢 3 次（B-304/305 → 306/307 → 309/310/311），
 * 同一天 CLI 版本号被三个会话依次取走。
 *
 * 用法：
 *   node scripts/dev/check-ids.mjs                    # 报下一个可用的 B / V / changelog key
 *   node scripts/dev/check-ids.mjs --claim B-312 --claim V-136 --claim sep03s
 *   node scripts/dev/check-ids.mjs --no-fetch ...     # 跳过 git fetch（离线/刚 fetch 过）
 *
 * 退出码 0 = 全部可用。非 0 = 至少一个已被 origin/main 占用（输出说明被谁占了）。
 * 只读：不写文件、不改 git 状态（除了 `git fetch`）。
 */
import { execFileSync } from 'node:child_process';

const BACKLOG = 'docs/backlog.md';
const VERIFY = 'docs/verify-queue.md';
const CHANGELOG = 'packages/happy-web-v2/src/app/changelogRelease.ts';
const REF = 'origin/main';

function git(args) {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** File content AS OF origin/main — the working tree is exactly what goes stale. */
function showFromRef(path) {
    try {
        return git(['show', `${REF}:${path}`]);
    } catch {
        console.error(`cannot read ${REF}:${path} — is origin fetched and the path right?`);
        process.exit(2);
    }
}

/** Allocated ids = table rows only (`| B-312 | …`), never prose mentions. */
function takenIds(source, prefix) {
    const taken = new Map(); // number -> first ~70 chars of the row, for the error message
    const re = new RegExp(`^\\|\\s*${prefix}-(\\d+)\\s*\\|([^|]*)`, 'gm');
    for (const m of source.matchAll(re)) {
        const n = Number(m[1]);
        if (!taken.has(n)) taken.set(n, m[2].trim().slice(0, 70));
    }
    return taken;
}

/** changelog text keys, read from the release table that actually references them. */
function takenKeys(source) {
    const taken = new Set();
    for (const m of source.matchAll(/changelog\.releases\.([A-Za-z0-9]+)\./g)) taken.add(m[1]);
    return taken;
}

function nextId(taken) {
    return (taken.size ? Math.max(...taken.keys()) : 0) + 1;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function todayKeyPrefix(now = new Date()) {
    return `${MONTHS[now.getMonth()]}${String(now.getDate()).padStart(2, '0')}`;
}

const LETTERS = [...'abcdefghijklmnopqrstuvwxyz'];

/** a…z, then aa…az, ba… — the single-letter series ran out on 2026-09-03
 *  (26 releases in one day across parallel sessions) and this returned null,
 *  which reads as "no key available" at exactly the wrong moment. */
function* keySuffixes() {
    yield* LETTERS;
    for (const first of LETTERS) for (const second of LETTERS) yield first + second;
}

function nextKey(taken, prefix) {
    // The bare prefix is only offered when the day has NO entry yet: once
    // `sep03a` exists, `sep03` is unused but wrong — the series is lettered.
    const started = [...taken].some((k) => k.startsWith(prefix));
    if (!started) return prefix;
    for (const suffix of keySuffixes()) {
        if (!taken.has(prefix + suffix)) return prefix + suffix;
    }
    return null;
}

const argv = process.argv.slice(2);
const claims = [];
let fetch = true;
for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--claim') {
        const value = argv[i + 1];
        if (!value) {
            console.error('--claim wants a value (B-312 / V-136 / sep03s)');
            process.exit(2);
        }
        claims.push(value);
        i += 1;
    } else if (argv[i] === '--no-fetch') {
        fetch = false;
    } else {
        console.error(`unknown argument ${argv[i]}`);
        process.exit(2);
    }
}

if (fetch) git(['fetch', '-q', 'origin', 'main']);

const backlogIds = takenIds(showFromRef(BACKLOG), 'B');
const verifyIds = takenIds(showFromRef(VERIFY), 'V');
const keys = takenKeys(showFromRef(CHANGELOG));
const keyPrefix = todayKeyPrefix();

if (claims.length === 0) {
    console.log(`${REF} — next free:`);
    console.log(`  backlog        B-${nextId(backlogIds)}`);
    console.log(`  verify-queue   V-${nextId(verifyIds)}`);
    console.log(`  changelog key  ${nextKey(keys, keyPrefix)}`);
    console.log('\nRe-run with --claim before every PR: main moves while you work.');
    process.exit(0);
}

let bad = 0;
for (const claim of claims) {
    const id = /^([BV])-(\d+)$/.exec(claim);
    if (id) {
        const taken = id[1] === 'B' ? backlogIds : verifyIds;
        const row = taken.get(Number(id[2]));
        if (row === undefined) {
            console.log(`ok        ${claim} is free on ${REF}`);
        } else {
            bad += 1;
            const next = id[1] === 'B' ? `B-${nextId(backlogIds)}` : `V-${nextId(verifyIds)}`;
            console.log(`TAKEN     ${claim} → ${row}`);
            console.log(`          renumber to ${next} (code comments, test names, spec, PR title too)`);
        }
        continue;
    }
    if (keys.has(claim)) {
        bad += 1;
        console.log(`TAKEN     changelog key ${claim} — a collision here is SILENT (squash keeps one entry)`);
        console.log(`          use ${nextKey(keys, keyPrefix)}`);
    } else {
        console.log(`ok        changelog key ${claim} is free on ${REF}`);
    }
}
process.exit(bad === 0 ? 0 : 1);
