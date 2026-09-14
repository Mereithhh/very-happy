/**
 * B-290 / B-464 — pure helpers for "Import a conversation" (Claude Code and
 * Codex).
 *
 * Claude Code (CLI, desktop app, SDK) stores every conversation under
 * `~/.claude/projects/<cwd>/<id>.jsonl`; Codex (TUI, `codex exec`, desktop
 * app) under `~/.codex/sessions/<date>/rollout-*-<id>.jsonl`. The daemon's
 * `claude-list-history` / `codex-list-history` RPCs scan those files; this
 * module parses the payloads tolerantly, hides the conversations very-happy
 * already tracks, and shapes a row for the picker. No React, no stores —
 * everything the modal decides is a function of (payload, known sessions,
 * query), so it is unit-tested here and the component stays wiring.
 */
import type { Session } from '@/sync/storageTypes';

export type HistoryAgent = 'claude' | 'codex';

interface HistoryEntryBase {
    /** The source conversation id (lower-cased UUID) — the picker's row key. */
    id: string;
    agent: HistoryAgent;
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

export interface ClaudeHistoryEntry extends HistoryEntryBase {
    agent: 'claude';
    claudeSessionId: string;
}

export interface CodexHistoryEntry extends HistoryEntryBase {
    agent: 'codex';
    codexThreadId: string;
    /** `codex-tui` / `codex_exec` / `Codex Desktop` … as Codex writes it. */
    originator?: string;
}

export type HistoryEntry = ClaudeHistoryEntry | CodexHistoryEntry;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCommon(e: Record<string, unknown>): Omit<HistoryEntryBase, 'id' | 'agent'> | null {
    const { cwd, firstPrompt, summary, startedAt, updatedAt, sizeBytes, entrypoint, gitBranch, version } = e;
    if (typeof cwd !== 'string' || !cwd) return null;
    const prompt = typeof firstPrompt === 'string' ? firstPrompt : '';
    const title = typeof summary === 'string' && summary ? summary : undefined;
    if (!prompt && !title) return null;
    return {
        cwd,
        firstPrompt: prompt || title || '',
        ...(title ? { summary: title } : {}),
        startedAt: typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : 0,
        updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0,
        sizeBytes: typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) ? sizeBytes : 0,
        ...(typeof entrypoint === 'string' && entrypoint ? { entrypoint } : {}),
        ...(typeof gitBranch === 'string' && gitBranch ? { gitBranch } : {}),
        ...(typeof version === 'string' && version ? { version } : {}),
    };
}

/** Tolerant parse of the `claude-list-history` RPC payload: only well-formed
 *  rows survive (the daemon validates too; this guards a garbled relay or an
 *  older daemon answering a different shape). */
export function parseClaudeHistory(raw: unknown): ClaudeHistoryEntry[] {
    const list = (raw as any)?.entries;
    if (!Array.isArray(list)) return [];
    const out: ClaudeHistoryEntry[] = [];
    for (const e of list) {
        if (!e || typeof e !== 'object') continue;
        const { claudeSessionId } = e as Record<string, unknown>;
        if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) continue;
        const common = parseCommon(e as Record<string, unknown>);
        if (!common) continue;
        const id = claudeSessionId.toLowerCase();
        out.push({ id, agent: 'claude', claudeSessionId: id, ...common });
    }
    return out;
}

/** Same for `codex-list-history` (B-464). */
export function parseCodexHistory(raw: unknown): CodexHistoryEntry[] {
    const list = (raw as any)?.entries;
    if (!Array.isArray(list)) return [];
    const out: CodexHistoryEntry[] = [];
    for (const e of list) {
        if (!e || typeof e !== 'object') continue;
        const { codexThreadId, originator } = e as Record<string, unknown>;
        if (typeof codexThreadId !== 'string' || !UUID_RE.test(codexThreadId)) continue;
        const common = parseCommon(e as Record<string, unknown>);
        if (!common) continue;
        const id = codexThreadId.toLowerCase();
        out.push({
            id,
            agent: 'codex',
            codexThreadId: id,
            ...common,
            ...(typeof originator === 'string' && originator ? { originator } : {}),
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

/** Codex twin (B-464): a session's own thread (the fork, for imports) plus the
 *  original the import was forked from. */
export function trackedCodexThreadIds(sessions: ReadonlyArray<Pick<Session, 'metadata'>>): string[] {
    const ids = new Set<string>();
    for (const s of sessions) {
        const own = s.metadata?.codexThreadId;
        if (typeof own === 'string' && UUID_RE.test(own)) ids.add(own.toLowerCase());
        const source = s.metadata?.importedFromCodexThreadId;
        if (typeof source === 'string' && UUID_RE.test(source)) ids.add(source.toLowerCase());
    }
    return [...ids];
}

export function trackedHistoryIds(agent: HistoryAgent, sessions: ReadonlyArray<Pick<Session, 'metadata'>>): string[] {
    return agent === 'claude' ? trackedClaudeSessionIds(sessions) : trackedCodexThreadIds(sessions);
}

/** Rows the picker shows: untracked, newest first, optionally narrowed by a
 *  case-insensitive query over title, first prompt, cwd and branch. */
export function filterImportableHistory<T extends HistoryEntry>(
    entries: ReadonlyArray<T>,
    tracked: ReadonlyArray<string>,
    query = '',
): T[] {
    const hidden = new Set(tracked.map((id) => id.toLowerCase()));
    const q = query.trim().toLowerCase();
    return entries
        .filter((e) => !hidden.has(e.id))
        .filter((e) => !q || [e.summary ?? '', e.firstPrompt, e.cwd, e.gitBranch ?? ''].some((v) => v.toLowerCase().includes(q)))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** What the row is called: the tool's own summary/thread name when it has one,
 *  else the first prompt. */
export function historyEntryTitle(entry: Pick<HistoryEntryBase, 'summary' | 'firstPrompt'>): string {
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

/** Human label for where a Codex thread came from. The originator is the
 *  precise one (`codex-tui`, `codex_exec`, `Codex Desktop`); `source`
 *  (`cli` / `exec` / `vscode`) is the fallback for rollouts without it. */
export function codexSourceLabel(entry: Pick<CodexHistoryEntry, 'entrypoint' | 'originator'>): string | undefined {
    switch (entry.originator) {
        case 'codex-tui': return 'codex CLI';
        case 'codex_exec': return 'codex exec';
        case 'Codex Desktop': return 'Codex Desktop';
        case undefined: break;
        default: return entry.originator;
    }
    switch (entry.entrypoint) {
        case 'cli': return 'codex CLI';
        case 'exec': return 'codex exec';
        case 'vscode': return 'Codex app';
        case undefined: return undefined;
        default: return entry.entrypoint;
    }
}

export function historySourceLabel(entry: HistoryEntry): string | undefined {
    return entry.agent === 'claude' ? historyEntrypointLabel(entry.entrypoint) : codexSourceLabel(entry);
}

/** Compact size for the meta line: `12 KB`, `3.4 MB`. */
export function formatHistorySize(bytes: number): string {
    if (!(bytes > 0)) return '0 KB';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Per-row state of a batch import run (B-294). */
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
    visible: ReadonlyArray<{ id: string }>,
): string[] {
    const ids = new Set(visible.map((e) => e.id));
    return current.filter((id) => ids.has(id));
}

/** Import order = the order shown, so progress reads top-down. */
export function orderSelectionForImport<T extends { id: string }>(
    selected: ReadonlyArray<string>,
    visible: ReadonlyArray<T>,
): T[] {
    const wanted = new Set(selected);
    return visible.filter((e) => wanted.has(e.id));
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
