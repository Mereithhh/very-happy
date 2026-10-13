/**
 * B-572 (review 中3): working-tree content ids of the changed files, one
 * batched `git hash-object` per git-status refresh — so a "viewed" mark and
 * a section's diff follow the CONTENT, not just the +/- counts.
 */
import { useEffect, useState } from 'react';
import { sessionBash } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { shellFlavorFor } from '../diffComments/gitDiff';
import { platformOfSession } from '../diffComments/useGitFileDiff';
import { DELETED_CID, parseWorktreeIds, worktreeIdBatches, type ReviewFile } from './reviewAllModel';

export type WorktreeIds = { ids: Record<string, string>; settled: boolean };

export function useWorktreeIds(sessionId: string, files: readonly ReviewFile[], active: boolean, refreshToken: unknown): WorktreeIds {
    const [state, setState] = useState<WorktreeIds>({ ids: {}, settled: false });
    useEffect(() => {
        if (!active) return;
        let cancelled = false;
        (async () => {
            const cwd = storage.getState().sessions[sessionId]?.metadata?.path;
            const ids: Record<string, string> = {};
            for (const f of files) if (f.status === 'deleted') ids[f.path] = DELETED_CID;
            if (cwd) {
                for (const batch of worktreeIdBatches(files, shellFlavorFor(platformOfSession(sessionId)))) {
                    try {
                        const res = await sessionBash(sessionId, { command: batch.command, cwd, timeout: 10000 });
                        const parsed = res.success ? parseWorktreeIds(res.stdout ?? '', batch.paths) : null;
                        if (parsed) Object.assign(ids, parsed);
                    } catch {
                        // no ids for this batch: those files fall back to the status/numstat signature
                    }
                    if (cancelled) return;
                }
            }
            if (!cancelled) setState({ ids, settled: true });
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch per git-status refresh, not per files identity
    }, [sessionId, active, refreshToken]);
    return state;
}
