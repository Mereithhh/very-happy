/**
 * B-554: fetch one changed file's diff against HEAD through the existing
 * `bash` / `readFile` session RPCs (every CLI version has both — no new RPC).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionBash, sessionReadFile } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { gitDiffCommand, parseGitUnifiedDiff, rowsForNewFile, type ReviewRow } from './gitDiff';

export type GitFileDiffState =
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'binary' }
    | { phase: 'ready'; rows: ReviewRow[]; loadedAt: number };

function decodeBase64Utf8(b64: string): string | null {
    try {
        const bin = atob(b64);
        if (bin.includes('\u0000')) return null;
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
        return null;
    }
}

async function loadDiff(sessionId: string, path: string, untracked: boolean): Promise<GitFileDiffState> {
    if (untracked) {
        const res = await sessionReadFile(sessionId, path);
        if (!res.success || typeof res.content !== 'string') return { phase: 'error', message: res.error || 'read failed' };
        const text = decodeBase64Utf8(res.content);
        if (text === null) return { phase: 'binary' };
        return { phase: 'ready', rows: rowsForNewFile(text), loadedAt: Date.now() };
    }
    const cwd = storage.getState().sessions[sessionId]?.metadata?.path;
    if (!cwd) return { phase: 'error', message: 'no working directory' };
    const res = await sessionBash(sessionId, { command: gitDiffCommand(path), cwd, timeout: 10000 });
    if (!res.success) return { phase: 'error', message: (res.stderr || res.error || 'git diff failed').trim().slice(0, 300) };
    const parsed = parseGitUnifiedDiff(res.stdout);
    if (parsed.binary) return { phase: 'binary' };
    return { phase: 'ready', rows: parsed.rows, loadedAt: Date.now() };
}

export function useGitFileDiff(sessionId: string, path: string, untracked: boolean, active: boolean, refreshToken?: unknown) {
    const [state, setState] = useState<GitFileDiffState>({ phase: 'loading' });
    const generation = useRef(0);
    const reload = useCallback(async () => {
        const mine = ++generation.current;
        setState((prev) => (prev.phase === 'ready' ? prev : { phase: 'loading' }));
        let next: GitFileDiffState;
        try {
            next = await loadDiff(sessionId, path, untracked);
        } catch (error) {
            next = { phase: 'error', message: error instanceof Error ? error.message : 'failed' };
        }
        if (mine === generation.current) setState(next);
    }, [sessionId, path, untracked]);
    // Fetch when the tab becomes visible, on identity change, and when the
    // panel's git status was refreshed; a hidden tab keeps its last diff.
    useEffect(() => {
        if (active) void reload();
    }, [active, reload, refreshToken]);
    useEffect(() => () => { generation.current++; }, []);
    return { state, reload };
}
