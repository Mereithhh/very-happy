/**
 * B-650 — pure core of the cross-session search panel (`specs/2026-10-projects.md` §7).
 *
 * Three sources, each answering on its own clock and merged here:
 *   1. metadata  — title, directory, machine, agent, project, tags (Web-local, instant);
 *   2. content   — every online machine's daemon `history-search` (B-549), mapped
 *                  back to very-happy sessions with `findTrackedSessionId`; hits no
 *                  session owns become "importable" rows;
 *   3. cache     — messages this tab already holds (`sessionMessages`), any harness.
 *
 * One row per session, ≤ MAX_ROW_SNIPPETS highlighted snippets. Matching mirrors the
 * daemon (`happy-cli/src/historySearch/query.ts`): whitespace terms, case-insensitive,
 * a session matches when every term occurs somewhere in it. `#tag` terms filter on
 * session tags (sidebar grammar). No React, no stores.
 */
import type { Message } from '@/sync/typesMessage';
import type { HistoryEntry } from '@/screens/sessions/claudeHistoryImport';
import type { HistorySearchHit } from '@/screens/sessions/historySearch';
import { parseSidebarQuery, tagsMatchSidebarQuery, type ParsedSidebarQuery } from '@/screens/sessions/sidebarSearch';

export const MAX_QUERY_TERMS = 8;
export const MAX_ROW_SNIPPETS = 3;
export const SNIPPET_CHARS = 160;
/** Per-machine budget for one `history-search` round (spec risk 6: ≤5 s). */
export const MACHINE_SEARCH_TIMEOUT_MS = 5_000;
export const CONTENT_RESULT_LIMIT = 30;

export type Range = [number, number];

export interface SessionSearchQuery {
    /** Lower-cased free-text terms (AND). */
    terms: string[];
    /** The sidebar `#tag` grammar half. */
    tagQuery: ParsedSidebarQuery;
    /** Free text as typed (sent to the daemons). */
    text: string;
}

export function parseSessionSearchQuery(input: string): SessionSearchQuery {
    const tagQuery = parseSidebarQuery(input);
    const terms = [...new Set(tagQuery.text.split(/\s+/).filter(Boolean))].slice(0, MAX_QUERY_TERMS);
    return { terms, tagQuery, text: terms.join(' ') };
}

export function sessionSearchQueryIsEmpty(q: SessionSearchQuery): boolean {
    return q.terms.length === 0 && q.tagQuery.tags.length === 0 && !q.tagQuery.requireAnyTag;
}

/** Non-overlapping, sorted ranges of every term occurrence in `text`. */
export function matchRanges(text: string, terms: readonly string[]): Range[] {
    if (!text || terms.length === 0) return [];
    const lower = text.toLowerCase();
    const raw: Range[] = [];
    for (const term of terms) {
        if (!term) continue;
        let at = lower.indexOf(term);
        while (at >= 0) {
            raw.push([at, at + term.length]);
            at = lower.indexOf(term, at + term.length);
        }
    }
    raw.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const out: Range[] = [];
    for (const r of raw) {
        const last = out[out.length - 1];
        if (last && r[0] < last[1]) { last[1] = Math.max(last[1], r[1]); continue; }
        out.push([r[0], r[1]]);
    }
    return out;
}

/** A window of `text` around its first match, with ranges re-based to the window. */
export function buildSnippet(text: string, terms: readonly string[], max = SNIPPET_CHARS): { text: string; ranges: Range[] } | null {
    const flat = text.replace(/\s+/g, ' ').trim();
    const ranges = matchRanges(flat, terms);
    if (ranges.length === 0) return null;
    const first = ranges[0][0];
    let start = Math.max(0, first - Math.floor(max / 3));
    let end = Math.min(flat.length, start + max);
    start = Math.max(0, end - max);
    const lead = start > 0 ? '…' : '';
    const tail = end < flat.length ? '…' : '';
    const body = flat.slice(start, end);
    const shifted = ranges
        .filter(([a, b]) => a >= start && b <= end)
        .map(([a, b]): Range => [a - start + lead.length, b - start + lead.length]);
    return { text: `${lead}${body}${tail}`, ranges: shifted };
}

// ───────────────────────────── message text ─────────────────────────────

export type SnippetRole = 'user' | 'assistant' | 'tool';

