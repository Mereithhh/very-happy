/**
 * B-554: fetch one changed file's diff against HEAD through the existing
 * `bash` session RPC (every CLI version has it — no new RPC).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionBash } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { gitDiffCommand, parseGitUnifiedDiff, shellFlavorFor, type ReviewRow } from './gitDiff';
import { createSlotPool, type SlotTicket } from './slotPool';

export type GitFileDiffState =
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'refused'; reason: DiffLoadRefusal }
    | { phase: 'binary' }
    /** `ignoreWhitespace`: these rows came from `git diff -w` — never re-anchor comments against them (review 中1). */
    | { phase: 'ready'; rows: ReviewRow[]; loadedAt: number; ignoreWhitespace: boolean };

/**
 * Rows comments may be re-anchored (and written back) against, or null.
 * Decided by the rows' OWN `-w` flag, not the toggle: just after the toggle
 * is switched off the pane still shows (and would persist against) the old
 * whitespace-blind rows until the reload lands (review 中1).
 */
export function rowsForReanchor(state: GitFileDiffState, allowed: boolean): ReviewRow[] | null {
    return allowed && state.phase === 'ready' && !state.ignoreWhitespace ? state.rows : null;
}

/** Message key for a path the shell quoting refused (shown in the pane). */
export type DiffLoadRefusal = 'control' | 'quote' | 'unknown-platform';

export function platformOfSession(sessionId: string): string | null {
    const st = storage.getState();
    const session = st.sessions[sessionId];
    const machineId = session?.metadata?.machineId;
    return session?.metadata?.os ?? (machineId ? st.machines[machineId]?.metadata?.platform : undefined) ?? null;
}

/**
 * B-572: at most this many diff RPCs in flight per page — "expand all" in the
 * review tab must not fire one `bash` per changed file at once.
 */
export const MAX_CONCURRENT_DIFF_LOADS = 4;
const diffSlots = createSlotPool(MAX_CONCURRENT_DIFF_LOADS);

async function loadDiff(sessionId: string, path: string, untracked: boolean, ignoreWhitespace: boolean, ticket: SlotTicket): Promise<GitFileDiffState | null> {
    const cwd = storage.getState().sessions[sessionId]?.metadata?.path;
    if (!cwd) return { phase: 'error', message: 'no working directory' };
    const cmd = gitDiffCommand(path, { untracked, flavor: shellFlavorFor(platformOfSession(sessionId)), ignoreWhitespace });
    if (!cmd.ok) return { phase: 'refused', reason: cmd.reason };
    // A queued load whose pane went away / was superseded never runs.
    if (!(await diffSlots.acquire(ticket))) return null;
    let res: Awaited<ReturnType<typeof sessionBash>>;
    try {
        res = await sessionBash(sessionId, { command: cmd.command, cwd, timeout: 10000 });
    } finally {
        diffSlots.release();
    }
    // `diff --no-index` exits 1 when the files differ (always, vs the null
    // device); the RPC reports that as a failure but still carries stdout.
    const noIndexDiffers = untracked && res.exitCode === 1 && (res.stdout ?? '').startsWith('diff --git')
        && !/maxBuffer/i.test(`${res.error ?? ''} ${res.stderr ?? ''}`);
    if (!res.success && !noIndexDiffers) return { phase: 'error', message: (res.stderr || res.error || 'git diff failed').trim().slice(0, 300) };
    const parsed = parseGitUnifiedDiff(res.stdout ?? '');
    if (parsed.binary) return { phase: 'binary' };
    return { phase: 'ready', rows: parsed.rows, loadedAt: Date.now(), ignoreWhitespace };
}

export function useGitFileDiff(sessionId: string, path: string, untracked: boolean, active: boolean, refreshToken?: unknown, ignoreWhitespace = false) {
    const [state, setState] = useState<GitFileDiffState>({ phase: 'loading' });
    const generation = useRef(0);
    const ticket = useRef<SlotTicket | null>(null);
    const reload = useCallback(async () => {
        const mine = ++generation.current;
        if (ticket.current) diffSlots.cancel(ticket.current);
        const own: SlotTicket = { cancelled: false };
        ticket.current = own;
        setState((prev) => (prev.phase === 'ready' ? prev : { phase: 'loading' }));
        let next: GitFileDiffState | null;
        try {
            next = await loadDiff(sessionId, path, untracked, ignoreWhitespace, own);
        } catch (error) {
            next = { phase: 'error', message: error instanceof Error ? error.message : 'failed' };
        }
        if (next && mine === generation.current) setState(next);
    }, [sessionId, path, untracked, ignoreWhitespace]);
    // Fetch when the tab becomes visible, on identity change, and when the
    // panel's git status was refreshed; a hidden tab keeps its last diff.
    useEffect(() => {
        if (active) void reload();
    }, [active, reload, refreshToken]);
    useEffect(() => () => {
        generation.current++;
        if (ticket.current) diffSlots.cancel(ticket.current);
    }, []);
    return { state, reload };
}
