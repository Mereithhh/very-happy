/**
 * Editable drafts (B-642) — pure rules. I/O lives in editableDraftsStore.ts,
 * design and trade-offs in specs/2026-10-editable-drafts.md.
 *
 * The model marks copy the user may want to edit/send with a ```draft fence
 * (optional title after the language). The web renders it as an editable box;
 * edits persist in account KV (one key per draft) and ride along with the
 * user's next message as an `<edited_drafts>` block (final text + line diff).
 */

/** KV prefix; full key = `vh.draft.v1.<sessionId>.<draftKey>`. */
export const DRAFT_KV_PREFIX = 'vh.draft.v1.';
/** fence language that marks a draft */
export const DRAFT_FENCE_LANG = 'draft';
/** a draft body larger than this is clamped (KV value cap is 256 KiB) */
export const DRAFT_TEXT_MAX_CHARS = 60_000;
export const DRAFT_TITLE_MAX_CHARS = 120;
/** past this the diff is omitted from the context block (the full text still goes) */
export const DRAFT_DIFF_MAX_CHARS = 4_000;
/** LCS table cells above which we stop diffing line by line */
const DIFF_MAX_CELLS = 250_000;

export interface DraftRecord {
    v: 1;
    sessionId: string;
    /** `<seq>.<hash>` — see draftKeyFor */
    key: string;
    title?: string;
    /** the model's text, as rendered */
    original: string;
    /** the current (edited) text */
    text: string;
    /** the version the model last saw: `original`, then whatever was last attached */
    base: string;
    /** text at the moment the user removed the chip; attaching resumes once `text` moves on */
    skip?: string;
    updatedAt: number;
}

/** 32-bit FNV-1a over UTF-16 code units, base36 — stable on every client. */
export function hashDraftText(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

/**
 * Stable identity of a draft fence. `seq` is the server's per-session message
 * sequence (identical on every device — the agent-text `id` is random per
 * client); the hash separates several fences inside one message.
 */
export function draftKeyFor(seq: number, original: string): string {
    return `${seq}.${hashDraftText(original)}`;
}

export function draftKvKey(sessionId: string, key: string): string {
    return `${DRAFT_KV_PREFIX}${sessionId}.${key}`;
}

export function draftSessionPrefix(sessionId: string): string {
    return `${DRAFT_KV_PREFIX}${sessionId}.`;
}

/** KV key → { sessionId, key }, or null for any other key. */
export function parseDraftKvKey(kvKey: string): { sessionId: string; key: string } | null {
    if (!kvKey.startsWith(DRAFT_KV_PREFIX)) return null;
    const rest = kvKey.slice(DRAFT_KV_PREFIX.length);
    const m = /^([^.]+)\.(\d+\.[0-9a-z]+)$/.exec(rest);
    return m ? { sessionId: m[1], key: m[2] } : null;
}

/** Title from the fence info string (`draft <title>`), trimmed and clipped. */
export function draftTitleFromMeta(meta: unknown): string | undefined {
    if (typeof meta !== 'string') return undefined;
    const title = meta.trim();
    if (!title) return undefined;
    return title.length > DRAFT_TITLE_MAX_CHARS ? title.slice(0, DRAFT_TITLE_MAX_CHARS) : title;
}

export function parseDraftRecord(raw: unknown): DraftRecord | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (r.v !== 1) return null;
    if (typeof r.sessionId !== 'string' || typeof r.key !== 'string') return null;
    if (typeof r.original !== 'string' || typeof r.text !== 'string' || typeof r.base !== 'string') return null;
    if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt)) return null;
    const rec: DraftRecord = {
        v: 1,
        sessionId: r.sessionId,
        key: r.key,
        original: r.original,
        text: r.text.slice(0, DRAFT_TEXT_MAX_CHARS),
        base: r.base,
        updatedAt: r.updatedAt,
    };
    if (typeof r.title === 'string' && r.title) rec.title = r.title.slice(0, DRAFT_TITLE_MAX_CHARS);
    if (typeof r.skip === 'string') rec.skip = r.skip;
    return rec;
}

/** LWW by updatedAt; a tie keeps the local copy (our own echo). */
export function pickDraftWinner(local: DraftRecord, remote: DraftRecord): DraftRecord {
    return remote.updatedAt > local.updatedAt ? remote : local;
}

export function isDraftEdited(rec: DraftRecord): boolean {
    return rec.text !== rec.original;
}

/** Edited since the model last saw it, and not dismissed at this exact text. */
export function isDraftPending(rec: DraftRecord): boolean {
    return rec.text !== rec.base && rec.text !== rec.skip;
}

