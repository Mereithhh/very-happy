/**
 * B-891: the DOM side of transcript comments — selection → anchor, anchor →
 * Range. Offsets are positions in the quote source's textContent (all its
 * text nodes in document order), so a Range from a selection and the string
 * searched by locateAnchor always agree.
 */
import { QUOTE_SOURCE_SELECTOR, type QuotableSelection } from '../selectionQuoteRange';
import { buildAnchor, locateAnchor, type ChatAnnotation, type ChatAnnotationAnchor } from './chatAnnotations';

const MESSAGE_SELECTOR = '[data-message-seq]';

/** Server seq of the message a quote source belongs to; null for unsent (optimistic) or seq-less rows. */
export function seqOf(source: Element): number | null {
    const raw = source.closest(MESSAGE_SELECTOR)?.getAttribute('data-message-seq');
    const seq = raw ? Number(raw) : NaN;
    return Number.isInteger(seq) && seq >= 0 ? seq : null;
}

/** The rendered quote sources of message `seq` (a record can render as several text blocks); empty when not in the DOM. */
export function sourcesForSeq(root: ParentNode, seq: number): Element[] {
    const out: Element[] = [];
    for (const message of root.querySelectorAll(`[data-message-seq="${seq}"]`)) {
        if (message.matches(QUOTE_SOURCE_SELECTOR)) out.push(message);
        else out.push(...message.querySelectorAll(QUOTE_SOURCE_SELECTOR));
    }
    return out;
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

/** Anchor for a quotable selection (see readQuotableSelection), or null (no seq yet, blank, too long). */
export function anchorFromSelection(quotable: Pick<QuotableSelection, 'source' | 'range' | 'text'>): ChatAnnotationAnchor | null {
    const { source, range } = quotable;
    const seq = seqOf(source);
    if (seq === null || !source.contains(range.startContainer) || !source.contains(range.endContainer)) return null;
    const text = source.textContent ?? '';
    const start = textOffset(source, range.startContainer, range.startOffset);
    const end = textOffset(source, range.endContainer, range.endOffset);
    return buildAnchor(seq, text, start, end, quotable.text);
}

export type Located = { kind: 'found'; range: Range } | { kind: 'stale' } | { kind: 'absent' };

/** absent = the message is not rendered right now (says nothing about the anchor); stale = rendered, quote gone. */
export function locateInDom(root: ParentNode, annotation: Pick<ChatAnnotation, 'seq' | 'quote' | 'prefix' | 'suffix' | 'start'>): Located {
    const sources = sourcesForSeq(root, annotation.seq);
    if (sources.length === 0) return { kind: 'absent' };
    for (const source of sources) {
        const at = locateAnchor(source.textContent ?? '', annotation);
        const range = at && rangeFromOffsets(source, at.start, at.end);
        if (range) return { kind: 'found', range };
    }
    return { kind: 'stale' };
}
