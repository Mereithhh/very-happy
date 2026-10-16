/**
 * 流式草稿的顶层块切分（B-610）。
 *
 * react-markdown 没有 parse 缓存，草稿每次变长都要整篇重 parse——长回答越往后每个 token
 * 越贵。这里把源码切成**顶层块**，`Markdown` 对已完成的块各自 memo，只重 parse 最后一块。
 *
 * **正确性契约**：`blocks.join('') === source`；逐块渲染、块间补一个 `'\n'` 文本节点，得到的
 * DOM 与整篇渲染**逐字节一致**（`markdownBlocks.test.tsx` 用语料比对）。拿不准一律**并进
 * 尾块**：少切只损失性能，切错是渲染错。
 *
 * 唯一的切点：**一个空行之后、第 0 列开始的行 L 之前**。CommonMark 里能跨过这种位置的
 * 顶层结构只有四种，逐一排除：
 *  - **围栏代码块**。第 0 列开的围栏按规范精确跟踪（缩进 ≤3 的同字符、不短于开栏、无 info
 *    的行才闭合）；未闭合则延续到文末。列表项里的围栏（`- ```` 或缩进的 ```` ``` ````）记下
 *    栏所在列 c，只在**恰好**缩进 c 的闭栏处关；出现缩进 < c 的非空行（列表项可能已结束、
 *    该行可能另开顶层围栏）或其他拿不准的形状就**放弃**——此后全部并进尾块。
 *  - **HTML 块 1–5 型**（`<script|pre|style|textarea`、`<!--`、`<?`、`<!X`、`<![CDATA[`），结束
 *    条件不是空行，跟踪到结束标记。其余以 `<` 开头的行按 6/7 型处理（空行结束）；其中再出现
 *    围栏或 1–5 型开头时（可能其实是段落被打断）放弃。
 *  - **列表**：空行后第 0 列又是列表标记，且本块出现过列表 ⇒ 可能是同一个松散列表的下一项，
 *    不切（切开会变成两个 `<ul>`，松紧也会变）。
 *  - 引用块、表格、段落、setext 标题都在空行处结束，L 一定开启新的顶层块。
 *
 * **跨块引用**：链接引用定义（`[x]: url`）与脚注（`[^x]`）让一处定义影响其他块，检测到就
 * 返回单块，等价于整篇渲染。
 */

const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const BLANK = /^[ \t]*$/;
/**
 * A fence-looking line, optionally behind list markers: `[indent][markers]fence info`.
 * Group 1 = everything before the fence (its length is the fence column), 2 = fence, 3 = info.
 */
