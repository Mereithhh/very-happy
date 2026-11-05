/**
 * B-891: in-place comments on selected transcript text (Codex-style). Pure:
 * anchor model, re-locating the anchor in the current text, record
 * validation, who may annotate and the message the comments become. The
 * persistence lives in chatAnnotationsStore.ts; the DOM side in
 * chatAnnotationDom.ts.
 *
 * Anchor = message id + the selected text exactly as it appears in that
 * message's rendered text (textContent of the quote source), with up to
 * ANCHOR_CONTEXT chars on each side and the old offset as a hint — the W3C
 * TextQuoteSelector shape. The DOM is never mutated (markers are an overlay,
 * the highlight is a CSS Custom Highlight), so re-rendering just means
 * locating the quote again. Not found ⇒ stale: the comment and its excerpt
 * are kept and still sent.
 */
import type { Session } from '@/sync/storageTypes';
import { isMirrorSession } from '@/assistant/assistantSession';
import { canSendAsGrantee, sessionAccess } from '@/app/sessionAccess';

export interface ChatAnnotation {
    id: string;
    messageId: string;
    /** the selection as it appears in the message's textContent — what is searched for */
    quote: string;
    prefix: string;
    suffix: string;
    /** offset of `quote` when it was written; ranks duplicates */
    start: number;
    /** what the agent reads: the selection as 「引用」 would quote it (code fenced) */
    excerpt: string;
    body: string;
    createdAt: number;
    updatedAt: number;
}

export type ChatAnnotationAnchor = Pick<ChatAnnotation, 'messageId' | 'quote' | 'prefix' | 'suffix' | 'start' | 'excerpt'>;

export const CHAT_ANNOTATIONS_MAX_PER_SESSION = 50;
export const CHAT_ANNOTATION_BODY_MAX = 4000;
export const CHAT_ANNOTATION_QUOTE_MAX = 4000;
export const ANCHOR_CONTEXT = 32;

/**
 * Anchor for `text.slice(start, end)`. Null when the selection is blank or
 * longer than CHAT_ANNOTATION_QUOTE_MAX (a comment on a whole essay is a
 * quote, not an annotation).
 */
export function buildAnchor(messageId: string, text: string, start: number, end: number, excerpt: string): ChatAnnotationAnchor | null {
    const a = Math.max(0, Math.min(start, end));
    const b = Math.min(text.length, Math.max(start, end));
    const quote = text.slice(a, b);
    if (!messageId || !quote.trim() || quote.length > CHAT_ANNOTATION_QUOTE_MAX) return null;
    return {
        messageId,
        quote,
        prefix: text.slice(Math.max(0, a - ANCHOR_CONTEXT), a),
        suffix: text.slice(b, b + ANCHOR_CONTEXT),
        start: a,
        excerpt: (excerpt.trim() ? excerpt : quote.trim()).slice(0, CHAT_ANNOTATION_QUOTE_MAX),
    };
}

/** Length of the common tail of `a` and `b`. */
function tailMatch(a: string, b: string): number {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
}

function headMatch(a: string, b: string): number {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
}

/**
 * Where the anchored quote is in `text` now, or null (stale). The old offset
 * wins when it still holds the quote (the common case: nothing moved, or text
 * was only appended below); otherwise every occurrence is ranked by how much
 * of the surrounding context still matches, then by distance to the old offset.
 */
export function locateAnchor(text: string, anchor: Pick<ChatAnnotation, 'quote' | 'prefix' | 'suffix' | 'start'>): { start: number; end: number } | null {
    const { quote } = anchor;
    if (!quote) return null;
    if (text.startsWith(quote, anchor.start)
        && tailMatch(text.slice(0, anchor.start), anchor.prefix) === anchor.prefix.length) {
        return { start: anchor.start, end: anchor.start + quote.length };
    }
    let best = -1;
    let bestScore = -1;
    let bestDistance = Infinity;
    for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) {
        const score = tailMatch(text.slice(Math.max(0, i - anchor.prefix.length), i), anchor.prefix)
            + headMatch(text.slice(i + quote.length, i + quote.length + anchor.suffix.length), anchor.suffix);
        const distance = Math.abs(i - anchor.start);
        if (score > bestScore || (score === bestScore && distance < bestDistance)) {
            best = i;
            bestScore = score;
            bestDistance = distance;
        }
    }
    return best >= 0 ? { start: best, end: best + quote.length } : null;
}

