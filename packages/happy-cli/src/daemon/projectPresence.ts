import type { ProjectPresenceEntry } from '@slopus/happy-wire';
import type { ProjectsClient } from '@/projects/client';
import { ProjectsUnsupportedError } from '@/projects/client';

/**
 * B-645 daemon-side project presence. Every tick the daemon reports the
 * coarse facts it owns for each live session (agent flavor, branch, turn
 * running/idle) in ONE batched request on the dedicated `project_presence`
 * bucket — never the session-state bucket. The server keeps only rows for
 * project members and merges fields, so the wrapper's richer report (title,
 * "doing", injected instructions version) is not overwritten. Sessions that
 * disappeared since the last tick are sent as `gone` (marked offline).
 *
 * This is what makes old wrappers (no `project-v1`) still show up in the
 * project view and in `session_peers scope=project` (compat matrix row 2).
 * An old server answers 404 → the shared client backs off for 10 minutes.
 */

export type LiveSessionFacts = { sessionId: string; flavor?: string | null; branch?: string | null; running: boolean };

export function buildPresenceBatch(live: LiveSessionFacts[], previous: ReadonlySet<string>): { sessions: ProjectPresenceEntry[]; gone: string[]; current: Set<string> } {
    const current = new Set(live.map(s => s.sessionId));
    const sessions = live.slice(0, 200).map(s => ({
        sessionId: s.sessionId,
        state: s.running ? 'running' : 'idle',
        ...(s.flavor ? { agent: s.flavor } : {}),
        ...(s.branch ? { branch: s.branch.slice(0, 200) } : {}),
    }));
    const gone = [...previous].filter(id => !current.has(id)).slice(0, 200);
    return { sessions, gone, current };
}

export function createProjectPresenceReporter(deps: {
    machineId: string;
    client: ProjectsClient;
    live: () => LiveSessionFacts[];
    log: (message: string) => void;
    intervalMs?: number;
}) {
    let previous = new Set<string>();
    let running = false;
    async function tick(): Promise<void> {
        if (running || deps.client.isDisabled()) return;
        running = true;
        try {
            const batch = buildPresenceBatch(deps.live(), previous);
            if (batch.sessions.length === 0 && batch.gone.length === 0) { previous = batch.current; return; }
            await deps.client.presence(deps.machineId, batch.sessions, batch.gone);
            previous = batch.current;
        } catch (error) {
            if (!(error instanceof ProjectsUnsupportedError)) deps.log(`project presence tick failed: ${String(error)}`);
        } finally { running = false; }
    }
    const timer = setInterval(() => { void tick(); }, deps.intervalMs ?? 60_000);
    timer.unref?.();
    return { tick, stop: () => clearInterval(timer) };
}