const FENCE_LIKE = /^((?: *(?:[-*+]|\d{1,9}[.)]) {1,4})* *)(`{3,}|~{3,})(.*)$/;
/** Link reference definition, possibly inside a blockquote/list prefix. */
const LINK_REF_DEF = /^[ \t>*+\-\d.)]*\[[^\]\n]*[^\]\s][^\]\n]*\]:/m;
const FOOTNOTE = /\[\^[^\]\s]+\]/;

/** HTML block types 1–5: start pattern → end pattern (the end may sit on the opening line). */
const HTML_BLOCKS: ReadonlyArray<readonly [RegExp, RegExp]> = [
    [/^<(?:script|pre|style|textarea)(?:[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
    [/^<!--/, /-->/],
    [/^<\?/, /\?>/],
    [/^<![A-Za-z]/, />/],
    [/^<!\[CDATA\[/, /\]\]>/],
];

/** True when the source uses a construct whose meaning crosses block boundaries. */
export function hasCrossBlockReferences(source: string): boolean {
    return LINK_REF_DEF.test(source) || FOOTNOTE.test(source);
}

interface FenceInfo { char: string; len: number; col: number }

function parseFence(line: string): (FenceInfo & { info: string }) | null {
    const m = FENCE_LIKE.exec(line);
    if (!m) return null;
    // A backtick fence's info string may not contain a backtick (```a``` is inline code).
    if (m[2][0] === '`' && m[3].includes('`')) return null;
    return { char: m[2][0], len: m[2].length, col: m[1].length, info: m[3] };
}

function indentOf(line: string): number {
    let i = 0;
    while (line[i] === ' ') i += 1;
    return i;
}

type State =
    | { kind: 'normal' }
    | { kind: 'fence'; fence: FenceInfo }
    | { kind: 'html'; end: RegExp }
    | { kind: 'htmlish' }   // type 6/7 html (or a paragraph that looks like it): ends at a blank line
    | { kind: 'gaveUp' };

/**
 * Split `source` into top-level markdown blocks. Lossless: `result.join('') === source`.
 * Returns `[source]` when cross-block references are present.
 */
export function splitMarkdownBlocks(source: string): string[] {
    if (source.length === 0) return [];
    if (hasCrossBlockReferences(source)) return [source];

    const blocks: string[] = [];
    let blockStart = 0;
    let state: State = { kind: 'normal' };
    let afterBlank = false;
    let sawList = false;
    let sawContent = false;

    for (let pos = 0; pos < source.length && state.kind !== 'gaveUp';) {
        const nl = source.indexOf('\n', pos);
        const next = nl === -1 ? source.length : nl + 1;
        const line = source.slice(pos, nl === -1 ? source.length : nl).replace(/\r$/, '');
        const blank = BLANK.test(line);
        const lineStart = pos;
        pos = next;

        if (state.kind !== 'normal') {
            // Content of an already-open construct: never a split candidate.
            state = continueOpen(state, line, blank);
            // A blank line ending a type 6/7 html block is a real block boundary.
            afterBlank = blank && state.kind === 'normal';
            continue;
        }
        if (blank) {
            afterBlank = sawContent;
            continue;
        }
        const isList = LIST_MARKER.test(line);
        if (afterBlank && line[0] !== ' ' && line[0] !== '\t' && !(isList && sawList)) {
            blocks.push(source.slice(blockStart, lineStart));
            blockStart = lineStart;
            sawList = false;
        }
        if (isList) sawList = true;
        afterBlank = false;
        sawContent = true;
        state = open(line);
    }
    blocks.push(source.slice(blockStart));
    return blocks;
}

/** One line inside an open fence / html block. */
function continueOpen(state: State, line: string, blank: boolean): State {
    switch (state.kind) {
        case 'fence': {
            if (blank) return state;
            const { fence } = state;
            const indent = indentOf(line);
            if (fence.col > 0 && indent < fence.col) return { kind: 'gaveUp' };
            const close = parseFence(line);
            const closingShape = close !== null && close.col === indent && close.char === fence.char
                && close.len >= fence.len && BLANK.test(close.info);
            if (!closingShape) return state;
            if (fence.col === 0) return indent <= 3 ? { kind: 'normal' } : state;
            // A list-item fence closes exactly at its own column; a closing-looking
            // line elsewhere may or may not close it. Don't guess.
            return indent === fence.col ? { kind: 'normal' } : { kind: 'gaveUp' };
        }
        case 'html':
            return state.end.test(line) ? { kind: 'normal' } : state;
        case 'htmlish': {
            if (blank) return { kind: 'normal' };
            // Real type 6/7 html swallows these, but if it is really a paragraph
            // they would open a fence / html 1-5 block. Can't tell: give up.
            const t = line.trimStart();
            if (parseFence(line) || HTML_BLOCKS.some(([start]) => start.test(t))) return { kind: 'gaveUp' };
            return state;
        }
        default:
            return state;
    }
}

/** A non-blank line in normal state: does it open a fence or html block? */
function open(line: string): State {
    const fence = parseFence(line);
    if (fence) {
        // Fence column 0 is the exact, spec-tracked case. A deeper column means a
        // list-item fence (or an indented code line that happens to look like
        // one): tracked by column, abandoned on anything ambiguous. Tabs make the
        // column ambiguous.
        if (line.slice(0, fence.col).includes('\t')) return { kind: 'gaveUp' };
        return { kind: 'fence', fence: { char: fence.char, len: fence.len, col: fence.col } };
    }
    const indent = indentOf(line);
    const t = line.slice(indent);
    if (t[0] === '<') {
        const html = HTML_BLOCKS.find(([start]) => start.test(t));
        if (html) {
            // Only a column-0 opener is certainly top level; an indented one may
            // live in a list item whose end we cannot see here.
            if (indent > 0) return { kind: 'gaveUp' };
            const rest = t.replace(html[0], '');
            return html[1].test(rest) ? { kind: 'normal' } : { kind: 'html', end: html[1] };
        }
        return { kind: 'htmlish' };
    }
    return { kind: 'normal' };
}