/**
 * Who may annotate: whoever can send to the session — its owner, or a
 * driver/operator grantee. Viewers, mirrors (the terminal owns their input)
 * and unknown sessions get only 「引用」 (which itself needs a composer).
 */
export function canAnnotateSession(session: Session | null | undefined): boolean {
    if (!session || isMirrorSession(session)) return false;
    return sessionAccess(session) === 'owner' || canSendAsGrantee(session);
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isOffset = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Validate one persisted record; anything malformed is dropped by the caller. */
export function isChatAnnotation(v: unknown): v is ChatAnnotation {
    if (!v || typeof v !== 'object') return false;
    const c = v as Record<string, unknown>;
    return isStr(c.id) && !!c.id && isStr(c.messageId) && !!c.messageId
        && isStr(c.quote) && !!c.quote && c.quote.length <= CHAT_ANNOTATION_QUOTE_MAX
        && isStr(c.prefix) && c.prefix.length <= ANCHOR_CONTEXT
        && isStr(c.suffix) && c.suffix.length <= ANCHOR_CONTEXT
        && isOffset(c.start) && isStr(c.excerpt) && c.excerpt.length <= CHAT_ANNOTATION_QUOTE_MAX
        && isStr(c.body) && c.body.length <= CHAT_ANNOTATION_BODY_MAX
        && typeof c.createdAt === 'number' && typeof c.updatedAt === 'number';
}

export function parseChatAnnotations(raw: string | undefined | null): ChatAnnotation[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const seen = new Set<string>();
        return parsed.filter((c): c is ChatAnnotation => {
            if (!isChatAnnotation(c) || seen.has(c.id)) return false;
            seen.add(c.id);
            return true;
        }).slice(0, CHAT_ANNOTATIONS_MAX_PER_SESSION);
    } catch {
        return [];
    }
}

export function clampBody(body: string): string {
    return body.length > CHAT_ANNOTATION_BODY_MAX ? body.slice(0, CHAT_ANNOTATION_BODY_MAX) : body;
}

/** One line for lists and tooltips. */
export function excerptPreview(excerpt: string, max = 80): string {
    const line = excerpt.replace(/^`{3,}[^\n]*\n?/, '').replace(/\n?`{3,}\s*$/, '').replace(/\s+/g, ' ').trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The text actually sent: the comments in number order — each the quoted
 * excerpt then the note — followed by whatever the user typed. Comments go
 * first so the agent reads what they refer to before the instruction that
 * follows them. Only non-blank notes are sent.
 */
export function composeAnnotatedMessage(
    annotations: readonly ChatAnnotation[],
    userText: string,
    lang: 'zh' | 'en',
    stale: ReadonlySet<string> = new Set(),
): string {
    const notes = annotations.filter((a) => a.body.trim());
    const text = userText.trim();
    if (notes.length === 0) return text;
    const zh = lang === 'zh';
    const out: string[] = [zh
        ? `我对上面对话中的 ${notes.length} 处内容写了批注：`
        : `My comment${notes.length === 1 ? '' : 's'} on ${notes.length} passage${notes.length === 1 ? '' : 's'} above:`];
    notes.forEach((a, i) => {
        const head = stale.has(a.id)
            ? `${i + 1}. ${zh ? '（原文已变化，下面是批注时的内容）' : '(the original has changed; this is the text as it was)'}`
            : `${i + 1}.`;
        out.push('', head, ...a.excerpt.split('\n').map((line) => (line ? `> ${line}` : '>')), `${zh ? '批注' : 'Comment'}: ${a.body.trim()}`);
    });
    if (text) out.push('', text);
    return out.join('\n');
}
