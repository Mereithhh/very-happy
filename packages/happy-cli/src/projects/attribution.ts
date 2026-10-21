import type { ProjectsClient } from './client';

/**
 * B-649 attribution (spec §1 归属规则): explicit > lineage > (directory: only a
 * Web suggestion, never automatic — Tanka / todo / automation spawns land in
 * the same repo and would be mis-filed). Joining is best effort and bounded:
 * a slow or old server never blocks a spawn or its first message for long.
 */

export type ProjectChoice =
    | { kind: 'explicit'; projectId: string }
    | { kind: 'lineage'; parentSessionId: string }
    | { kind: 'none' };

/** `--project` wins; `--no-project` opts out; otherwise inherit from the calling session (VH_PEER_SESSION_ID). */
export function chooseProject(opts: { project?: string; noProject?: boolean; parentSessionId?: string | null }): ProjectChoice {
    if (opts.project) return { kind: 'explicit', projectId: opts.project };
    if (opts.noProject) return { kind: 'none' };
    if (opts.parentSessionId) return { kind: 'lineage', parentSessionId: opts.parentSessionId };
    return { kind: 'none' };
}

export type JoinOutcome = { joined: true; projectId: string; via: string } | { joined: false; reason: string };

export async function joinProject(
    client: Pick<ProjectsClient, 'membership' | 'addMembers'>,
    sessionId: string,
    choice: ProjectChoice,
    opts: { timeoutMs?: number; via?: 'explicit' | 'lineage' | 'automation' } = {},
): Promise<JoinOutcome> {
    if (choice.kind === 'none') return { joined: false, reason: 'no project' };
    const timeoutMs = opts.timeoutMs ?? 3000;
    const work = async (): Promise<JoinOutcome> => {
        let projectId: string;
        let via: 'explicit' | 'lineage' | 'automation';
        if (choice.kind === 'explicit') { projectId = choice.projectId; via = opts.via ?? 'explicit'; }
        else {
            const parent = await client.membership(choice.parentSessionId);
            if (!parent.projectId) return { joined: false, reason: 'parent has no project' };
            projectId = parent.projectId; via = 'lineage';
        }
        await client.addMembers(projectId, [sessionId], via);
        return { joined: true, projectId, via };
    };
    try {
        return await Promise.race([
            work(),
            new Promise<JoinOutcome>((resolve) => setTimeout(() => resolve({ joined: false, reason: 'timeout' }), timeoutMs).unref?.()),
        ]);
    } catch (error) {
        return { joined: false, reason: error instanceof Error ? error.message : String(error) };
    }
}
