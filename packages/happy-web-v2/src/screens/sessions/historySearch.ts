/**
 * B-549 — pure helpers for full-text search over a machine's Claude Code /
 * Codex history. The daemon's `history-search` RPC indexes the transcripts
 * locally and answers with matching conversations plus snippets; this module
 * parses that payload tolerantly, turns a hit into the same `HistoryEntry` the
 * import flow already consumes, finds the very-happy session that already owns
 * a hit (open it instead of importing a second copy), and splits snippets into
 * highlighted segments. No React, no stores.
 */
import type { Session } from '@/sync/storageTypes';
import { daemonRpcFlagSupported } from '@/sync/closedTerminals';
import type { HistoryAgent, HistoryEntry } from './claudeHistoryImport';

/** Does this machine's CURRENT daemon run answer `history-search`? Same
 *  trust rule as every connect-stamped flag (`detectedAt >= startedAt`): an
 *  old daemon never stamps it, a downgraded one carries a stale stamp. */
export function historySearchSupported(daemonState: unknown): boolean {
    return daemonRpcFlagSupported(daemonState, 'historySearch');
}

export type HistorySearchState = 'idle' | 'indexing' | 'ready' | 'error';

export interface HistorySearchStatus {
    state: HistorySearchState;
    filesTotal: number;
    filesDone: number;
    sessions: number;
    textChars: number;
    maxTextChars: number;
    evicted: number;
    lastIndexedAt?: number;
    error?: string;
}

export interface HistorySearchSnippet {
    role: 'user' | 'assistant';
    text: string;
    at?: number;
    ranges: Array<[number, number]>;
}

export interface HistorySearchHit {
    /** Row key: `<agent>:<id>`. */
    key: string;
    entry: HistoryEntry;
    title: string;
    matchCount: number;
    snippets: HistorySearchSnippet[];
}

export interface HistorySearchPayload {
    status: HistorySearchStatus;
    hits: HistorySearchHit[];
    truncated: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES: readonly HistorySearchState[] = ['idle', 'indexing', 'ready', 'error'];

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function parseHistorySearchStatus(raw: unknown): HistorySearchStatus {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    // A state this web does not know (a newer daemon) reads as idle: never
    // spin a poll loop on a guess.
    const state = STATES.includes(s.state as HistorySearchState) ? (s.state as HistorySearchState) : 'idle';
    return {
        state,
        filesTotal: num(s.filesTotal),
        filesDone: num(s.filesDone),
        sessions: num(s.sessions),
        textChars: num(s.textChars),
        maxTextChars: num(s.maxTextChars),
        evicted: num(s.evicted),
        ...(typeof s.lastIndexedAt === 'number' && Number.isFinite(s.lastIndexedAt) ? { lastIndexedAt: s.lastIndexedAt } : {}),
        ...(str(s.error) ? { error: str(s.error) } : {}),
    };
}

function parseRanges(raw: unknown, length: number): Array<[number, number]> {
    if (!Array.isArray(raw)) return [];
    const out: Array<[number, number]> = [];
    for (const r of raw) {
        if (!Array.isArray(r) || r.length !== 2) continue;
        const [a, b] = r;
        if (typeof a !== 'number' || typeof b !== 'number' || !Number.isInteger(a) || !Number.isInteger(b)) continue;
        if (a < 0 || b <= a || b > length) continue;
        out.push([a, b]);
    }
    out.sort((x, y) => x[0] - y[0]);
    // Drop overlaps instead of trusting the sender to have merged them.
    const clean: Array<[number, number]> = [];
    for (const r of out) {
        const last = clean[clean.length - 1];
        if (last && r[0] < last[1]) continue;
        clean.push(r);
    }
    return clean;
}

function parseSnippet(raw: unknown): HistorySearchSnippet | null {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    if (typeof s.text !== 'string' || !s.text) return null;
    const role = s.role === 'assistant' ? 'assistant' : s.role === 'user' ? 'user' : null;
    if (!role) return null;
    return {
        role,
        text: s.text,
        ...(typeof s.at === 'number' && Number.isFinite(s.at) ? { at: s.at } : {}),
        ranges: parseRanges(s.ranges, s.text.length),
    };
}

function parseHit(raw: unknown): HistorySearchHit | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const agent: HistoryAgent | null = r.agent === 'claude' || r.agent === 'codex' ? r.agent : null;
    if (!agent || typeof r.id !== 'string' || !UUID_RE.test(r.id)) return null;
    const cwd = str(r.cwd);
    if (!cwd) return null;
    const id = r.id.toLowerCase();
    const summary = str(r.summary);
    const firstPrompt = str(r.firstPrompt) ?? summary ?? '';
    const title = str(r.title) ?? summary ?? firstPrompt;
    if (!title) return null;
    const common = {
        id,
        cwd,
        firstPrompt,
        ...(summary ? { summary } : {}),
        startedAt: num(r.startedAt),
        updatedAt: num(r.updatedAt),
        sizeBytes: num(r.sizeBytes),
        ...(str(r.entrypoint) ? { entrypoint: str(r.entrypoint) } : {}),
        ...(str(r.gitBranch) ? { gitBranch: str(r.gitBranch) } : {}),
    };
    const entry: HistoryEntry = agent === 'claude'
        ? { ...common, agent: 'claude', claudeSessionId: id }
        : { ...common, agent: 'codex', codexThreadId: id, ...(str(r.originator) ? { originator: str(r.originator) } : {}) };
    const snippets = Array.isArray(r.snippets)
        ? r.snippets.map(parseSnippet).filter((s): s is HistorySearchSnippet => s !== null)
        : [];
    return { key: `${agent}:${id}`, entry, title, matchCount: num(r.matchCount), snippets };
}

