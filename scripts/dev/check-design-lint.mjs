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
 *   ⑤ native-control tsx 新增原生 `<select>` / `<option>` / `<datalist>` / `<input type="checkbox">` / `<summary>`
 *                    （B-714）：分别改用 ui/SelectMenu、ui/Combobox、ui/Segmented、ui/SuggestInput、ui/Checkbox、
 *                    ui/Summary。白名单只有组件自身（NATIVE_CONTROL_OWNERS）；字符串字面量里的同名文本不算。
 *   ⑥ hover-unguarded  :hover 规则不在 @media (hover: hover) 里（或写在 pointer: coarse 里）（B-728）。
 *                    这条另有全仓模式 `--all-hover`（CI 的 node 测试跑它，存量必须为 0）。
 *   ⑦ hover-reveal-needs-touch  hover / focus-within 才显示的控件（hover 守卫外 display:none / opacity:0 /
 *                    visibility:hidden，守卫内显示），在 (pointer: coarse) / (hover: none) 下也必须可见（B-798 U1）。
 *                    改动行涉及隐藏规则或显示规则任一行即报；全仓模式 `--all-reveal`，存量只许是
 *                    REVEAL_ALLOWLIST 里的（CI 的 node 测试跑它，名单只减不增）。
 *   ⑧ touch-target   (pointer: coarse) 块里给交互类（按钮 / 操作 / 菜单项 / 标签页 / chip / 开关…）写
 *                    16–43px 的 height / min-height / width / min-width（B-798 U3）：触屏命中区至少 44px，
 *                    视觉小的用 ::after 扩热区。
 * 宁可漏报不误报：tsx 只认明显的色值字符串；③④⑥ 只查 css。
 *
 * 豁免：同一行或上一行写 `design-lint-allow: <理由>`（css 用块注释，tsx 用 // 或 JSX 注释），
 * 理由必填。
 *
 * 用法：
 *   node scripts/dev/check-design-lint.mjs                    # base=origin/main, head=HEAD
 *   node scripts/dev/check-design-lint.mjs --base <ref> [--head <ref>]
 *   node scripts/dev/check-design-lint.mjs --all-hover         # 全仓扫描未守卫的 :hover
 *   node scripts/dev/check-design-lint.mjs --all-reveal        # 全仓扫描触屏看不到的 hover 显示控件（含 allowlist 内的）
 * 退出码：0 无发现；1 有发现；2 参数或 git 错误。
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    'teamMessage', 'toolgroup', 'toolHistory', 'toolview', 'turnactivity', 'turnDiff',
].map(name => `screens/session/${name}.css`));

/** ⑤ 允许出现对应原生控件的唯一文件（相对 WEB_SRC）。 */
export const NATIVE_CONTROL_OWNERS = { checkbox: 'ui/Checkbox.tsx', summary: 'ui/Summary.tsx' };

