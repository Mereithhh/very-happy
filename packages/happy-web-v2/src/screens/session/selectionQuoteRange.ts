/**
 * B-577 —— 选中消息里的一段文字，引用到输入框。
 *
 * 判定参考 Orca `native-chat-quote-selection.ts`（MIT）：选区按「真正选到的文字」判断属于哪条
 * 消息，而不是看 range 端点——三击选段时浏览器把终点放到下一个块的开头，往往已在消息之外。
 *
 * 与 Orca 不同：跨多条消息不整体拒绝，只取**起点消息**内的部分（spec 2026-10-chat-reading-aids）。
 */

/** 可引用的正文：agent 回复的 markdown（不含其操作栏/时间）与用户气泡正文。思考、工具、事件行不算。 */
export const QUOTE_SOURCE_SELECTOR = '.msg-agent-text > .md, .msg-bubble-text';
const CODE_BODY_SELECTOR = '.cv-body';

export type QuotableSelection = {
    /** 已按规则处理过的文字（代码块内为 ``` 围栏包裹的原文），交给 quoteMessage 加 `> ` 前缀。 */
    text: string;
    /** 选区所在消息的正文元素。 */
    source: Element;
    /** 裁到起点消息后的 range（未裁剪时就是原 range 的副本）。 */
    range: Range;
    /** 选区越过了起点消息，已被裁短。 */
    clipped: boolean;
};

/** 代码块内选中：保持原文，用 ``` 包起来（引用规则再给每行加 `> `）。 */
export function fenceCode(text: string, lang: string | null): string {
    const body = text.replace(/\n+$/, '');
    const tag = lang && lang !== 'text' ? lang : '';
    // 原文里已有 ``` 时用更长的围栏，避免提前闭合。
    const longest = Math.max(2, ...[...body.matchAll(/`{3,}/g)].map((m) => m[0].length));
    const fence = '`'.repeat(longest + 1);
    return `${fence}${tag}\n${body}\n${fence}`;
}

/** 普通文字：去掉首尾空白行，保留中间的换行。 */
export function normalizeSelectedText(text: string): string {
    return text.replace(/ /g, ' ').replace(/^\s*\n/, '').replace(/\s+$/, '');
}

function elementOf(node: Node | null): Element | null {
    if (!node) return null;
    return node.nodeType === 1 ? node as Element : node.parentElement;
}

function selectableText(node: Text): boolean {
    const parent = node.parentElement;
    if (!parent) return false;
    try {
        return getComputedStyle(parent).userSelect !== 'none';
    } catch {
        return true;
    }
}

/** 选区里第一段真正被选中的文字所在的 quote source。 */
function firstSelectedSource(root: Element, range: Range): Element | null {
    const direct = elementOf(range.startContainer)?.closest(QUOTE_SOURCE_SELECTOR) ?? null;
    if (direct && root.contains(direct)) return direct;
    const container = range.commonAncestorContainer;
    const doc = container.ownerDocument ?? document;
    const walker = doc.createTreeWalker(container, 4 /* NodeFilter.SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        if (!range.intersectsNode(text)) continue;
        const start = text === range.startContainer ? range.startOffset : 0;
        const end = text === range.endContainer ? range.endOffset : text.length;
        if (start >= end || !text.data.slice(start, end).trim() || !selectableText(text)) continue;
        const source = text.parentElement?.closest(QUOTE_SOURCE_SELECTOR) ?? null;
        return source && root.contains(source) ? source : null;
    }
    return null;
}

/**
 * 读取当前选区：非空、单 range、起点在 `root` 内的某条可引用正文里才返回。
 * `selectionText` 由调用方传入（通常是 `selection.toString()`，它会在块之间插入换行，
 * range.toString 不会）；裁剪后的文字调用方需要重读选区（见 SelectionQuote）。
 */
export function readQuotableSelection(root: Element, selection: Selection | null): QuotableSelection | null {
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const original = selection.getRangeAt(0);
    // 起点在 transcript 之外（标题栏、输入框）：不是在引用对话。
    const startEl = elementOf(original.startContainer);
    if (!startEl || !(root.contains(startEl) || startEl.contains(root))) return null;
    const source = firstSelectedSource(root, original);
    if (!source) return null;
    const range = original.cloneRange();
    let clipped = false;
    if (!source.contains(range.startContainer)) {
        range.setStart(source, 0);
        clipped = true;
    }
    if (!source.contains(range.endContainer)) {
        range.setEnd(source, source.childNodes.length);
        clipped = true;
    }
    const raw = clipped ? range.toString() : selection.toString();
    if (!raw.trim()) return null;
    const startCode = elementOf(range.startContainer)?.closest(CODE_BODY_SELECTOR) ?? null;
    const endCode = elementOf(range.endContainer)?.closest(CODE_BODY_SELECTOR) ?? null;
    if (startCode && startCode === endCode) {
        const lang = startCode.parentElement?.querySelector('.cv-lang')?.textContent?.trim() ?? null;
        return { text: fenceCode(raw, lang), source, range, clipped };
    }
    return { text: normalizeSelectedText(raw), source, range, clipped };
}