/** Tolerant parse of the `history-search` payload: malformed rows are
 *  dropped, duplicates (same agent + id) keep the first. */
export function parseHistorySearch(raw: unknown): HistorySearchPayload {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const seen = new Set<string>();
    const hits: HistorySearchHit[] = [];
    if (Array.isArray(r.results)) {
        for (const item of r.results) {
            const hit = parseHit(item);
            if (!hit || seen.has(hit.key)) continue;
            seen.add(hit.key);
            hits.push(hit);
        }
    }
    return { status: parseHistorySearchStatus(r.status), hits, truncated: r.truncated === true };
}

/**
 * The very-happy session that already owns this conversation: one whose own
 * conversation it is (`claudeSessionId` / `codexThreadId`), else one that
 * imported it (`importedFrom…`). Newest wins. `undefined` → offer import.
 */
export function findTrackedSessionId(
    agent: HistoryAgent,
    id: string,
    sessions: ReadonlyArray<Pick<Session, 'id' | 'metadata' | 'updatedAt'>>,
): string | undefined {
    const wanted = id.toLowerCase();
    let own: Pick<Session, 'id' | 'updatedAt'> | undefined;
    let imported: Pick<Session, 'id' | 'updatedAt'> | undefined;
    for (const s of sessions) {
        const m = s.metadata;
        if (!m) continue;
        const ownId = agent === 'claude' ? m.claudeSessionId : m.codexThreadId;
        const sourceId = agent === 'claude' ? m.importedFromClaudeSessionId : m.importedFromCodexThreadId;
        if (typeof ownId === 'string' && ownId.toLowerCase() === wanted) {
            if (!own || s.updatedAt > own.updatedAt) own = s;
        } else if (typeof sourceId === 'string' && sourceId.toLowerCase() === wanted) {
            if (!imported || s.updatedAt > imported.updatedAt) imported = s;
        }
    }
    return (own ?? imported)?.id;
}

export type HighlightSegment = { text: string; hit: boolean };

/** Split a snippet into plain / highlighted runs (ranges already validated). */
export function splitHighlights(text: string, ranges: ReadonlyArray<[number, number]>): HighlightSegment[] {
    const out: HighlightSegment[] = [];
    let at = 0;
    for (const [a, b] of ranges) {
        if (a < at || b > text.length) continue;
        if (a > at) out.push({ text: text.slice(at, a), hit: false });
        out.push({ text: text.slice(a, b), hit: true });
        at = b;
    }
    if (at < text.length) out.push({ text: text.slice(at), hit: false });
    return out;
}

/** Keep polling while the daemon reports a pass in progress — but never
 *  while the index is being cleared (a poll then would rebuild it). */
export function shouldPollHistorySearch(status: HistorySearchStatus, opts: { clearing?: boolean } = {}): boolean {
    return !opts.clearing && status.state === 'indexing';
}

/** Interval between polls while indexing. */
export const HISTORY_SEARCH_POLL_MS = 2_000;
/** Debounce between keystrokes and the RPC. */
export const HISTORY_SEARCH_DEBOUNCE_MS = 300;
