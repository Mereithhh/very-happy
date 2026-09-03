#!/usr/bin/env node
/**
 * mutation-check —— 验证「这条测试真的钉住了那行代码」。
 *
 * 这个仓库大量使用**源码断言型测试**（`expect(source).toContain('…')`，先例
 * `firstRun.test.ts` / `connectMachine.test.ts` / `agentLiveness.test.ts`）：它们便宜、
 * 能钉住跨文件的接线，但有一个**静默失效**模式——被断言的字符串在同一文件里别处也出现，
 * 于是把你真正想钉住的那一处删掉，测试照样全绿。B-300 就是这样：
 * `expect(sidebar).toContain('separatorBefore: true')` 在删掉本项的 flag 之后仍然绿，
 * 是手工翻转才发现的。
 *
 * 做法：把那行改坏 → 跑测试 → **必须变红** → 还原。红了才叫钉住了。
 * 行为断言型测试同样适用（B-295 的 7 条承重线就是这么逐条验的）。
 *
 * 用法：
 *   node scripts/dev/mutation-check.mjs \
 *     --pkg happy-web-v2 \
 *     --test src/screens/onboarding/connectMachine.test.ts \
 *     --mutate 'packages/happy-web-v2/src/screens/sessions/Sidebar.tsx:key: '\''connect-machine'\''' \
 *     --mutate 'packages/happy-web-v2/src/screens/command/CommandPalette.tsx:action:connect-machine'
 *
 * 每个 `--mutate` 是 `<文件>:<字面量>`（按**第一个**冒号切，所以字面量里可以有冒号）。
 * 字面量在文件里出现多次时**直接报错**而不是猜——那正是本工具要抓的坑；
 * 用 `--near <锚点>` 指定在哪个锚点之后的第一处，或 `--nth <n>` 指定第几处。
 * `--near` / `--nth` 作用于**紧邻其前**的那个 `--mutate`。
 *
 * 退出码 0 = 所有变异都被测试抓到。非 0 = 至少一条没被抓到（或用法错误）。
 * 无论成败、包括 Ctrl-C，都会把文件还原并逐字节校验。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, relative } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');

function fail(message) {
    console.error(`mutation-check: ${message}`);
    process.exit(2);
}

function parseArgs(argv) {
    const opts = { pkg: null, test: [], mutations: [], mode: 'mangle' };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => {
            const value = argv[i + 1];
            if (value === undefined) fail(`${arg} needs a value`);
            i += 1;
            return value;
        };
        switch (arg) {
            case '--pkg': opts.pkg = next(); break;
            case '--test': opts.test.push(next()); break;
            case '--mutate': {
                const raw = next();
                const cut = raw.indexOf(':');
                if (cut <= 0) fail(`--mutate wants <file>:<literal>, got ${raw}`);
                opts.mutations.push({ file: raw.slice(0, cut), literal: raw.slice(cut + 1), near: null, nth: null });
                break;
            }
            case '--near': case '--nth': {
                const target = opts.mutations.at(-1);
                if (!target) fail(`${arg} must follow a --mutate`);
                if (arg === '--near') target.near = next();
                else target.nth = Number.parseInt(next(), 10);
                break;
            }
            // `delete` is the truest mutation but can produce a syntax error, which
            // makes the suite go red for the WRONG reason — a false "caught".
            // `mangle` (the default) keeps the code parseable, so red means the
            // assertion fired. Read the reported failing test names either way.
            case '--mode': opts.mode = next(); break;
            case '-h': case '--help': console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]); process.exit(0);
            default: fail(`unknown argument ${arg}`);
        }
    }
    if (!opts.pkg) fail('--pkg is required (e.g. happy-web-v2)');
    if (opts.test.length === 0) fail('--test is required (path relative to the package)');
    if (opts.mutations.length === 0) fail('at least one --mutate is required');
    if (!['mangle', 'delete'].includes(opts.mode)) fail(`--mode must be mangle or delete`);
    return opts;
}

/** Where in `source` to mutate. Ambiguity is an error, not a guess. */
function locate(source, { literal, near, nth }, label) {
    const from = near ? source.indexOf(near) : 0;
    if (near && from < 0) fail(`${label}: --near anchor not found: ${near}`);
    const hits = [];
    for (let at = source.indexOf(literal, from); at !== -1; at = source.indexOf(literal, at + 1)) hits.push(at);
    if (hits.length === 0) fail(`${label}: literal not found: ${literal}`);
    if (near) return hits[0];
    if (nth != null) {
        if (!(nth >= 1 && nth <= hits.length)) fail(`${label}: --nth ${nth} out of range (${hits.length} occurrences)`);
        return hits[nth - 1];
    }
    if (hits.length > 1) {
        fail(`${label}: literal occurs ${hits.length}x — this is exactly the trap this tool exists for.\n`
            + `  A bare toContain() on it would pass even after the one you care about is gone.\n`
            + `  Disambiguate with --near <anchor> or --nth <n>, and tighten the assertion in the test too.`);
    }
    return hits[0];
}

