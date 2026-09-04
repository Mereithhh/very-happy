/**
 * `<Markdown>` 用的 rehype 插件与 URL 策略（B-354）。
 *
 * 抽成独立模块有两个理由：① 它们是纯的 hast 变换，可以脱离 React 测；
 * ② 插件数组的 identity 必须**稳定**——react-markdown 每次渲染都会重跑整条 unified
 * 管线，插件数组换 identity 只会白白让 `useMemo` 失效。
 */
import { visit } from 'unist-util-visit';
import type { Element, Root, Text } from 'hast';

/** 正文里允许的 URL scheme。相对 URL 一律放行（本站内跳转）。 */
const SAFE_URL_RE = /^(https?:|mailto:)/i;

/**
 * 收窄 react-markdown 的 `defaultUrlTransform`。
 *
 * 默认实现已经挡掉 `javascript:` 和 `data:`，但它是**黑名单式**的，`tel:`、`xmpp:`、
 * `intent:` 之类照样放行。agent 正文是不可信内容，这里换成白名单：不认识的 scheme
 * 一律吐空串（react-markdown 会渲染成 `href=""`，点了什么也不会发生）。
 */
export function safeUrlTransform(url: string): string {
    const trimmed = url.trim();
    if (trimmed.length === 0) return '';
    // Protocol-relative: no scheme to check, but it still leaves the site. The
    // rest of this function is a whitelist; this closes the one hole in it.
    if (trimmed.startsWith('//')) return '';
    // A scheme is present only when the colon comes before any / ? #
    const colon = trimmed.indexOf(':');
    if (colon === -1) return trimmed;                       // relative
    const firstDelimiter = trimmed.search(/[/?#]/);
    if (firstDelimiter !== -1 && firstDelimiter < colon) return trimmed;  // e.g. ./a:b
    return SAFE_URL_RE.test(trimmed) ? trimmed : '';
}

const BR_RE = /<br\s*\/?>/i;

/**
 * 表格单元格里的 `<br>` 变成真换行。
 *
 * 我们（有意地）不解析原始 HTML，所以 `| 第一行<br>第二行 |` 默认会被转义成可见的
 * `&lt;br&gt;`。但**这是 LLM 在表格里换行的主要写法**，GitHub 会渲染它——不处理的话
 * 「GFM 表格渲染正确」这句话在最常见的例子上就是假的。放行范围严格限制在 `td`/`th`
 * 内的文本节点，其它地方的 `<br>` 仍然是可见字面量（正文里写 `<br>` 通常是在讨论它）。
 */
export function rehypeTableCellBreaks() {
    return (tree: Root) => {
        visit(tree, 'element', (node: Element) => {
            if (node.tagName !== 'td' && node.tagName !== 'th') return;
            // The whole cell subtree, not just its direct children: `**a<br>b**`
            // puts the text inside <strong>, and bold + line break is a common
            // combination in a generated table.
            splitBreaks(node);
        });
    };
}

function splitBreaks(node: Element) {
    const next: Element['children'] = [];
    let changed = false;
    for (const child of node.children) {
        const value = child.type === 'text' ? child.value
            : (child as { type: string; value?: string }).type === 'raw' ? (child as { value: string }).value
                : null;
        if (value === null || !BR_RE.test(value)) {
            // Same judgement as the fenced-example rule in optionsBlock.ts: text
            // inside a code span is content, not markup. GitHub keeps `x<br>y`
            // literal there too.
            if (child.type === 'element' && child.tagName !== 'code' && child.tagName !== 'pre') {
                splitBreaks(child);
            }
            next.push(child);
            continue;
        }
        changed = true;
        const parts = value.split(/<br\s*\/?>/gi);
        parts.forEach((part, index) => {
            if (index > 0) next.push({ type: 'element', tagName: 'br', properties: {}, children: [] });
            if (part.length > 0) next.push({ type: 'text', value: part } as Text);
        });
    }
    if (changed) node.children = next;
}

/**
 * `thead` 里的 `th` 补 `scope="col"`（B-357）。
 *
 * `mdast-util-to-hast` 不加它，于是屏幕阅读器读不出「这一格属于哪一列」——GFM 表格
 * 只有列头，一行 rehype 就能修好。
 */
export function rehypeTableScope() {
    return (tree: Root) => {
        visit(tree, 'element', (node: Element) => {
            if (node.tagName !== 'thead') return;
            visit(node, 'element', (cell: Element) => {
                if (cell.tagName === 'th') cell.properties = { ...cell.properties, scope: 'col' };
            });
        });
    };
}

/**
 * 把每个文本节点包成 `<vh-text>`，交给 `components['vh-text']` 渲染。
 *
 * 这是 B-145「正文里的文件路径可点」的接入点。**关键设计约束：这个插件与路径白名单
 * 无关**——白名单由叶子组件自己从 context 里读。如果把白名单塞进插件参数，agent 每
 * Write/Edit 一个文件就会让整条 transcript 全量重 parse（白名单正是长会话里最频繁变化
 * 的东西），而 react-markdown 没有内部 parse 缓存。实测：这样接之后白名单变化
 * `parse +0 / leaf +N`。
 *
 * 两处刻意跳过：
 *  - `<a>` 子树：路径链接是 `<button>`，`<button>` 嵌在 `<a>` 里是非法嵌套，而且
 *    `stopPropagation` 只挡 React 合成事件、浏览器仍会走 anchor 默认导航（B-145 finding 3）。
 *  - `<pre>` 子树：代码块整体交给 `CodeView`，`components.pre` 直接从 hast 节点取文本，
 *    包一层会打断那次提取。**行内 `<code>` 不跳过**——「已写入 `docs/report.md`」是
 *    claude 写路径的默认形式，这正是 finding 1 坏掉的地方。
 */
export function rehypeTextLeaves() {
    return (tree: Root) => {
        // A manual walk, not `visit`: wrapping a text node inserts a NEW element
        // whose child is that same text node, and `visit` would walk straight
        // into it and wrap it again — forever (RangeError on the first render).
        const walk = (node: Root | Element) => {
            const next: Array<Root['children'][number]> = [];
            let changed = false;
            for (const child of node.children) {
                // Whitespace-only nodes are skipped on purpose: hast keeps the
                // newlines BETWEEN <table>/<thead>/<tr> as text children, and
                // wrapping those in an element produces invalid table nesting
                // (React logs "whitespace text nodes cannot be a child of
                // <table>" for every row). They can never contain a path either.
                if (child.type === 'text' && child.value.trim().length > 0) {
                    changed = true;
                    next.push({ type: 'element', tagName: 'vh-text', properties: {}, children: [child] } as Element);
                    continue;
                }
                if (child.type === 'element' && child.tagName !== 'a' && child.tagName !== 'pre') {
                    walk(child);
                }
                next.push(child);
            }
            if (changed) node.children = next as Element['children'];
        };
        walk(tree);
    };
}
