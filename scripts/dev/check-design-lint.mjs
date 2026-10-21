#!/usr/bin/env node
/**
 * check-design-lint —— 只看「这次新增的行」的设计契约 lint（B-581）。
 *
 * 规则来源：docs/design-language.md（颜色只用 tokens.css 的 token、对话区字号走
 * --fs-* / --conversation-size、focus 必须可见）。存量代码不迁移，只拦新增行——
 * 做法借鉴 Orca 的 check:code-quality:changed（MIT），实现为本仓独立重写，零依赖。
 *
 * 检查范围：`git diff <base>...<head>` 中 packages/happy-web-v2/src 下 .css/.tsx 的新增行。
 *   ① raw-color      裸色值：#hex、rgb()/rgba()/hsl()/hsla() 字面量。
 *                    允许参数里带 var() 的写法（含 color-mix(… var(--x) …) 与相对色）。
 *   ② conversation-font-size  对话区 css 新增的字号（font-size 与 font 简写）只能用对话档位
 *                    token var(--chat-fs-*) / var(--conversation-size)（B-582 对话字号比例化）：
 *                    写死 px、var(--fs-*)、未乘 --chat-scale 的 --workspace-primary-size 都报；
 *                    触屏输入的 `max(16px, var(--chat-fs-body))` 下限、em/%/inherit 放行。
 *                    对话区集合见 CONVERSATION_CSS。
 *   ③ outline-none   `outline: none|0` 所在规则及同文件内，找不到同类名的 :focus* 替代样式。
 *   ④ field-focus-ring 文本输入框在 :focus* 下画焦点环（B-699）。
 *   ⑤ native-control tsx 新增原生 `<select>` / `<option>` / `<input type="checkbox">` / `<summary>`
 *                    （B-714）：分别改用 ui/SelectMenu、ui/Combobox、`.vh-segmented`、ui/Checkbox、
 *                    ui/Summary。白名单只有组件自身（NATIVE_CONTROL_OWNERS）；字符串字面量里的同名文本不算。
 * 宁可漏报不误报：tsx 只认明显的色值字符串；③ 只查 css。
 *
 * 豁免：同一行或上一行写 `design-lint-allow: <理由>`（css 用块注释，tsx 用 // 或 JSX 注释），
 * 理由必填。
 *
 * 用法：
 *   node scripts/dev/check-design-lint.mjs                    # base=origin/main, head=HEAD
 *   node scripts/dev/check-design-lint.mjs --base <ref> [--head <ref>]
 * 退出码：0 无发现；1 有发现；2 参数或 git 错误。
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const WEB_SRC = 'packages/happy-web-v2/src/';

/** 整个文件对所有规则豁免：token 的唯一定义处（含终端 --term-* 调色板）。 */
const EXEMPT_FILES = new Set(['styles/tokens.css']);
/** 只对 raw-color 豁免：xterm ITheme 不读 CSS 变量，只能写字面量（镜像 --term-*）。 */
const RAW_COLOR_EXEMPT_FILES = new Set(['screens/terminal/WebTerminalScreen.tsx']);

/**
 * 对话区 css（相对 WEB_SRC）：对话流、工具/子代理行、实时状态、输入框与侧问。
 * 这些文件的字号只用 tokens.css 的对话档位（--chat-fs-*，正文 = --conversation-size：桌面 14 /
 * 触屏 15），全部 × 「对话字号」设置的 --chat-scale（B-582）。
 * 弹窗、菜单、顶栏、文件面板不在此列。
 */
export const CONVERSATION_CSS = new Set([
    'askStepper', 'attachments', 'btw', 'builtinTool', 'chatlist', 'chatReadingAids', 'code', 'command', 'compaction', 'draftBlock',
    'filepathlink', 'input', 'livestream', 'markdown', 'mermaid', 'message', 'messageActions',
    'meta', 'permission', 'sessionPeerMessage', 'sessionpreviews', 'statusbar', 'subagent',
    'teamMessage', 'toolgroup', 'toolHistory', 'toolview', 'turnactivity',
].map(name => `screens/session/${name}.css`));

