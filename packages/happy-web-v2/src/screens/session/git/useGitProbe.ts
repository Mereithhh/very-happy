/**
 * B-583: branch / upstream / remotes / default branch / last commit for the
 * session cwd — one `bash` RPC, re-run when the changes list refreshes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { shellFlavorFor, type ShellFlavor } from '../diffComments/gitDiff';
import { platformOfSession } from '../diffComments/useGitFileDiff';
import { buildProbeCommand, parseProbe, type GitProbe } from './gitShell';
import { runSync } from './gitRunner';

export type GitProbeState = { probe: GitProbe | null; flavor: ShellFlavor | null; loaded: boolean };

export async function loadGitProbe(sessionId: string): Promise<{ probe: GitProbe | null; flavor: ShellFlavor | null }> {
    const flavor = shellFlavorFor(platformOfSession(sessionId));
    const cmd = buildProbeCommand(flavor);
    if (!cmd.ok) return { probe: null, flavor };
    const res = await runSync(sessionId, cmd.command, 10_000);
    return { probe: parseProbe(res.stdout), flavor };
}

export function useGitProbe(sessionId: string, active: boolean, refreshToken?: unknown) {
    const [state, setState] = useState<GitProbeState>({ probe: null, flavor: null, loaded: false });
    const generation = useRef(0);
    const reload = useCallback(async () => {
        const mine = ++generation.current;
        try {
            const next = await loadGitProbe(sessionId);
            if (mine === generation.current) setState({ ...next, loaded: true });
        } catch {
            if (mine === generation.current) setState((prev) => ({ ...prev, loaded: true }));
        }
    }, [sessionId]);
    useEffect(() => {
        if (active) void reload();
    }, [active, reload, refreshToken]);
    useEffect(() => () => { generation.current++; }, []);
    return { ...state, reload };
}