const NATIVE_CONTROL_RES = [
    { kind: 'select', re: /<select(?=[\s>/]|$)/g, fix: '用 ui/SelectMenu（≤12 项已知列表）或 ui/Combobox（长列表/搜索/分组）；2–4 项用 .vh-segmented' },
    { kind: 'option', re: /<option(?=[\s>/]|$)/g, fix: '选项写成 SelectMenu / Combobox 的 options 数组' },
    { kind: 'datalist', re: /<datalist(?=[\s>/]|$)/g, fix: '输入框的补全建议用 ui/SuggestInput' },
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

/**
 * ⑤ hover-unguarded（B-728，UI-M-01）：触屏浏览器把最后一次点按留作 hover 点，
 * 没有守卫的 :hover 会「粘」在刚点过的控件上（logo、顶栏图标、消息操作栏）。
 * 每条 :hover 规则必须写在 `@media (hover: hover)`（约定写法
 * `@media (hover: hover) and (pointer: fine)`）里；写在 `(pointer: coarse)` 里等于只对触屏生效，也报。
 * `:not(:hover)` 里的 hover 不算。
 */
const HOVER_GUARD_RE = /\(\s*(?:any-)?hover\s*:\s*hover\s*\)/;
export const HOVER_GUARD = '@media (hover: hover) and (pointer: fine)';
export function isHoverGuard(prelude) {
    return /^@media\b/.test(prelude) && HOVER_GUARD_RE.test(prelude)
        && !/pointer\s*:\s*coarse/.test(prelude) && !/\bnot\b/.test(prelude);
}

/** 按顶层逗号切选择器列表（括号内的逗号不切）。 */
export function splitSelectorList(selector) {
    const parts = [];
    let depth = 0;
    let cur = '';
    for (const ch of selector) {
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
}

export function selectorHasHover(part) {
    return /:hover(?![\w-])/.test(stripNot(part));
}

/**
 * 文件内所有含 :hover 的样式规则（code 已去注释）。
 * 返回 { selector, parts, hoverParts, selStart, open, end, guarded, coarse, depth }，偏移为 code 文本偏移：
 * selStart = 选择器首字符，open = `{`，end = 对应的 `}`。
 */
export function findHoverRules(code) {
    const out = [];
    const stack = [];
    let segStart = 0;
    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        if (ch === '{') {
            const rawSeg = code.slice(segStart, i);
            const lead = rawSeg.length - rawSeg.trimStart().length;
            const selector = rawSeg.trim();
            stack.push({ selector, selStart: segStart + lead, open: i });
            segStart = i + 1;
        } else if (ch === '}') {
            const open = stack.pop();
            if (open && !open.selector.startsWith('@')) {
                const parts = splitSelectorList(open.selector);
                const hoverParts = parts.filter(selectorHasHover);
                if (hoverParts.length) {
                    const media = stack.filter(s => s.selector.startsWith('@media'));
                    out.push({
                        selector: open.selector, parts, hoverParts,
                        selStart: open.selStart, open: open.open, end: i,
                        guarded: media.some(s => isHoverGuard(s.selector)),
                        coarse: media.some(s => /pointer\s*:\s*coarse|hover\s*:\s*none/.test(s.selector)),
                        depth: stack.length,
                    });
                }
            }
            segStart = i + 1;
        } else if (ch === ';') {
            segStart = i + 1;
        }
    }
    return out;
}

/** 全部样式规则及其外层 @media：{ selector, parts, body, selStart, open, end, media: string[] }。 */
export function parseRulesWithMedia(code) {
    const out = [];
    const stack = [];
    let segStart = 0;
    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        if (ch === '{') {
            const rawSeg = code.slice(segStart, i);
            stack.push({ selector: rawSeg.trim(), selStart: segStart + rawSeg.length - rawSeg.trimStart().length, open: i });
            segStart = i + 1;
        } else if (ch === '}') {
            const open = stack.pop();
            if (open && !open.selector.startsWith('@')) {
                out.push({
                    selector: open.selector, parts: splitSelectorList(open.selector), body: code.slice(open.open + 1, i),
                    selStart: open.selStart, open: open.open, end: i,
                    media: stack.filter(s => s.selector.startsWith('@media')).map(s => s.selector),
                });
            }
            segStart = i + 1;
        } else if (ch === ';') {
            segStart = i + 1;
        }
    }
    return out;
}

const TOUCH_MEDIA_RE = /pointer\s*:\s*coarse|(?:any-)?hover\s*:\s*none/;
const isTouchMedia = (media) => media.some(m => TOUCH_MEDIA_RE.test(m) && !isHoverGuard(m));
const isGuardMedia = (media) => media.some(isHoverGuard);

/** 选择器分支的最后一个复合选择器（去掉带括号的伪类参数），没有伪元素时返回 { classes, pseudo }。 */
export function subjectOf(part) {
    let depth = 0;
    let last = '';
    for (const ch of part) {
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        if (depth === 0 && /[\s>+~]/.test(ch)) { last = ''; continue; }
        last += ch;
    }
    if (/::/.test(last)) return null;
    const flat = last.replace(/:[\w-]+\((?:[^()]|\([^()]*\))*\)/g, '').replace(/\[[^\]]*\]/g, '');
    return { classes: [...flat.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(m => m[1]), pseudo: /:[\w-]/.test(flat) };
}

