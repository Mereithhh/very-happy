#!/usr/bin/env node
/**
 * corpus-stats —— 用**本机真实 Claude transcript** 回答「这个渲染器该不该支持 X」。
 *
 * 2026-09-04 这一批（B-354/B-357/B-358）里，凭直觉排的优先级和实测差了一个数量级，
 * 而且**错了两次，方向相反**：
 *
 *  ① 「表格根本不支持」——错。手写渲染器有 table 分支，坏的是分块；被报的那个形状
 *     （段落后紧跟表格）只占 4.8%，真正让人难受的是 `white-space: nowrap`（桌面 56% /
 *     手机 96% 的表都会横向溢出）。
 *  ② 「表格 p90=17 行、最长 238 行、>25 行有 75 张」——也错，错在**统计口径**：脚本把
 *     「一条消息里所有 pipe 行」当成一张表，含多张表的消息被合并计数。按分隔行逐表锚定
 *     之后是 p50 4 / p90 9 / p99 18 / max 67、>25 行只有 7 张。折叠阈值与「一条回答能冲掉
 *     整个 transcript」这个动机都建立在错数上。
 *
 * 反过来，它也挡住了三个「看起来该补」的功能：`$…$` 数学 2,079 处命中**全是**货币与
 * shell 变量的假阳性（装了 KaTeX 会把 `$29,612 消费` 吃成公式，是净负面）；mermaid 与
 * GitHub alerts 各 0 次。
 *
 * 所以口径写死在这里，不要每次现写：
 *  - **只统计 `type === 'assistant'` 的 text block**——那是 `<Markdown>` 唯一渲染的东西。
 *    `tool_result` 里的表格能到 300 多行，但它走 `ToolView`/`CodeView`，与渲染器无关。
 *  - **表格按分隔行逐张锚定**，一条消息里的多张表分别计数。
 *
 * 用法：
 *   node scripts/dev/corpus-stats.mjs                 # 全量
 *   node scripts/dev/corpus-stats.mjs --json          # 机器可读
 *   node scripts/dev/corpus-stats.mjs --root <dir>    # 默认 ~/.claude/projects
 *   node scripts/dev/corpus-stats.mjs --samples math  # 打印某一项的命中样本（判假阳性用）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : (args[i + 1] ?? true);
};
const root = String(flag('root', join(homedir(), '.claude', 'projects')));
const asJson = args.includes('--json');
const sampleOf = flag('samples');

/** 一行「分隔行」= GFM 表格的锚。它上面一行是表头，下面连续的 pipe 行是数据行。 */
const SEPARATOR = /^\s*\|?[\s:|-]*-[\s:|-]*\|/;

const FEATURES = {
    // 每个探测器返回命中次数（0/1 即可）以及可选的样本串，用于人工判假阳性。
    table: (s) => (findTables(s).length > 0 ? 1 : 0),
    codeblock: (s) => (/```/.test(s) ? 1 : 0),
    nestedList: (s) => (/^\s{2,}[-*] /m.test(s) ? 1 : 0),
    taskList: (s) => (/^\s*[-*] \[[ x]\]/im.test(s) ? 1 : 0),
    strikethrough: (s) => (/~~[^~\n]+~~/.test(s) ? 1 : 0),
    footnote: (s) => (/\[\^\w+\]/.test(s) ? 1 : 0),
    mermaid: (s) => (/```mermaid/.test(s) ? 1 : 0),
    githubAlert: (s) => (/^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/im.test(s) ? 1 : 0),
    // 数学是**已知的假阳性重灾区**：`$PODS`、`${tool}`、`$29,612`、`$/月` 都会命中。
    // 报告里保留它，但一定要配 `--samples math` 看一眼再下结论。
    math: (s) => (/\$\$[\s\S]{1,400}?\$\$/.test(s) || /(^|[^\\$])\$[^\s$][^$\n]{0,80}\$([^\d]|$)/.test(s) ? 1 : 0),
};