/**
 * The mutated literal must NO LONGER MATCH ITSELF — prefixing it (`MUTATED_<literal>`)
 * leaves the original substring intact, so a `toContain()` assertion still passes
 * and the tool reports a false "not caught". (Yes, this tool needed its own
 * mutation check to find that.) So `mangle` corrupts the literal in place:
 * it renames the first identifier inside it, which destroys the match while
 * keeping the file parseable.
 */
/** Is `index` inside a '…' / "…" / `…` run within this literal? */
function insideQuotes(literal, index) {
    let quote = null;
    for (let i = 0; i < index; i += 1) {
        const ch = literal[i];
        if (quote) {
            if (ch === '\\') i += 1;
            else if (ch === quote) quote = null;
        } else if (ch === "'" || ch === '"' || ch === '`') {
            quote = ch;
        }
    }
    return quote !== null;
}

function mangleLiteral(literal) {
    // Corrupt the INTERIOR, never the edges: prefixing (`zzkey: 'x'`) or
    // suffixing leaves the original literal as a substring, so `toContain()`
    // still matches and the tool reports a bogus "not caught". Splicing `zz`
    // after the first character of the LAST identifier is non-matching in every
    // shape we care about and keeps strings and identifiers well-formed:
    //   key: 'connect-machine'   →  key: 'connect-mzzachine'
    //   runningSubagentsInTurn   →  rzzunningSubagentsInTurn
    //   presence !== 'online'    →  presence !== 'ozznline'
    //
    // Prefer an identifier OUTSIDE any quotes. `foo(x, 'server unreachable')`
    // would otherwise mangle the message string — the call still runs, the test
    // still passes, and the tool cries "NOT CAUGHT" about a line that is in fact
    // pinned (B-305, real false alarm). A code identifier is what carries the
    // behaviour; only fall back to a quoted one when the literal is all string.
    const identifiers = [...literal.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)];
    const unquoted = identifiers.filter((m) => !insideQuotes(literal, m.index));
    const target = (unquoted.length ? unquoted : identifiers).at(-1);
    const at = target ? target.index + 1 : 1;
    if (literal.length < 2) return `${literal}zz`;
    return `${literal.slice(0, at)}zz${literal.slice(at)}`;
}

function mutate(source, at, literal, mode) {
    if (mode === 'delete') {
        const lineStart = source.lastIndexOf('\n', at) + 1;
        let lineEnd = source.indexOf('\n', at + literal.length);
        if (lineEnd === -1) lineEnd = source.length; else lineEnd += 1;
        return source.slice(0, lineStart) + source.slice(lineEnd);
    }
    return source.slice(0, at) + mangleLiteral(literal) + source.slice(at + literal.length);
}

function runTests(pkg, tests) {
    const env = { ...process.env };
    // Same unset as the merge gate: an inherited HAPPY_SERVER_URL/HAPPY_WEBAPP_URL
    // makes installScript.test fail for unrelated reasons (AGENTS quality gates).
    delete env.HAPPY_SERVER_URL;
    delete env.HAPPY_WEBAPP_URL;
    const result = spawnSync('pnpm', ['-C', `packages/${pkg}`, 'exec', 'vitest', 'run', ...tests], {
        cwd: repoRoot, env, encoding: 'utf8',
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const failed = [...output.matchAll(/^\s*(?:×|✕|FAIL)\s+(.+)$/gm)].map((m) => m[1].trim());
    return { red: result.status !== 0, failed, output };
}

const opts = parseArgs(process.argv.slice(2));
const originals = new Map();
const restore = () => {
    for (const [file, source] of originals) {
        writeFileSync(file, source);
        if (readFileSync(file, 'utf8') !== source) console.error(`mutation-check: FAILED TO RESTORE ${file}`);
    }
};
process.on('SIGINT', () => { restore(); process.exit(130); });

let caught = 0;
try {
    // Baseline first: a suite that is already red proves nothing about any mutation.
    process.stdout.write('baseline (unmutated) … ');
    const baseline = runTests(opts.pkg, opts.test);
    if (baseline.red) {
        console.log('RED');
        console.error('mutation-check: the suite fails before any mutation — fix that first.\n');
        console.error(baseline.output.split('\n').slice(-30).join('\n'));
        process.exit(2);
    }
    console.log('green');

    for (const mutation of opts.mutations) {
        const file = resolve(repoRoot, mutation.file);
        const label = relative(repoRoot, file);
        const source = readFileSync(file, 'utf8');
        if (!originals.has(file)) originals.set(file, source);
        const at = locate(source, mutation, label);

        process.stdout.write(`mutate ${label} :: ${JSON.stringify(mutation.literal)} … `);
        writeFileSync(file, mutate(source, at, mutation.literal, opts.mode));
        const run = runTests(opts.pkg, opts.test);
        writeFileSync(file, source);

        if (run.red) {
            caught += 1;
            console.log(`CAUGHT by ${run.failed.length > 0 ? run.failed.slice(0, 3).join(' | ') : 'the suite'}`);
        } else {
            console.log('NOT CAUGHT — the test passes without this line');
        }
    }
} finally {
    restore();
}

const total = opts.mutations.length;
console.log(`\n${caught}/${total} mutations caught.`);
process.exit(caught === total ? 0 : 1);
