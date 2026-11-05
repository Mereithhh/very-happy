/**
 * B-891: the DOM side of transcript comments — selection → anchor, anchor →
 * Range. Offsets are positions in the quote source's textContent (all its
 * text nodes in document order), so a Range from a selection and the string
 * searched by locateAnchor always agree.
 */
import { QUOTE_SOURCE_SELECTOR, type QuotableSelection } from '../selectionQuoteRange';
import { buildAnchor, locateAnchor, type ChatAnnotation, type ChatAnnotationAnchor } from './chatAnnotations';

const MESSAGE_SELECTOR = '[data-message-id]';

export function messageIdOf(source: Element): string | null {
    return source.closest(MESSAGE_SELECTOR)?.getAttribute('data-message-id') || null;
}

/** The quote source of a rendered message, or null when it is not in the DOM (not loaded, folded). */
export function sourceForMessage(root: ParentNode, messageId: string): Element | null {
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(messageId) : messageId.replace(/["\\]/g, '\\$&');
    const message = root.querySelector(`[data-message-id="${escaped}"]`);
    if (!message) return null;
    return message.matches(QUOTE_SOURCE_SELECTOR) ? message : message.querySelector(QUOTE_SOURCE_SELECTOR);
}

/** Offset of the boundary point (node, offset) in `source.textContent`. */
export function textOffset(source: Node, node: Node, offset: number): number {
    const doc = source.ownerDocument ?? document;
    const range = doc.createRange();
    range.setStart(source, 0);
    range.setEnd(node, offset);
    return range.toString().length;
}

/** Text nodes under `node` in document order — the pieces textContent concatenates. */
function* textNodes(node: Node): Generator<Text> {
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) yield child as Text;
        else if (child.nodeType === 1 || child.nodeType === 11) yield* textNodes(child);
    }
}

/** A Range covering source.textContent[start, end), or null when the offsets fall outside it. */
export function rangeFromOffsets(source: Node, start: number, end: number): Range | null {
    const doc = source.ownerDocument ?? document;
    const range = doc.createRange();
    let pos = 0;
    let started = false;
    for (const n of textNodes(source)) {
        const len = n.data.length;
        if (!started && start < pos + len) {
            range.setStart(n, start - pos);
            started = true;
        }
        if (started && end <= pos + len) {
            range.setEnd(n, end - pos);
            return range;
        }
        pos += len;
    }
    return null;
}

/** Anchor for a quotable selection (see readQuotableSelection), or null (no message id, blank, too long). */
export function anchorFromSelection(quotable: Pick<QuotableSelection, 'source' | 'range' | 'text'>): ChatAnnotationAnchor | null {
    const { source, range } = quotable;
    const messageId = messageIdOf(source);
    if (!messageId || !source.contains(range.startContainer) || !source.contains(range.endContainer)) return null;
    const text = source.textContent ?? '';
    const start = textOffset(source, range.startContainer, range.startOffset);
    const end = textOffset(source, range.endContainer, range.endOffset);
    return buildAnchor(messageId, text, start, end, quotable.text);
}

export type Located = { kind: 'found'; range: Range } | { kind: 'stale' } | { kind: 'absent' };

/** absent = the message is not rendered right now (says nothing about the anchor); stale = rendered, quote gone. */
export function locateInDom(root: ParentNode, annotation: Pick<ChatAnnotation, 'messageId' | 'quote' | 'prefix' | 'suffix' | 'start'>): Located {
    const source = sourceForMessage(root, annotation.messageId);
    if (!source) return { kind: 'absent' };
    const at = locateAnchor(source.textContent ?? '', annotation);
    if (!at) return { kind: 'stale' };
    const range = rangeFromOffsets(source, at.start, at.end);
    return range ? { kind: 'found', range } : { kind: 'stale' };
}
