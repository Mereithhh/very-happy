#!/usr/bin/env node
/**
 * codemod-hover-guard —— 把未守卫的 :hover 规则原地包进 `@media (hover: hover) and (pointer: fine)`（B-728，UI-M-01）。
 *
 * 触屏浏览器把最后一次点按留作 hover 点，没守卫的 :hover 会粘在刚点过的控件上。lint 规则
 * `hover-unguarded`（check-design-lint.mjs）拦新增；这个脚本迁移存量，冲突后可重跑（幂等）。
 *
 * 规则：
 *   - 原地包裹，不挪到文件末尾：同优先级按源码顺序生效，挪了会盖过后面的选中/禁用态（B-653、B-359）。
 *   - 合并选择器（`.a:hover, .a:focus-visible`、`.a:hover, .a[data-state=open]`）拆开：非 hover 的一半留在原处，
 *     hover 的一半紧跟其后包进守卫。
 *   - 相邻（中间只有空白/注释）的多条 hover 规则合进同一个守卫块。
 *   - 不自动改、只报告（需要人工判断）：
 *       coarse     写在 (pointer: coarse)/(hover: none) 里的 hover —— 等于只对触屏生效；
 *       reveal     hover 时改 opacity/visibility/display —— 包进守卫后触屏永远看不到，需「默认可见、只在守卫里隐藏」；
 *       focus-mix  拆出来的 :focus-visible 半边带 box-shadow/outline 声明 —— 可能把焦点环一起抹掉（UI-P1-04）。
 *
 * 用法：
 *   node scripts/dev/codemod-hover-guard.mjs            # 只报告（dry run）
 *   node scripts/dev/codemod-hover-guard.mjs --write    # 改写文件
 *   node scripts/dev/codemod-hover-guard.mjs --write path/a.css path/b.css
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOVER_GUARD, codeLines, findHoverRules, selectorHasHover } from './check-design-lint.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_SRC = join(REPO, 'packages/happy-web-v2/src');
const SKIP = new Set(['styles/tokens.css']);

function lineIndent(source, offset) {
    const ls = source.lastIndexOf('\n', offset - 1) + 1;
    const lead = source.slice(ls, offset);
    return /^\s*$/.test(lead) ? lead : null;
}

function wrap(text, indent) {
    if (!text.includes('\n') && indent !== null) return `${HOVER_GUARD} { ${text} }`;
    const ind = indent ?? '';
    const lines = text.split('\n');
    // 嵌套一级用文件自己的缩进单位（规则体相对选择器多出来的空白），默认 2 空格
    const bodyLead = lines.slice(1).find(l => l.trim())?.match(/^\s*/)[0] ?? '';
    const unit = bodyLead.startsWith(ind) && bodyLead.length > ind.length ? bodyLead.slice(ind.length) : '  ';
    const body = lines.map((l, i) => (i === 0 ? `${ind}${unit}${l}` : l.trim() ? `${unit}${l}` : l)).join('\n');
    return `${HOVER_GUARD} {\n${body}\n${ind}}`;
}

/** 对一份 css 源码做迁移，返回 { output, changed, notes }。纯函数。 */
export function migrateHover(source) {
    const code = codeLines(source, 'css').join('\n');
    const rules = findHoverRules(code).filter(r => !r.guarded && !r.coarse);
    const notes = [];
    const lineOf = (off) => source.slice(0, off).split('\n').length;
    for (const r of findHoverRules(code)) {
        if (r.coarse) notes.push({ kind: 'coarse', line: lineOf(r.selStart), selector: r.hoverParts.join(', ') });
    }
    // 分组：同一父级、中间只有空白/注释的相邻规则
    const groups = [];
    for (const r of rules) {
        const last = groups.at(-1);
        const prev = last?.at(-1);
        if (prev && prev.depth === r.depth && prev.parts.length === prev.hoverParts.length
            && r.parts.length === r.hoverParts.length && /^\s*$/.test(code.slice(prev.end + 1, r.selStart))) {
            last.push(r);
        } else groups.push([r]);
    }
    let output = source;
    for (const group of groups.reverse()) {
        const first = group[0];
        const lastR = group.at(-1);
        const body = source.slice(first.open, lastR.end + 1); // "{ ... }"（单条时）
        for (const r of group) {
            const decl = code.slice(r.open + 1, r.end);
            if (/(?:^|[\s;])(?:opacity|visibility|display)\s*:/.test(decl)) {
                notes.push({ kind: 'reveal', line: lineOf(r.selStart), selector: r.hoverParts.join(', ') });
            }
        }
        const indent = lineIndent(source, first.selStart);
        let replacement;
        if (group.length === 1 && first.parts.length !== first.hoverParts.length) {
            const others = first.parts.filter(p => !selectorHasHover(p));
            const multiline = source.slice(first.selStart, first.open).includes('\n');
            const joiner = multiline ? `,\n${indent ?? ''}` : ', ';
            const decl = code.slice(first.open + 1, first.end);
            if (others.some(p => /:focus/.test(p)) && /(?:^|[\s;])(?:box-shadow|outline)\s*:/.test(decl)) {
                notes.push({ kind: 'focus-mix', line: lineOf(first.selStart), selector: first.selector.replace(/\s+/g, ' ') });
            }
            const otherRule = `${others.join(joiner)} ${body}`;
            const hoverRule = `${first.hoverParts.join(joiner)} ${body}`;
            replacement = `${otherRule}\n${indent ?? ''}${wrap(hoverRule, indent)}`;
        } else {
            replacement = wrap(source.slice(first.selStart, lastR.end + 1), indent);
        }
        output = output.slice(0, first.selStart) + replacement + output.slice(lastR.end + 1);
    }
    return { output, changed: output !== source, count: rules.length, notes };
}

function listCss(dir, out = []) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) { if (ent.name !== 'node_modules') listCss(p, out); }
        else if (ent.name.endsWith('.css') && !SKIP.has(relative(WEB_SRC, p))) out.push(p);
    }
    return out;
}

function main() {
    const args = process.argv.slice(2);
    const write = args.includes('--write');
    const files = args.filter(a => !a.startsWith('--'));
    const targets = files.length ? files.map(f => join(process.cwd(), f)) : listCss(WEB_SRC);
    let total = 0;
    for (const file of targets) {
        const source = readFileSync(file, 'utf8');
        const { output, changed, count, notes } = migrateHover(source);
        const rel = relative(REPO, file);
        if (count) console.log(`${rel}: ${count} 条${write ? '已包裹' : '待包裹'}`);
        for (const n of notes) console.log(`  [${n.kind}] ${rel}:${n.line} ${n.selector}`);
        total += count;
        if (write && changed) writeFileSync(file, output);
    }
    console.log(`codemod-hover-guard: ${total} 条 hover 规则${write ? '已包裹' : '（dry run，加 --write 改写）'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