/**
 * 声明体里的显隐，按属性：{ display?, visibility?, opacity? }，值为 'hide'（none / hidden / 0）或 'show'。
 * 按属性配对：display:none 只能被 display 显示规则撤销，opacity:0 只能被 opacity 撤销。
 */
export function visibilityOf(body) {
    const out = {};
    for (const decl of body.split(';')) {
        const m = /^\s*(display|visibility|opacity)\s*:\s*([^!]+?)\s*(?:!important\s*)?$/.exec(decl);
        if (!m) continue;
        const [, prop, value] = m;
        const hidden = prop === 'display' ? value === 'none' : prop === 'visibility' ? value === 'hidden' : /^0*(?:\.0*)?%?$/.test(value);
        out[prop] = hidden ? 'hide' : 'show';
    }
    return out;
}

const REVEAL_TRIGGER_RE = /:(?:hover|focus-within)(?![\w-])/;
const subset = (a, b) => a.every(c => b.includes(c));

/**
 * ⑦ hover-reveal-needs-touch（B-798 U1）：守卫里由 :hover / :focus-within 显示的控件，若在守卫外被隐藏，
 * 触屏下必须另有 (pointer: coarse) / (hover: none) 规则让它可见。推荐写法是反过来：默认可见，只在
 * `@media (hover: hover) and (pointer: fine)` 里隐藏（.sb-workspace-new、.sb-tree-acts）。
 * 返回 [{ key, line, hideLine, message }]（code 已去注释），key = 「被隐藏的类」用于 allowlist。
 */
