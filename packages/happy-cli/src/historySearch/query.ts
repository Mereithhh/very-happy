/**
 * B-549 — search the in-memory index. Linear scan, case-insensitive literal
 * substring match, every query word must occur somewhere in the session
 * (title, cwd or a message). Works the same for English and CJK text — no
 * tokenizer to get wrong. Measured on 23 M chars of real history: < 10 ms for
 * a query that matches nothing (the worst case).
 */
import type { FileRecord } from './store';
import type { HistorySearchAgent, IndexedMessage } from './extract';

export const MAX_QUERY_CHARS = 200;
export const MAX_QUERY_TERMS = 8;
export const MAX_RESULTS = 50;
export const DEFAULT_RESULTS = 20;
export const MAX_SNIPPETS = 3;
export const SNIPPET_CHARS = 180;
const SNIPPET_LEAD = 50;

export type ParsedQuery = { terms: RegExp[]; phrase: RegExp | null; raw: string };

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `null` for an empty query. */
export function parseQuery(input: unknown): ParsedQuery | null {
    if (typeof input !== 'string') return null;
    const raw = input.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS).trim();
    if (!raw) return null;
    const words = [...new Set(raw.split(' ').filter(Boolean).map((w) => w.toLowerCase()))].slice(0, MAX_QUERY_TERMS);
    const terms = words.map((w) => new RegExp(escapeRegExp(w), 'i'));
    const phrase = words.length > 1 ? new RegExp(raw.split(' ').map(escapeRegExp).join('\\s+'), 'i') : null;
    return { terms, phrase, raw };
}

export type SnippetRole = 'user' | 'assistant';
export type SearchSnippet = { role: SnippetRole; text: string; at?: number; ranges: Array<[number, number]> };

export type SearchResult = {
    agent: HistorySearchAgent;
    id: string;
    title: string;
    firstPrompt: string;
    summary?: string;
    cwd: string;
    startedAt: number;
    updatedAt: number;
    sizeBytes: number;
    gitBranch?: string;
    entrypoint?: string;
    originator?: string;
    /** Messages containing at least one query word. */
    matchCount: number;
    snippets: SearchSnippet[];
};

/** Highlight ranges of every query word in `text` (merged, sorted). */
export function matchRanges(text: string, terms: RegExp[]): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    for (const term of terms) {
        const global = new RegExp(term.source, 'gi');
        let m: RegExpExecArray | null;
        while ((m = global.exec(text)) !== null) {
            if (m[0].length === 0) { global.lastIndex += 1; continue; }
            ranges.push([m.index, m.index + m[0].length]);
            if (ranges.length > 64) break;
        }
    }
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<[number, number]> = [];
    for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
        else merged.push([r[0], r[1]]);
    }
    return merged;
}

/** A ~SNIPPET_CHARS window around the first hit, whitespace collapsed, with
 *  `…` where it was cut, and highlight ranges computed on the final text. */
export function buildSnippet(text: string, terms: RegExp[]): { text: string; ranges: Array<[number, number]> } {
    let first = -1;
    for (const term of terms) {
        const m = term.exec(text);
        if (m && (first === -1 || m.index < first)) first = m.index;
    }
    const start = Math.max(0, (first === -1 ? 0 : first) - SNIPPET_LEAD);
    const end = Math.min(text.length, start + SNIPPET_CHARS);
    let window = text.slice(start, end).replace(/\s+/g, ' ');
    if (start > 0) window = `…${window.trimStart()}`;
    if (end < text.length) window = `${window.trimEnd()}…`;
    return { text: window, ranges: matchRanges(window, terms) };
}

export type SearchOptions = { limit?: number; agent?: HistorySearchAgent };
export type SearchOutput = { results: SearchResult[]; truncated: boolean; total: number };

function titleOf(record: FileRecord): string {
    return record.meta.summary || record.meta.firstPrompt || '';
}

/**
 * Search. One result per conversation id (the same Claude id can sit in two
 * project directories; the most recently written file wins, as in the import
 * list). Order: sessions containing the whole phrase first, then newest.
 */
export function searchRecords(records: Iterable<FileRecord>, query: ParsedQuery, options: SearchOptions = {}): SearchOutput {
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? DEFAULT_RESULTS), MAX_RESULTS));
    // Newest file per (agent, id).
    const newest = new Map<string, FileRecord>();
    for (const r of records) {
        if (r.meta.skip || !r.meta.cwd) continue;
        if (options.agent && r.agent !== options.agent) continue;
        if (!r.meta.firstPrompt && !r.meta.summary) continue;
        const key = `${r.agent}:${r.id}`;
        const prev = newest.get(key);
        if (!prev || r.mtimeMs > prev.mtimeMs) newest.set(key, r);
    }

    type Scored = { record: FileRecord; phrase: boolean; matched: Array<{ msg: IndexedMessage; hits: number; index: number }> };
    const scored: Scored[] = [];
    for (const record of newest.values()) {
        const title = titleOf(record);
        const head = `${title}\n${record.meta.firstPrompt ?? ''}\n${record.meta.cwd ?? ''}`;
        const found = new Array<boolean>(query.terms.length).fill(false);
        query.terms.forEach((t, i) => { if (t.test(head)) found[i] = true; });
        const matched: Scored['matched'] = [];
        let phrase = query.phrase ? query.phrase.test(head) : true;
        record.msgs.forEach((msg, index) => {
            let n = 0;
            query.terms.forEach((t, i) => {
                if (t.test(msg.x)) { n += 1; found[i] = true; }
            });
            if (n > 0) {
                matched.push({ msg, hits: n, index });
                if (!phrase && query.phrase && query.phrase.test(msg.x)) phrase = true;
            }
        });
        if (!found.every(Boolean)) continue;
        scored.push({ record, phrase, matched });
    }

    scored.sort((a, b) => (Number(b.phrase) - Number(a.phrase)) || (b.record.mtimeMs - a.record.mtimeMs));
    const results = scored.slice(0, limit).map(({ record, matched }): SearchResult => {
        const picks = matched
            .slice()
            .sort((a, b) => (b.hits - a.hits) || (a.index - b.index))
            .slice(0, MAX_SNIPPETS)
            .sort((a, b) => a.index - b.index);
        const meta = record.meta;
        return {
            agent: record.agent,
            id: record.id,
            title: titleOf(record),
            firstPrompt: meta.firstPrompt ?? meta.summary ?? '',
            ...(meta.summary ? { summary: meta.summary } : {}),
            cwd: meta.cwd ?? '',
            startedAt: meta.startedAt ?? 0,
            updatedAt: Math.round(record.mtimeMs),
            sizeBytes: record.size,
            ...(meta.gitBranch ? { gitBranch: meta.gitBranch } : {}),
            ...(meta.entrypoint ? { entrypoint: meta.entrypoint } : {}),
            ...(meta.originator ? { originator: meta.originator } : {}),
            matchCount: matched.length,
            snippets: picks.map(({ msg }) => {
                const s = buildSnippet(msg.x, query.terms);
                return {
                    role: msg.r === 'u' ? 'user' : 'assistant',
                    text: s.text,
                    ...(msg.t !== undefined ? { at: msg.t } : {}),
                    ranges: s.ranges,
                };
            }),
        };
    });
    return { results, truncated: scored.length > limit, total: scored.length };
}
