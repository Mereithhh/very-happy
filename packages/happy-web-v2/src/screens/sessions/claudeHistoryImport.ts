/**
 * B-290 — pure helpers for "Import a Claude Code conversation".
 *
 * Claude Code (CLI, desktop app, SDK) stores every conversation under
 * `~/.claude/projects/<cwd>/<id>.jsonl` on the machine. The daemon's
 * `claude-list-history` RPC scans those files; this module parses the payload
 * tolerantly, hides the conversations very-happy already tracks, and shapes a
 * row for the picker. No React, no stores — everything the modal decides is a
 * function of (payload, known sessions, query), so it is unit-tested here and
 * the component stays wiring.
 */
import type { Session } from '@/sync/storageTypes';

export interface ClaudeHistoryEntry {
    claudeSessionId: string;
    cwd: string;
    firstPrompt: string;
    summary?: string;
    startedAt: number;
    updatedAt: number;
    sizeBytes: number;
    entrypoint?: string;
    gitBranch?: string;
    version?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tolerant parse of the `claude-list-history` RPC payload: only well-formed
 *  rows survive (the daemon validates too; this guards a garbled relay or an
 *  older daemon answering a different shape). */
export function parseClaudeHistory(raw: unknown): ClaudeHistoryEntry[] {
    const list = (raw as any)?.entries;
    if (!Array.isArray(list)) return [];
    const out: ClaudeHistoryEntry[] = [];
    for (const e of list) {
        if (!e || typeof e !== 'object') continue;
        const { claudeSessionId, cwd, firstPrompt, summary, startedAt, updatedAt, sizeBytes, entrypoint, gitBranch, version } = e as Record<string, unknown>;
        if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) continue;
        if (typeof cwd !== 'string' || !cwd) continue;
        const prompt = typeof firstPrompt === 'string' ? firstPrompt : '';
        const title = typeof summary === 'string' && summary ? summary : undefined;
        if (!prompt && !title) continue;
        out.push({
            claudeSessionId: claudeSessionId.toLowerCase(),
            cwd,
            firstPrompt: prompt || title || '',
            ...(title ? { summary: title } : {}),
            startedAt: typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : 0,
            updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0,
            sizeBytes: typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) ? sizeBytes : 0,
            ...(typeof entrypoint === 'string' && entrypoint ? { entrypoint } : {}),
            ...(typeof gitBranch === 'string' && gitBranch ? { gitBranch } : {}),
            ...(typeof version === 'string' && version ? { version } : {}),
        });
    }
    return out;
}

/** Claude conversation ids very-happy already owns on any machine: a session's
 *  own conversation, plus the source of a fork/import (the copy is tracked, so
 *  offering the original again would just create a second copy). Lower-cased
 *  so the daemon-side exclude and the client-side filter agree. */
export function trackedClaudeSessionIds(sessions: ReadonlyArray<Pick<Session, 'metadata'>>): string[] {
    const ids = new Set<string>();
    for (const s of sessions) {
        const own = s.metadata?.claudeSessionId;
        if (typeof own === 'string' && UUID_RE.test(own)) ids.add(own.toLowerCase());
        const source = s.metadata?.importedFromClaudeSessionId;
        if (typeof source === 'string' && UUID_RE.test(source)) ids.add(source.toLowerCase());
    }
    return [...ids];
}

/** Rows the picker shows: untracked, newest first, optionally narrowed by a
 *  case-insensitive query over title, first prompt, cwd and branch. */
export function filterImportableHistory(
    entries: ReadonlyArray<ClaudeHistoryEntry>,
    tracked: ReadonlyArray<string>,
    query = '',
): ClaudeHistoryEntry[] {
    const hidden = new Set(tracked.map((id) => id.toLowerCase()));
    const q = query.trim().toLowerCase();
    return entries
        .filter((e) => !hidden.has(e.claudeSessionId))
        .filter((e) => !q || [e.summary ?? '', e.firstPrompt, e.cwd, e.gitBranch ?? ''].some((v) => v.toLowerCase().includes(q)))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** What the row is called: Claude Code's own summary when it has one, else the
 *  first prompt. */
export function historyEntryTitle(entry: Pick<ClaudeHistoryEntry, 'summary' | 'firstPrompt'>): string {
    return entry.summary || entry.firstPrompt;
}

/** `~/code/app` when the cwd sits under the machine home, else the raw cwd. */
export function shortenCwd(cwd: string, homeDir?: string | null): string {
    if (!homeDir) return cwd;
    const home = homeDir.replace(/\/+$/, '');
    if (!home) return cwd;
    if (cwd === home) return '~';
    return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

/** Human label for Claude Code's `entrypoint` field. */
export function historyEntrypointLabel(entrypoint: string | undefined): string | undefined {
    if (!entrypoint) return undefined;
    switch (entrypoint) {
        case 'cli': return 'claude CLI';
        case 'sdk-cli': return 'SDK';
        case 'remote_mobile': return 'claude.ai';
        default: return entrypoint;
    }
}

/** Compact size for the meta line: `12 KB`, `3.4 MB`. */
export function formatHistorySize(bytes: number): string {
    if (!(bytes > 0)) return '0 KB';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Per-row state of a batch import run (B-292). */
export type ImportRowState =
    | { kind: 'idle' }
    | { kind: 'queued' }
    | { kind: 'running' }
    | { kind: 'done'; sessionId: string }
    | { kind: 'failed'; message?: string };

export type ImportRunSummary = {
    total: number;
    done: number;
    failed: number;
    /** The only session imported in this run, when there is exactly one. */
    singleSessionId?: string;
};

/** Click/Enter toggles a row's membership in the selection. */
export function toggleImportSelection(current: ReadonlyArray<string>, id: string): string[] {
    return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
}

/** Selection minus rows that are no longer offered (imported, or filtered out
 *  by a new search): the footer count must never promise a row the user cannot
 *  see any more. */
export function pruneImportSelection(
    current: ReadonlyArray<string>,
    visible: ReadonlyArray<{ claudeSessionId: string }>,
): string[] {
    const ids = new Set(visible.map((e) => e.claudeSessionId));
    return current.filter((id) => ids.has(id));
}

/** Import order = the order shown, so progress reads top-down. */
export function orderSelectionForImport(
    selected: ReadonlyArray<string>,
    visible: ReadonlyArray<ClaudeHistoryEntry>,
): ClaudeHistoryEntry[] {
    const wanted = new Set(selected);
    return visible.filter((e) => wanted.has(e.claudeSessionId));
}

export function summarizeImportRun(states: ReadonlyMap<string, ImportRowState>): ImportRunSummary {
    let done = 0;
    let failed = 0;
    let singleSessionId: string | undefined;
    for (const state of states.values()) {
        if (state.kind === 'done') {
            done += 1;
            singleSessionId = done === 1 ? state.sessionId : undefined;
        } else if (state.kind === 'failed') {
            failed += 1;
        }
    }
    return { total: states.size, done, failed, ...(singleSessionId ? { singleSessionId } : {}) };
}