/** A fresh record for the first edit of a fence. */
export function newDraftRecord(input: { sessionId: string; key: string; original: string; title?: string; text: string; now: number }): DraftRecord {
    return {
        v: 1,
        sessionId: input.sessionId,
        key: input.key,
        ...(input.title ? { title: input.title } : {}),
        original: input.original,
        text: input.text.slice(0, DRAFT_TEXT_MAX_CHARS),
        base: input.original,
        updatedAt: input.now,
    };
}

/* ── line diff ──────────────────────────────────────────────────────────── */

/**
 * Compact line diff: only changed lines, `- ` / `+ ` prefixed, in order.
 * Common prefix/suffix are trimmed before an LCS over the middle; a middle too
 * large for the table degrades to "all old out, all new in" (still correct).
 */
export function diffDraftLines(before: string, after: string): string {
    if (before === after) return '';
    const a = before.split('\n');
    const b = after.split('\n');
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    const out: string[] = [];
    if (midA.length * midB.length > DIFF_MAX_CELLS) {
        for (const line of midA) out.push(`- ${line}`);
        for (const line of midB) out.push(`+ ${line}`);
        return out.join('\n');
    }
    const n = midA.length;
    const m = midB.length;
    // lcs[i][j] = LCS length of midA[i..] and midB[j..]
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && midA[i] === midB[j]) {
            i++;
            j++;
        } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
            out.push(`- ${midA[i++]}`); // deletions before insertions, like a unified diff
        } else {
            out.push(`+ ${midB[j++]}`);
        }
    }
    return out.join('\n');
}

/* ── the context block attached to the next user message ────────────────── */

const BLOCK_OPEN = '<edited_drafts';
const BLOCK_CLOSE = '</edited_drafts>';
/**
 * Anchored at the END of the message and greedy: whatever the draft bodies
 * contain (even a literal closing tag), the block is everything from its
 * opening tag to the end. The user's own text always comes first.
 */
const BLOCK_RE = /\n*<edited_drafts(?: count="(\d+)")?>[\s\S]*<\/edited_drafts>\s*$/;

function escapeAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, ' ');
}

export interface AttachedDraft {
    title?: string;
    /** what the model last saw */
    base: string;
    /** the text being attached */
    text: string;
}

/** Serialise drafts into the block appended to the user's message. */
export function buildEditedDraftsBlock(drafts: readonly AttachedDraft[]): string {
    if (drafts.length === 0) return '';
    const parts = [
        `${BLOCK_OPEN} count="${drafts.length}">`,
        'The user edited these drafts you wrote earlier. Each <final> is now the authoritative text; use it instead of your earlier version.',
    ];
    for (const d of drafts) {
        parts.push(d.title ? `<draft title="${escapeAttr(d.title)}">` : '<draft>');
        const diff = diffDraftLines(d.base, d.text);
        if (diff && diff.length <= DRAFT_DIFF_MAX_CHARS) parts.push('<diff>', diff, '</diff>');
        else if (diff) parts.push('<diff omitted="too large" />');
        parts.push('<final>', d.text, '</final>', '</draft>');
    }
    parts.push(BLOCK_CLOSE);
    return parts.join('\n');
}

/** The user's text plus the block (block always last; see BLOCK_RE). */
export function appendEditedDrafts(body: string, block: string): string {
    if (!block) return body;
    const trimmed = body.replace(/\s+$/, '');
    return trimmed ? `${trimmed}\n\n${block}` : block;
}

export function hasEditedDraftsBlock(text: string): boolean {
    return text.indexOf(BLOCK_OPEN) !== -1 && BLOCK_RE.test(text);
}

/**
 * Split a USER message into the user's own text and the attached block.
 * Only ever applied to user messages — agent prose may discuss the tag.
 */
export function splitEditedDrafts(text: string): { body: string; block: string; count: number } {
    if (text.indexOf(BLOCK_OPEN) === -1) return { body: text, block: '', count: 0 };
    const m = BLOCK_RE.exec(text);
    if (!m) return { body: text, block: '', count: 0 };
    const body = text.slice(0, m.index).replace(/\s+$/, '');
    const block = text.slice(m.index).replace(/^\n+/, '').replace(/\s+$/, '');
    const count = m[1] ? Number(m[1]) : 1;
    return { body, block, count };
}

export function stripEditedDrafts(text: string): string {
    return splitEditedDrafts(text).body;
}

/** Short label for a chip: the title, else the first non-empty line, clipped. */
export function draftChipLabel(rec: Pick<DraftRecord, 'title' | 'text' | 'original'>, max = 40): string {
    const source = rec.title || rec.text || rec.original;
    const line = source.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