const SAMPLERS = {
    math: (s) => s.match(/(^|[^\\$])(\$[^\s$][^$\n]{0,60}\$)/)?.[2],
    githubAlert: (s) => s.match(/^\s*>\s*\[![A-Z]+\].*/m)?.[0],
    mermaid: (s) => s.match(/```mermaid[\s\S]{0,80}/)?.[0],
};

/** 逐表锚定：返回 [{rows, cols}]。一条消息里的多张表分别计数。 */
function findTables(text) {
    const lines = text.split('\n');
    const found = [];
    for (let i = 1; i < lines.length; i++) {
        if (!SEPARATOR.test(lines[i]) || !lines[i - 1].includes('|')) continue;
        let rows = 0;
        for (let k = i + 1; k < lines.length && /^\s*\|/.test(lines[k]); k++) rows++;
        found.push({
            rows,
            cols: lines[i - 1].trim().replace(/^\||\|$/g, '').split('|').length,
            gluedToProse: i >= 2 && lines[i - 2].trim() !== '' && !lines[i - 2].includes('|'),
        });
        i += rows;
    }
    return found;
}

function* jsonlFiles(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) yield* jsonlFiles(path);
        else if (entry.name.endsWith('.jsonl')) yield path;
    }
}

/** `<Markdown>` 渲染的**唯一**东西：assistant 消息里的 text block。 */
function* assistantTexts(dir) {
    for (const file of jsonlFiles(dir)) {
        let raw;
        try { raw = readFileSync(file, 'utf8'); } catch { continue; }
        for (const line of raw.split('\n')) {
            if (!line) continue;
            let parsed;
            try { parsed = JSON.parse(line); } catch { continue; }
            if (parsed.type !== 'assistant' || !Array.isArray(parsed.message?.content)) continue;
            for (const block of parsed.message.content) {
                if (block.type === 'text' && typeof block.text === 'string') yield block.text;
            }
        }
    }
}

function quantile(sorted, p) {
    return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

try { statSync(root); } catch {
    console.error(`corpus-stats: no transcript corpus at ${root}`);
    process.exit(2);
}

const counts = Object.fromEntries(Object.keys(FEATURES).map((k) => [k, 0]));
const samples = [];
const rows = [];
const cols = [];
let messages = 0;
let glued = 0;
let tables = 0;

for (const text of assistantTexts(root)) {
    messages++;
    for (const [name, probe] of Object.entries(FEATURES)) counts[name] += probe(text);
    if (sampleOf && samples.length < 25 && counts[sampleOf] > 0) {
        const sample = (SAMPLERS[sampleOf] ?? ((s) => s.slice(0, 60)))(text);
        if (sample) samples.push(sample.trim().slice(0, 70));
    }
    for (const table of findTables(text)) {
        tables++;
        rows.push(table.rows);
        cols.push(table.cols);
        if (table.gluedToProse) glued++;
    }
}

rows.sort((a, b) => a - b);
cols.sort((a, b) => a - b);
const pct = (n, of) => `${n} (${of ? ((n / of) * 100).toFixed(1) : '0.0'}%)`;
const report = {
    corpus: { root, messages, tables },
    features: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, { hits: v, pctOfMessages: +((v / messages) * 100).toFixed(1) }])),
    tableRows: { p50: quantile(rows, 0.5), p75: quantile(rows, 0.75), p90: quantile(rows, 0.9), p95: quantile(rows, 0.95), p99: quantile(rows, 0.99), max: rows.at(-1) ?? 0 },
    tableCols: { p50: quantile(cols, 0.5), p90: quantile(cols, 0.9), max: cols.at(-1) ?? 0 },
    tableShapes: {
        gluedToProse: glued,
        rowsOver: Object.fromEntries([10, 12, 16, 20, 25].map((t) => [t, rows.filter((r) => r > t).length])),
        colsOver: Object.fromEntries([4, 5, 6].map((t) => [t, cols.filter((c) => c > t).length])),
    },
};

if (asJson) {
    console.log(JSON.stringify(report, null, 2));
} else {
    console.log(`corpus: ${messages} assistant text blocks, ${tables} tables  (${root})`);
    console.log('\nfeature                hits');
    for (const [name, v] of Object.entries(report.features)) {
        console.log(`  ${name.padEnd(20)} ${pct(v.hits, messages)}`);
    }
    console.log('\ntable rows   p50 %s  p75 %s  p90 %s  p95 %s  p99 %s  max %s',
        report.tableRows.p50, report.tableRows.p75, report.tableRows.p90, report.tableRows.p95, report.tableRows.p99, report.tableRows.max);
    for (const [t, n] of Object.entries(report.tableShapes.rowsOver)) console.log(`  rows > ${String(t).padEnd(3)} ${pct(n, tables)}`);
    console.log('\ntable cols   p50 %s  p90 %s  max %s', report.tableCols.p50, report.tableCols.p90, report.tableCols.max);
    for (const [t, n] of Object.entries(report.tableShapes.colsOver)) console.log(`  cols > ${String(t).padEnd(3)} ${pct(n, tables)}`);
    console.log(`\nglued to a prose line (no blank line before the table): ${pct(glued, tables)}`);
    if (sampleOf) {
        console.log(`\nsamples for "${sampleOf}" — read these before believing the count:`);
        for (const sample of samples) console.log(`  · ${sample}`);
    } else {
        console.log('\nhint: run with --samples math before trusting the math count; it is mostly $PODS / ${tool} / $29,612.');
    }
}