/** ⑤ 允许出现对应原生控件的唯一文件（相对 WEB_SRC）。 */
export const NATIVE_CONTROL_OWNERS = { checkbox: 'ui/Checkbox.tsx', summary: 'ui/Summary.tsx' };

const NATIVE_CONTROL_RES = [
    { kind: 'select', re: /<select(?=[\s>/]|$)/g, fix: '用 ui/SelectMenu（≤12 项已知列表）或 ui/Combobox（长列表/搜索/分组）；2–4 项用 .vh-segmented' },
    { kind: 'option', re: /<option(?=[\s>/]|$)/g, fix: '选项写成 SelectMenu / Combobox 的 options 数组' },
    { kind: 'checkbox', re: /\btype\s*=\s*(?:\{\s*)?['"`]checkbox['"`]/g, fix: '用 ui/Checkbox' },
    { kind: 'summary', re: /<summary(?=[\s>/]|$)/g, fix: '用 ui/Summary（隐藏浏览器三角，换 chevron）' },
];

/** idx 是否落在本行的字符串字面量里（只数同一行未转义的引号，宁可漏报）。 */
function insideString(line, idx) {
    let quote = null;
    for (let i = 0; i < idx; i++) {
        const ch = line[i];
        if (ch === '\\') { i++; continue; }
        if (quote) { if (ch === quote) quote = null; }
        else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    }
    return quote !== null;
}

/** ⑤：一行 tsx 里的原生控件（已去注释的代码）。checkbox 的 type="checkbox" 本身在引号里，单独处理。 */
export function findNativeControls(code, rel) {
    const hits = [];
    for (const { kind, re, fix } of NATIVE_CONTROL_RES) {
        if (NATIVE_CONTROL_OWNERS[kind] === rel) continue;
        for (const m of code.matchAll(re)) {
            if (insideString(code, m.index)) continue;
            hits.push({ kind, fix });
        }
    }
    return hits;
}

const ALLOW_RE = /design-lint-allow:\s*(\S.*?)?\s*(?:\*\/|\}|$)/;

export function isTestFile(rel) {
    return /\.test\.tsx$/.test(rel) || /(^|\/)__tests__\//.test(rel) || rel.startsWith('testing/');
}

/** unified=0 diff → Map<repoPath, Set<新文件行号>>。只收 WEB_SRC 下 .css/.tsx。 */
export function parseAddedLines(diff) {
    const files = new Map();
    let current = null;
    let next = 0;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++ ')) {
            const path = line.slice(4).replace(/^b\//, '').replace(/\t.*$/, '');
            current = path !== '/dev/null' && path.startsWith(WEB_SRC) && /\.(css|tsx)$/.test(path) ? path : null;
            if (current && !files.has(current)) files.set(current, new Set());
            continue;
        }
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) { next = Number(hunk[1]); continue; }
        if (!current) continue;
        if (line.startsWith('+')) { files.get(current).add(next); next++; }
        else if (line.startsWith(' ')) next++;
    }
    for (const [path, lines] of files) if (lines.size === 0) files.delete(path);
    return files;
}