/** Searchable text of one cached message (sub-agent children included). */
export function messageSearchText(message: Message): { role: SnippetRole; text: string } | null {
    if (message.kind === 'user-text') {
        const text = message.displayText ?? message.text;
        return text ? { role: 'user', text } : null;
    }
    if (message.kind === 'agent-text') {
        if (message.isThinking || !message.text) return null;
        return { role: 'assistant', text: message.text };
    }
    if (message.kind === 'tool-call') {
        const parts: string[] = [];
        if (message.tool.description) parts.push(message.tool.description);
        const input = message.tool.input as Record<string, unknown> | null | undefined;
        if (input && typeof input === 'object') {
            for (const key of ['command', 'description', 'prompt', 'file_path', 'pattern', 'query', 'url']) {
                const v = input[key];
                if (typeof v === 'string' && v) parts.push(v);
            }
        }
        if (message.subagent?.result?.text) parts.push(message.subagent.result.text);
        return parts.length ? { role: 'tool', text: parts.join(' · ') } : null;
    }
    return null;
}

function flattenMessages(messages: readonly Message[], out: Message[] = []): Message[] {
    for (const m of messages) {
        out.push(m);
        if (m.kind === 'tool-call' && m.children.length) flattenMessages(m.children, out);
    }
    return out;
}

// ───────────────────────────── results ─────────────────────────────

export type SnippetSource = 'content' | 'cache';

export interface ResultSnippet {
    source: SnippetSource;
    role: SnippetRole;
    text: string;
    ranges: Range[];
    /** Cached hit: the exact message to jump to. */
    messageId?: string;
    /** Daemon hit: transcript timestamp (ms) — narrows the jump target. */
    at?: number;
}

export interface SessionSearchRow {
    /** `s:<sessionId>` or `i:<machineId>:<agent>:<id>` (importable). */
    key: string;
    sessionId?: string;
    /** Importable daemon conversation no very-happy session owns yet. */
    importable?: { machineId: string; entry: HistoryEntry };
    title: string;
    subtitle: string;
    titleRanges: Range[];
    subtitleRanges: Range[];
    updatedAt: number;
    archived: boolean;
    /** The title / directory / tags / project matched. */
    metaHit: boolean;
    snippets: ResultSnippet[];
}

/** What the metadata matcher needs to know about one session. */
export interface SessionSearchDoc {
    sessionId: string;
    title: string;
    /** Displayed second line (host · agent · path). */
    subtitle: string;
    /** Extra searchable words not displayed (project name, branch, machine name). */
    extra: string;
    tags: string[];
    updatedAt: number;
    archived: boolean;
}

/** Terms of `q` that occur in `haystack`. */
function termsIn(haystack: string, terms: readonly string[]): Set<string> {
    const lower = haystack.toLowerCase();
    return new Set(terms.filter((t) => lower.includes(t)));
}

/**
 * Source 1 + 3: one row per session whose title/metadata and cached messages,
 * together, contain every term (and that passes the `#tag` filter).
 * `cached` maps a session id to its messages (any order).
 */
export function searchLocalSessions(
    docs: readonly SessionSearchDoc[],
    cached: ReadonlyMap<string, readonly Message[]>,
    q: SessionSearchQuery,
): SessionSearchRow[] {
    const rows: SessionSearchRow[] = [];
    for (const doc of docs) {
        if (!tagsMatchSidebarQuery(doc.tags, q.tagQuery)) continue;
        const head = `${doc.title}\n${doc.subtitle}\n${doc.extra}\n${doc.tags.join(' ')}`;
        const found = termsIn(head, q.terms);
        const metaHit = q.terms.length > 0 && found.size > 0;
        const snippets: ResultSnippet[] = [];
        const messages = cached.get(doc.sessionId);
        if (messages && q.terms.length > 0) {
            // Newest first so the snippets shown are the most recent mentions.
            const flat = flattenMessages(messages).sort((a, b) => b.createdAt - a.createdAt);
            for (const m of flat) {
                const st = messageSearchText(m);
                if (!st) continue;
                const hit = termsIn(st.text, q.terms);
                if (hit.size === 0) continue;
                for (const t of hit) found.add(t);
                if (snippets.length < MAX_ROW_SNIPPETS) {
                    const sn = buildSnippet(st.text, q.terms);
                    if (sn) snippets.push({ source: 'cache', role: st.role, text: sn.text, ranges: sn.ranges, messageId: m.id });
                }
                if (found.size === q.terms.length && snippets.length >= MAX_ROW_SNIPPETS) break;
            }
        }
        if (found.size < q.terms.length) continue;
        rows.push({
            key: `s:${doc.sessionId}`,
            sessionId: doc.sessionId,
            title: doc.title,
            subtitle: doc.subtitle,
            titleRanges: matchRanges(doc.title, q.terms),
            subtitleRanges: matchRanges(doc.subtitle, q.terms),
            updatedAt: doc.updatedAt,
            archived: doc.archived,
            metaHit: metaHit || (q.terms.length === 0),
            snippets,
        });
    }
    return rows;
}