export function findTouchHiddenReveals(code) {
    const rules = parseRulesWithMedia(code);
    const hides = [];
    const touchShows = [];
    for (const r of rules) {
        const vis = visibilityOf(r.body);
        for (const [prop, v] of Object.entries(vis)) {
            for (const part of r.parts) {
                const subj = subjectOf(part);
                if (!subj || subj.classes.length === 0) continue;
                if (v === 'hide' && !isGuardMedia(r.media) && !isTouchMedia(r.media) && !subj.pseudo && !/[:[]/.test(part)) hides.push({ prop, classes: subj.classes, rule: r });
                if (v === 'show' && isTouchMedia(r.media)) touchShows.push({ prop, classes: subj.classes });
            }
        }
    }
    const out = [];
    const seen = new Set();
    for (const r of rules) {
        if (!isGuardMedia(r.media)) continue;
        const vis = visibilityOf(r.body);
        for (const part of r.parts) {
            if (!REVEAL_TRIGGER_RE.test(stripNot(part))) continue;
            const subj = subjectOf(part);
            if (!subj || subj.classes.length === 0) continue;
            for (const hide of hides) {
                if (vis[hide.prop] !== 'show' || !subset(hide.classes, subj.classes)) continue;
                if (touchShows.some(show => show.prop === hide.prop && subset(hide.classes, show.classes))) continue;
                const key = hide.classes.map(c => `.${c}`).join('');
                const line = lineAt(code, r.selStart + Math.max(0, r.selector.indexOf(part)));
                if (seen.has(`${key}@${line}`)) continue;
                seen.add(`${key}@${line}`);
                out.push({
                    key, line, hideLine: lineAt(code, hide.rule.selStart),
                    message: `「${key}」在 hover 守卫外隐藏、只靠「${part.replace(/\s+/g, ' ')}」显示：触屏永远看不到（B-798 U1）。改成默认可见、只在 ${HOVER_GUARD} 里隐藏，或在 (pointer: coarse) 下显示`,
                });
            }
        }
    }
    return out;
}

/**
 * B-798 存量：hover 才显示、触屏看不到的控件（`--all-reveal` 的允许名单，key = 相对 WEB_SRC 的文件 + 被隐藏的类）。
 * 只减不增：修好的条目要删掉（node 测试会报「已不存在」），新增问题不许进名单。
 */
export const REVEAL_ALLOWLIST = new Set([
]);

/** ⑧ 交互类名（最后一个复合选择器里的类以这些词结尾）。 */
const INTERACTIVE_CLASS_RE = /(?:^|[-_])(?:btn|button|act|action|toggle|close|chevron|menu|item|tab|chip|back|trigger|switch|link|more|new|add)$/i;
const SIZE_DECL_RE = /(?:^|[\s;{])((?:min-)?(?:height|width))\s*:\s*(\d+(?:\.\d+)?)px/g;

/** ⑧ touch-target：返回 [{ line, message }]（code 已去注释）。同文件给该类写了 ::after / ::before 的视为已扩热区。 */
export function findSmallTouchTargets(code) {
    const out = [];
    const rules = parseRulesWithMedia(code);
    const expanded = new Set(rules.flatMap(r => r.parts.filter(p => /::?(?:after|before)\b/.test(p))
        .flatMap(p => [...p.replace(/::?(?:after|before)\b.*$/, '').matchAll(/\.(-?[_a-zA-Z][\w-]*)(?![\w-])/g)].map(m => m[1]).slice(-1))));
    for (const r of rules) {
        if (!isTouchMedia(r.media) || !r.media.some(m => /pointer\s*:\s*coarse/.test(m))) continue;
        const parts = r.parts.filter((part) => {
            const subj = subjectOf(part);
            return subj && subj.classes.some(c => INTERACTIVE_CLASS_RE.test(c)) && !subj.classes.some(c => expanded.has(c));
        });
        if (!parts.length) continue;
        for (const m of r.body.matchAll(SIZE_DECL_RE)) {
            const px = Number(m[2]);
            if (px < 16 || px >= 44) continue;
            const at = r.open + 1 + m.index + m[0].indexOf(m[1]);
            out.push({ line: lineAt(code, at), message: `「${parts.join(', ').replace(/\s+/g, ' ')}」触屏 ${m[1]}: ${m[2]}px < 44px（B-798 U3）：命中区至少 44px，视觉要小就用 ::after 扩热区` });
        }
    }
    return out;
}

/** code 偏移 → 1-based 行号 */
function lineAt(code, offset) {
    let n = 1;
    for (let i = 0; i < offset; i++) if (code.charCodeAt(i) === 10) n++;
    return n;
}

function hoverMessage(rule) {
    const sel = rule.hoverParts.join(', ').replace(/\s+/g, ' ');
    return rule.coarse
        ? `「${sel}」写在 (pointer: coarse) / (hover: none) 里：触屏没有真正的 hover，按下反馈用 :active，hover 写进 ${HOVER_GUARD}`
        : `「${sel}」没有 hover 守卫：触屏点按后会一直停在 hover 态。包进 ${HOVER_GUARD} { … }（合并写法如 :hover, :focus-visible 要拆开），或跑 node scripts/dev/codemod-hover-guard.mjs`;
}

function findUnguardedHoversRaw(code) {
    return findHoverRules(code).filter(r => !r.guarded || r.coarse).map((rule) => {
        const firstHover = code.indexOf(':hover', rule.selStart);
        return { line: lineAt(code, firstHover >= 0 && firstHover < rule.open ? firstHover : rule.selStart), message: hoverMessage(rule) };
    });
}

/** 全文件的未守卫 hover（不看 diff）。返回 [{ line, message, source }]，已按 design-lint-allow 过滤。 */
export function findUnguardedHovers(source) {
    const raw = source.split('\n');
    return findUnguardedHoversRaw(codeLines(source, 'css').join('\n'))
        .filter(h => !allowReason(raw[h.line - 1], raw[h.line - 2])?.reason)
        .map(h => ({ ...h, source: raw[h.line - 1].trim() }));
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
    let hoverHits = null;
    let revealHits = null;
    let targetHits = null;
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
        if (kind === 'css' && hoverHits === null) hoverHits = new Map(findUnguardedHoversRaw(code.join('\n')).map(h => [h.line, h]));
        if (kind === 'css' && hoverHits.has(n)) problems.push({ rule: 'hover-unguarded', message: hoverHits.get(n).message });
        if (kind === 'css') {
            // either end of the pair can carry the design-lint-allow
            revealHits ??= findTouchHiddenReveals(code.join('\n')).filter(h => !allowReason(raw[h.line - 1], raw[h.line - 2])?.reason && !allowReason(raw[h.hideLine - 1], raw[h.hideLine - 2])?.reason);
            for (const h of revealHits) if (h.line === n || h.hideLine === n) problems.push({ rule: 'hover-reveal-needs-touch', message: h.message });
            targetHits ??= findSmallTouchTargets(code.join('\n'));
            for (const h of targetHits) if (h.line === n) problems.push({ rule: 'touch-target', message: h.message });
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

/** 全仓（工作区文件）扫描 WEB_SRC 下 css 的未守卫 hover。 */
export function scanAllHover(repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')) {
    const root = join(repoRoot, WEB_SRC);
    const hits = [];
    const walk = (dir) => {
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, ent.name);
            if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(p); continue; }
            if (!ent.name.endsWith('.css')) continue;
            const rel = relative(root, p).split(sep).join('/');
            if (EXEMPT_FILES.has(rel)) continue;
            for (const h of findUnguardedHovers(readFileSync(p, 'utf8'))) hits.push({ file: WEB_SRC + rel, ...h });
        }
    };
    walk(root);
    return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** 全仓扫描 ⑦：返回 [{ file, key, line, message, allowed }]，allowed = 在 REVEAL_ALLOWLIST 里。 */
export function scanAllReveal(repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')) {
    const root = join(repoRoot, WEB_SRC);
    const hits = [];
    const walk = (dir) => {
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, ent.name);
            if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(p); continue; }
            if (!ent.name.endsWith('.css')) continue;
            const rel = relative(root, p).split(sep).join('/');
            if (EXEMPT_FILES.has(rel)) continue;
            const source = readFileSync(p, 'utf8');
            const raw = source.split('\n');
            for (const h of findTouchHiddenReveals(codeLines(source, 'css').join('\n'))) {
                if (allowReason(raw[h.line - 1], raw[h.line - 2])?.reason || allowReason(raw[h.hideLine - 1], raw[h.hideLine - 2])?.reason) continue;
                hits.push({ file: WEB_SRC + rel, ...h, allowed: REVEAL_ALLOWLIST.has(`${rel} ${h.key}`) });
            }
        }
    };
    walk(root);
    return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
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
        } else if (a === '--all-hover') {
            opts.allHover = true;
        } else if (a === '--all-reveal') {
            opts.allReveal = true;
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
        console.log('usage: node scripts/dev/check-design-lint.mjs [--base <ref>] [--head <ref>] | --all-hover | --all-reveal');
        return;
    }
    if (opts.allHover) {
        const hits = scanAllHover();
        for (const h of hits) console.log(`${h.file}:${h.line}: [hover-unguarded] ${h.message}\n    > ${h.source}`);
        console.log(`check-design-lint --all-hover: ${hits.length} 处未守卫的 :hover`);
        process.exit(hits.length ? 1 : 0);
    }
    if (opts.allReveal) {
        const hits = scanAllReveal();
        for (const h of hits) console.log(`${h.file}:${h.line}: [hover-reveal-needs-touch${h.allowed ? ' · allowlist' : ''}] ${h.message}`);
        const fresh = hits.filter(h => !h.allowed).length;
        console.log(`check-design-lint --all-reveal: ${hits.length} 处（${fresh} 处不在 REVEAL_ALLOWLIST）`);
        process.exit(fresh ? 1 : 0);
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