/** 块注释换成等长空格（保留行号/列号），返回逐行代码。tsx 另去掉整行 // 注释。 */
export function codeLines(source, kind) {
    let out = '';
    let inBlock = false;
    for (let i = 0; i < source.length; i++) {
        const two = source.slice(i, i + 2);
        if (!inBlock && two === '/*') { inBlock = true; out += '  '; i++; continue; }
        if (inBlock && two === '*/') { inBlock = false; out += '  '; i++; continue; }
        const ch = source[i];
        out += inBlock && ch !== '\n' ? ' ' : ch;
    }
    const lines = out.split('\n');
    return kind === 'tsx' ? lines.map(l => (/^\s*\/\//.test(l) ? '' : l)) : lines;
}

const HEX = '#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])';
const CSS_HEX_RE = new RegExp(`(^|[\\s:,(])(${HEX})`, 'g');
const TSX_HEX_STRING_RE = new RegExp(`(['"\`])\\s*(${HEX})\\s*\\1`, 'g');
const TSX_HEX_PROP_RE = new RegExp(`(?:color|background|border|fill|stroke|shadow|outline)[\\w-]*['"]?\\s*[:=]\\s*[{'"\`][^'"\`]*?(${HEX})`, 'gi');
const COLOR_FN_RE = /\b(rgba?|hsla?)\(([^)]*)/g;

/** 返回一行里的裸色值（已去注释的代码）。 */
export function findRawColors(code, kind) {
    const hits = [];
    if (kind === 'css') {
        for (const m of code.matchAll(CSS_HEX_RE)) {
            const before = code.slice(0, m.index + m[1].length);
            const after = code.slice(m.index + m[0].length);
            if (/url\(\s*$/.test(before)) continue; // url(#svg-id)
            if (after.includes('{')) continue; // 选择器里的 #id
            if (!before.includes(':')) continue; // 只看声明值
            hits.push(m[2]);
        }
    } else {
        for (const m of code.matchAll(TSX_HEX_STRING_RE)) hits.push(m[2]);
        for (const m of code.matchAll(TSX_HEX_PROP_RE)) if (!hits.includes(m[1])) hits.push(m[1]);
    }
    for (const m of code.matchAll(COLOR_FN_RE)) {
        const args = m[2];
        if (/\bvar\(|^\s*from\b/.test(args)) continue; // 由 token 派生
        if (kind === 'tsx' && !/^\s*[\d.]/.test(args)) continue; // tsx 只认数字字面量参数
        hits.push(`${m[1]}(${args.trim()})`);
    }
    return hits;
}

const FONT_DECL_RE = /(?:^|[\s;{])font(?:-size)?\s*:\s*([^;}]+)/g;

/** ②：对话区一行里不合档位的字号声明（返回声明值）。 */
export function findConversationFontIssues(code) {
    const hits = [];
    for (const m of code.matchAll(FONT_DECL_RE)) {
        const value = m[1].trim();
        // 触屏可编辑控件的 iOS 16px 下限是允许的写死值
        const v = value.replace(/max\(\s*16px\s*,/g, 'max(');
        const unscaledWorkspace = /var\(--workspace-primary-size\)/.test(v) && !/--chat-scale/.test(v);
        if (/var\(--fs-\d+\)/.test(v) || /(^|[^\w.-])\d+(?:\.\d+)?px\b/.test(v) || unscaledWorkspace) hits.push(value);
    }
    return hits;
}

/** 文件内所有规则：{ selector, body, start, end }（start/end 为 code 文本偏移）。 */
export function parseRules(code) {
    const rules = [];
    const stack = [];
    let segStart = 0;
    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        if (ch === '{') {
            stack.push({ selector: code.slice(segStart, i).trim(), start: i });
            segStart = i + 1;
        } else if (ch === '}') {
            const open = stack.pop();
            if (open && !open.selector.startsWith('@')) {
                rules.push({ selector: open.selector, body: code.slice(open.start + 1, i), start: open.start, end: i });
            }
            segStart = i + 1;
        } else if (ch === ';') {
            segStart = i + 1;
        }
    }
    return rules;
}

const OUTLINE_NONE_RE = /(?:^|[\s;{])outline\s*:\s*(?:none|0)\s*(?:!important\s*)?(?:;|$|\})/;
const FOCUS_VISUAL_RE = /(?:box-shadow|border(?:-[a-z-]+)?|background(?:-color)?|outline(?:-[a-z]+)?|text-decoration(?:-[a-z]+)?|color)\s*:/g;

function classesOf(selector) {
    return new Set([...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(m => m[1]));
}

/** 这个规则体除 outline:none/0 外是否还有能当焦点指示的声明。 */
function hasFocusVisual(body) {
    const decls = body.split(';').map(d => d.trim()).filter(Boolean);
    return decls.some(d => !/^outline\s*:\s*(none|0)\b/.test(d) && /^[a-z-]+\s*:/.test(d) && d.match(FOCUS_VISUAL_RE));
}

/**
 * ③：outline 被去掉的规则是否有 :focus 系替代。
 * 通过条件（任一）：本规则选择器含 :focus* 且本规则还有其他可见声明；
 * 同文件里有选择器含 :focus*、共享任一类名、并设置了可见样式的另一条规则；
 * 或同文件有设置了可见样式的 :focus-within 规则（输入框常由外框 wrapper 表达焦点，
 * 如 .vh-input-wrap:focus-within，类名与内层 input 不同，按宁可漏报放行）；
 * 或每个选择器分支都以 `:focus` 结尾——本仓这种写法是「打开弹窗时程序化聚焦的容器/标题」
 * （.image-preview:focus、.so-title:focus），不是键盘焦点目标。代价：`.btn:focus { outline: none }`
 * 这类真问题也会漏掉（历史抽样未出现）。
 */
export function outlineHasReplacement(rule, rules) {
    if (/:focus/.test(rule.selector) && hasFocusVisual(rule.body)) return true;
    if (rule.selector.split(',').every(part => /:focus\s*$/.test(part.trim()))) return true;
    const mine = classesOf(rule.selector);
    if (mine.size === 0) return true; // 元素/全局选择器：无法可靠判断，放行
    return rules.some(other => other !== rule
        && /:focus/.test(other.selector)
        && hasFocusVisual(other.body)
        && (/:focus-within/.test(other.selector) || [...classesOf(other.selector)].some(c => mine.has(c))));
}

/** ④ B-699：文本输入框（input / textarea / 类名以 input、textarea 结尾）在 :focus* 状态下不画焦点环。 */
const FIELD_RING_RE = /(?:^|[\s;{])(?:box-shadow\s*:[^;}]*var\(--(?:focus-ring|accent-glow)\)|outline\s*:(?!\s*(?:none|0)\b)[^;}]+)/;
function stripNot(selector) {
    let out = '';
    let depth = 0;
    for (let i = 0; i < selector.length; i++) {
        if (depth === 0 && selector.startsWith(':not(', i)) { depth = 1; i += 4; continue; }
        if (depth > 0) { if (selector[i] === '(') depth++; else if (selector[i] === ')') depth--; continue; }
        out += selector[i];
    }
    return out;
}
export function isFieldFocusSelector(selector) {
    return stripNot(selector).split(',').some((part) => /:focus/.test(part)
        && /(?:^|[\s>+~(])(?:input|textarea)(?![\w-])|\.[\w-]*(?:input|textarea)(?![\w-])/.test(part.replace(/\[[^\]]*\]/g, '').split(':focus')[0])
        && !/\[type=["']?(?:checkbox|radio|range|button|submit|reset|color|file|image)/.test(part));
}

function allowReason(raw, prev) {
    for (const line of [raw, prev]) {
        if (line === undefined) continue;
        const m = ALLOW_RE.exec(line);
        if (m) return { reason: (m[1] ?? '').replace(/\*\/.*$/, '').trim() };
    }
    return null;
}

/**
 * 纯函数：对一个文件的新增行跑全部规则。
 * @param rel   相对 WEB_SRC 的路径
 * @param source 该文件在 head 的完整内容
 * @param added  新增行号集合（1-based）
 */
export function lintFile(rel, source, added) {
    if (EXEMPT_FILES.has(rel) || isTestFile(rel)) return [];
    const kind = rel.endsWith('.css') ? 'css' : 'tsx';
    const raw = source.split('\n');
    const code = codeLines(source, kind);
    const findings = [];
    let rules = null;
    const lineOffsets = [];
    { let off = 0; for (const l of code) { lineOffsets.push(off); off += l.length + 1; } }

    for (const n of [...added].sort((a, b) => a - b)) {
        const text = code[n - 1];
        if (text === undefined || !text.trim()) continue;
        const problems = [];
        if (!RAW_COLOR_EXEMPT_FILES.has(rel)) {
            for (const hit of findRawColors(text, kind)) {
                problems.push({ rule: 'raw-color', message: `裸色值 ${hit}：改用 tokens.css 的 var(--*)（派生色用 color-mix(… var(--x) …)，阴影/遮罩用 --shadow-pop/--shadow-modal/--scrim）` });
            }
        }
        if (kind === 'tsx') {
            for (const hit of findNativeControls(text, rel)) {
                problems.push({ rule: 'native-control', message: `原生 ${hit.kind}：${hit.fix}（design-language §6「组件选择」，B-714）` });
            }
        }
        if (kind === 'css' && CONVERSATION_CSS.has(rel)) {
            for (const value of findConversationFontIssues(text)) {
                problems.push({ rule: 'conversation-font-size', message: `对话区字号 ${value} 不在档位内：改用 var(--chat-fs-body|control|secondary|caption|badge|code)（触屏输入用 max(16px, var(--chat-fs-body))），见 design-language「对话字号档位」` });
            }
        }
        if (kind === 'css' && OUTLINE_NONE_RE.test(text)) {
            rules ??= parseRules(code.join('\n'));
            const at = lineOffsets[n - 1] + text.search(/outline\s*:/);
            const owner = rules.filter(r => r.start < at && at < r.end).sort((a, b) => b.start - a.start)[0];
            if (owner && !outlineHasReplacement(owner, rules)) {
                problems.push({ rule: 'outline-none', message: `「${owner.selector.replace(/\s+/g, ' ')}」去掉 outline 但同文件没有对应的 :focus-visible / :focus-within 替代样式` });
            }
        }
        if (kind === 'css' && FIELD_RING_RE.test(text)) {
            rules ??= parseRules(code.join('\n'));
            const at = lineOffsets[n - 1] + Math.max(0, text.search(/box-shadow|outline/));
            const owner = rules.filter(r => r.start < at && at < r.end).sort((a, b) => b.start - a.start)[0];
            if (owner && isFieldFocusSelector(owner.selector)) {
                problems.push({ rule: 'field-focus-ring', message: `「${owner.selector.replace(/\s+/g, ' ')}」给文本输入框画了焦点环/外发光：输入框用光标 + 边框或背景 token 表达聚焦（design-language「焦点」，B-699）` });
            }
        }
        if (problems.length === 0) continue;
        const allow = allowReason(raw[n - 1], raw[n - 2]);
        if (allow?.reason) continue;
        for (const p of problems) {
            findings.push({
                file: WEB_SRC + rel, line: n, rule: p.rule,
                message: allow ? `${p.message}（design-lint-allow 缺理由）` : p.message,
                source: raw[n - 1].trim(),
            });
        }
    }
    return findings;
}

function git(args) {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

export function run({ base, head }) {
    const diff = git(['diff', '--no-color', '--no-ext-diff', '--unified=0', '--diff-filter=ACMR', '-M',
        `${base}...${head}`, '--', WEB_SRC]);
    const findings = [];
    for (const [path, added] of parseAddedLines(diff)) {
        const source = git(['show', `${head}:${path}`]);
        findings.push(...lintFile(path.slice(WEB_SRC.length), source, added));
    }
    return findings;
}

function parseArgs(argv) {
    const opts = { base: 'origin/main', head: 'HEAD' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--base' || a === '--head') {
            const v = argv[++i];
            if (!v) throw new Error(`${a} 需要一个 git ref`);
            opts[a.slice(2)] = v;
        } else if (a === '-h' || a === '--help') {
            opts.help = true;
        } else {
            throw new Error(`未知参数 ${a}`);
        }
    }
    return opts;
}

async function main() {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (e) {
        console.error(`check-design-lint: ${e.message}`); process.exit(2);
    }
    if (opts.help) {
        console.log('usage: node scripts/dev/check-design-lint.mjs [--base <ref>] [--head <ref>]');
        return;
    }
    let findings;
    try { findings = run(opts); } catch (e) {
        console.error(`check-design-lint: git 失败（base=${opts.base} head=${opts.head}）：${e.message.split('\n')[0]}`);
        process.exit(2);
    }
    if (findings.length === 0) {
        console.log(`check-design-lint: ${opts.base}...${opts.head} 新增行无设计 lint 问题`);
        return;
    }
    for (const f of findings) {
        console.log(`${f.file}:${f.line}: [${f.rule}] ${f.message}\n    > ${f.source}`);
    }
    console.log(`\ncheck-design-lint: ${findings.length} 处问题。规则见 docs/design-language.md「改动行 lint」；`
        + '确需保留时在同一行或上一行写 design-lint-allow: <理由>。');
    process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
