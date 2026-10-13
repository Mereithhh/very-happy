/**
 * B-554: fetch one changed file's diff against HEAD through the existing
 * `bash` session RPC (every CLI version has it — no new RPC).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionBash } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { gitDiffCommand, parseGitUnifiedDiff, shellFlavorFor, type ReviewRow } from './gitDiff';

export type GitFileDiffState =
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'refused'; reason: DiffLoadRefusal }
    | { phase: 'binary' }
    | { phase: 'ready'; rows: ReviewRow[]; loadedAt: number };

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
let inFlight = 0;
const waiting: Array<() => void> = [];
async function withDiffSlot<T>(run: () => Promise<T>): Promise<T> {
    if (inFlight >= MAX_CONCURRENT_DIFF_LOADS) await new Promise<void>((resolve) => waiting.push(resolve));
    inFlight++;
    try {
        return await run();
    } finally {
        inFlight--;
        waiting.shift()?.();
    }
}

async function loadDiff(sessionId: string, path: string, untracked: boolean, ignoreWhitespace: boolean): Promise<GitFileDiffState> {
    const cwd = storage.getState().sessions[sessionId]?.metadata?.path;
    if (!cwd) return { phase: 'error', message: 'no working directory' };
    const cmd = gitDiffCommand(path, { untracked, flavor: shellFlavorFor(platformOfSession(sessionId)), ignoreWhitespace });
    if (!cmd.ok) return { phase: 'refused', reason: cmd.reason };
    const res = await withDiffSlot(() => sessionBash(sessionId, { command: cmd.command, cwd, timeout: 10000 }));
    // `diff --no-index` exits 1 when the files differ (always, vs the null
    // device); the RPC reports that as a failure but still carries stdout.
    const noIndexDiffers = untracked && res.exitCode === 1 && (res.stdout ?? '').startsWith('diff --git')
        && !/maxBuffer/i.test(`${res.error ?? ''} ${res.stderr ?? ''}`);
    if (!res.success && !noIndexDiffers) return { phase: 'error', message: (res.stderr || res.error || 'git diff failed').trim().slice(0, 300) };
    const parsed = parseGitUnifiedDiff(res.stdout ?? '');
    if (parsed.binary) return { phase: 'binary' };
    return { phase: 'ready', rows: parsed.rows, loadedAt: Date.now() };
}

export function useGitFileDiff(sessionId: string, path: string, untracked: boolean, active: boolean, refreshToken?: unknown, ignoreWhitespace = false) {
    const [state, setState] = useState<GitFileDiffState>({ phase: 'loading' });
    const generation = useRef(0);
    const reload = useCallback(async () => {
        const mine = ++generation.current;
        setState((prev) => (prev.phase === 'ready' ? prev : { phase: 'loading' }));
        let next: GitFileDiffState;
        try {
            next = await loadDiff(sessionId, path, untracked, ignoreWhitespace);
        } catch (error) {
            next = { phase: 'error', message: error instanceof Error ? error.message : 'failed' };
        }
        if (mine === generation.current) setState(next);
    }, [sessionId, path, untracked, ignoreWhitespace]);
    // Fetch when the tab becomes visible, on identity change, and when the
    // panel's git status was refreshed; a hidden tab keeps its last diff.
    useEffect(() => {
        if (active) void reload();
    }, [active, reload, refreshToken]);
    useEffect(() => () => { generation.current++; }, []);
    return { state, reload };
}
