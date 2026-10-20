/**
 * B-035: data for the composer's `@` list. Same file list as ⌘P QuickOpen and
 * the Files panel (git ls-files through the session's bash RPC, cached per
 * machine:path) and the same ranker and recent-files history, so `@` and ⌘P
 * agree on what "the best match" is.
 *
 * The list is refreshed once per composer mount, the first time `@` opens —
 * not on every keystroke. A failed refresh (wrapper offline, not a git repo)
 * keeps any cached list; with no list at all the caller says so instead of
 * showing an empty popup.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { storage, useSession, useSessionProjectFiles } from '@/sync/storage';
import { getProjectFiles } from '@/sync/projectFiles';
import { createQuickOpenRanker, type QuickOpenMatch } from '../quickopen/quickOpenScore';
import { readQuickOpenHistory } from '../quickopen/quickOpenHistory';
import { FILE_MENTION_LIMIT } from './fileMention';

export interface FileMentionSuggestions {
    results: QuickOpenMatch[];
    /** first fetch still running and nothing cached yet */
    loading: boolean;
    /** fetched (or could not fetch) and there is no list to search */
    unavailable: boolean;
    /** `machine:cwd`, for recording a picked file in the shared recent history */
    project: string | null;
}

export function useFileMentionSuggestions(sessionId: string, query: string | null): FileMentionSuggestions {
    const session = useSession(sessionId);
    const machineId = session?.metadata?.machineId ?? null;
    const cwd = session?.metadata?.path ?? null;
    const project = machineId && cwd ? `${machineId}:${cwd}` : null;
    const projectFiles = useSessionProjectFiles(sessionId);
    const [status, setStatus] = useState<'idle' | 'loading' | 'done'>('idle');
    const active = query !== null;
    const started = useRef<string | null>(null);

    useEffect(() => {
        if (!active || started.current === sessionId) return;
        started.current = sessionId;
        const pathKey = storage.getState().getSessionPathKey(sessionId);
        if (!pathKey) { setStatus('done'); return; }
        setStatus('loading');
        // Not cancelled on re-render: the result belongs to the store, and
        // `status` is only stale if the session changed meanwhile.
        getProjectFiles(sessionId)
            .then((files) => { if (files) storage.getState().applyProjectFiles(pathKey, files); })
            .catch(() => { /* keep the cached list */ })
            .finally(() => { if (started.current === sessionId) setStatus('done'); });
    }, [active, sessionId]);
    useEffect(() => () => { started.current = null; }, []);

    const files = useMemo(() => projectFiles?.files.map((f) => f.fullPath) ?? [], [projectFiles]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read history when the list opens
    const history = useMemo(() => (project ? readQuickOpenHistory(project) : []), [project, active]);
    const ranker = useMemo(() => createQuickOpenRanker(), []);
    const results = useMemo(
        () => (query === null ? [] : ranker(query, files, history, FILE_MENTION_LIMIT)),
        [ranker, query, files, history],
    );
    return {
        results,
        loading: active && !projectFiles && status !== 'done',
        unavailable: active && !projectFiles && status === 'done',
        project,
    };
}