/** A daemon hit, already mapped to the session that owns it (or none). */
export interface MachineContentHit {
    machineId: string;
    hit: HistorySearchHit;
    /** very-happy session that drives / imported this conversation. */
    sessionId?: string;
    /** Display line for an importable row (machine · path). */
    subtitle: string;
}

function snippetKey(text: string): string {
    return text.replace(/…/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Merge source 2 into the local rows. A hit on a known session adds its
 * snippets (deduplicated against cached ones, cached first: they carry the
 * exact message id). A hit on a session the local pass dropped (a term only
 * the full transcript holds) creates that session's row from `docs`. A hit no
 * session owns becomes an importable row. Sessions filtered out by the panel's
 * filters (absent from `docs`) are skipped.
 */
export function mergeContentHits(
    local: readonly SessionSearchRow[],
    hits: readonly MachineContentHit[],
    docs: ReadonlyMap<string, SessionSearchDoc>,
    q: SessionSearchQuery,
    opts: { includeImportable: boolean },
): SessionSearchRow[] {
    const rows = new Map<string, SessionSearchRow>();
    for (const r of local) rows.set(r.key, { ...r, snippets: [...r.snippets] });
    for (const { machineId, hit, sessionId, subtitle } of hits) {
        const contentSnippets: ResultSnippet[] = hit.snippets.map((s) => ({
            source: 'content', role: s.role, text: s.text, ranges: s.ranges, ...(s.at !== undefined ? { at: s.at } : {}),
        }));
        let row: SessionSearchRow | undefined;
        if (sessionId) {
            row = rows.get(`s:${sessionId}`);
            if (!row) {
                const doc = docs.get(sessionId);
                if (!doc) continue; // filtered out (or hidden)
                if (!tagsMatchSidebarQuery(doc.tags, q.tagQuery)) continue;
                row = {
                    key: `s:${sessionId}`, sessionId, title: doc.title, subtitle: doc.subtitle,
                    titleRanges: matchRanges(doc.title, q.terms), subtitleRanges: matchRanges(doc.subtitle, q.terms),
                    updatedAt: doc.updatedAt, archived: doc.archived, metaHit: false, snippets: [],
                };
                rows.set(row.key, row);
            }
        } else {
            if (!opts.includeImportable || q.tagQuery.tags.length > 0 || q.tagQuery.requireAnyTag) continue;
            const key = `i:${machineId}:${hit.key}`;
            if (rows.has(key)) continue;
            row = {
                key, importable: { machineId, entry: hit.entry }, title: hit.title, subtitle,
                titleRanges: matchRanges(hit.title, q.terms), subtitleRanges: matchRanges(subtitle, q.terms),
                updatedAt: hit.entry.updatedAt, archived: false, metaHit: false, snippets: [],
            };
            rows.set(key, row);
        }
        const seen = new Set(row.snippets.map((s) => snippetKey(s.text)));
        for (const s of contentSnippets) {
            if (row.snippets.length >= MAX_ROW_SNIPPETS) break;
            const k = snippetKey(s.text);
            if ([...seen].some((x) => x.includes(k) || k.includes(x))) continue;
            seen.add(k);
            row.snippets.push(s);
        }
    }
    return rankRows([...rows.values()]);
}

/** Title hits first, then rows with content snippets, then the rest; newest first within a tier. Importable rows last. */
export function rankRows(rows: SessionSearchRow[]): SessionSearchRow[] {
    const tier = (r: SessionSearchRow) => (r.importable ? 3 : r.titleRanges.length > 0 ? 0 : r.snippets.length > 0 ? 1 : 2);
    return rows.sort((a, b) => tier(a) - tier(b) || b.updatedAt - a.updatedAt);
}

// ───────────────────────────── filters ─────────────────────────────

export type StatusFilter = 'all' | 'live' | 'waiting' | 'archived';
export type TimeFilter = 'any' | '1d' | '7d' | '30d';

export interface SessionSearchFilters {
    status: StatusFilter;
    agent: string | null;
    machineId: string | null;
    projectId: string | null;
    time: TimeFilter;
}

export const EMPTY_FILTERS: SessionSearchFilters = { status: 'all', agent: null, machineId: null, projectId: null, time: 'any' };

const TIME_WINDOW_MS: Record<Exclude<TimeFilter, 'any'>, number> = { '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

export interface FilterableSession {
    archived: boolean;
    waiting: boolean;
    agent: string | null;
    machineId: string | null;
    projectId: string | null;
    updatedAt: number;
}

export function passesFilters(s: FilterableSession, f: SessionSearchFilters, now: number): boolean {
    if (f.status === 'live' && s.archived) return false;
    if (f.status === 'archived' && !s.archived) return false;
    if (f.status === 'waiting' && (s.archived || !s.waiting)) return false;
    if (f.agent && s.agent !== f.agent) return false;
    if (f.machineId && s.machineId !== f.machineId) return false;
    if (f.projectId && s.projectId !== f.projectId) return false;
    if (f.time !== 'any' && now - s.updatedAt > TIME_WINDOW_MS[f.time]) return false;
    return true;
}

/** Content hits that pass the machine / agent / time filters before mapping. Importable rows have no
 *  project / status, so any project or non-default status filter drops them. */
export function importableAllowed(f: SessionSearchFilters): boolean {
    return f.projectId === null && (f.status === 'all' || f.status === 'live');
}

export function daemonAgentFor(f: SessionSearchFilters): 'claude' | 'codex' | undefined | null {
    if (!f.agent) return undefined;
    if (f.agent === 'claude' || f.agent === 'codex') return f.agent;
    return null; // pi / gemini / …: the daemon index has nothing for this agent
}

// ───────────────────────────── coverage ─────────────────────────────

export type MachineSearchState =
    | 'pending'
    | 'searched'
    | 'indexing'
    | 'offline'
    | 'unsupported'
    | 'failed';

export interface MachineCoverage {
    machineId: string;
    name: string;
    state: MachineSearchState;
    /** indexing progress, when known */
    progress?: { done: number; total: number };
}

export interface CoverageSummary {
    offline: MachineCoverage[];
    unsupported: MachineCoverage[];
    failed: MachineCoverage[];
    indexing: MachineCoverage[];
    pending: MachineCoverage[];
    searched: MachineCoverage[];
    /** Content results are known to be missing something. */
    incomplete: boolean;
}

export function summarizeCoverage(list: readonly MachineCoverage[]): CoverageSummary {
    const by = (s: MachineSearchState) => list.filter((m) => m.state === s);
    const summary = {
        offline: by('offline'), unsupported: by('unsupported'), failed: by('failed'),
        indexing: by('indexing'), pending: by('pending'), searched: by('searched'),
    };
    return {
        ...summary,
        incomplete: summary.offline.length + summary.unsupported.length + summary.failed.length + summary.indexing.length > 0,
    };
}

/**
 * Which machines the content fan-out must account for: every machine that
 * owns at least one searchable session, plus every online machine (its
 * untracked history can still be imported). A long-dead machine with no
 * sessions left is not "missing results".
 */
export function machinesInScope<M extends { id: string; active: boolean }>(
    machines: readonly M[],
    sessionMachineIds: ReadonlySet<string>,
): M[] {
    return machines.filter((m) => m.active || sessionMachineIds.has(m.id));
}

// ───────────────────────────── shortcut ─────────────────────────────

/**
 * ⌘⇧F (mac) / Ctrl+Shift+F elsewhere. On non-mac platforms Ctrl+Shift+F is the
 * web terminal's own find (termSearch.ts `matchTermSearchChord`), so inside a
 * terminal it is left to the terminal. `code`, not `key`: layouts change `key`.
 */
export function matchSessionSearchChord(
    e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string },
    isMac: boolean,
    inTerminal: boolean,
): boolean {
    if (e.code !== 'KeyF' || e.altKey || !e.shiftKey) return false;
    if (isMac) return e.metaKey && !e.ctrlKey;
    return e.ctrlKey && !e.metaKey && !inTerminal;
}
