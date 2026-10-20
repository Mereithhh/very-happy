import type { ProjectPresenceEntry } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { buildDigestLine, buildFirstTurnPrefix, prependToMessage } from './prompt';
import { ProjectsUnsupportedError, type ProjectsClient } from './client';

/**
 * B-645 per-wrapper project injector (spec §3 layers P and D).
 *
 * `decorate(message)` runs right before a turn that is already going to run
 * (a human / peer / automation message was dequeued) and returns the text to
 * send: the first-turn prefix (P) once per agent conversation while the
 * session is a project member, the ≤2-line digest (D) on later turns when
 * something changed, or the message untouched. It never starts a turn by
 * itself, so a project update can never wake an idle session.
 *
 * Every failure (old server, timeout, offline) degrades to "send the message
 * unchanged": the user's turn is never blocked for longer than `timeoutMs`.
 */

export type ProjectInjectorDeps = {
    client: ProjectsClient;
    sessionId: () => string | null | undefined;
    /** Live metadata of this session (title, board progress, capabilities, machineId, branch). */
    metadata?: () => Record<string, any> | null | undefined;
    agent: string;
    timeoutMs?: number;
    now?: () => number;
    presenceMinIntervalMs?: number;
};

export type ProjectInjectorState = {
    projectId: string | null;
    prefixSent: boolean;
    cursor: number;
    injectedVersion: number | null;
};

export function createProjectInjector(deps: ProjectInjectorDeps) {
    const timeoutMs = deps.timeoutMs ?? 1500;
    const now = deps.now ?? Date.now;
    const presenceEvery = deps.presenceMinIntervalMs ?? 30_000;
    const state: ProjectInjectorState = { projectId: null, prefixSent: false, cursor: 0, injectedVersion: null };
    const titles = new Map<string, string>();
    let lastPresenceAt = 0;
    let lastPresenceVersion: number | null = null;
    const label = (id: string) => titles.get(id) ?? id.slice(0, 8);

    function withTimeout<T>(p: Promise<T>): Promise<T> {
        return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('project injection timeout')), timeoutMs).unref?.())]);
    }

    function reportPresence(force: boolean) {
        const sid = deps.sessionId();
        const meta = deps.metadata?.() ?? null;
        const machineId = typeof meta?.machineId === 'string' ? meta.machineId : null;
        if (!sid || !machineId || !state.projectId) return;
        const t = now();
        if (!force && state.injectedVersion === lastPresenceVersion && t - lastPresenceAt < presenceEvery) return;
        lastPresenceAt = t; lastPresenceVersion = state.injectedVersion;
        const entry: ProjectPresenceEntry = {
            sessionId: sid, agent: deps.agent, state: 'running',
            injectedInstructionsVersion: state.injectedVersion,
            ...(typeof meta?.summary?.text === 'string' ? { title: String(meta.summary.text).slice(0, 200) } : {}),
            ...(typeof meta?.board?.progress === 'string' ? { doing: String(meta.board.progress).slice(0, 200) } : {}),
            ...(typeof meta?.worktree?.branch === 'string' ? { branch: String(meta.worktree.branch).slice(0, 200) } : {}),
            ...(typeof meta?.host === 'string' ? { machine: String(meta.host).slice(0, 200) } : {}),
            ...(Array.isArray(meta?.capabilities) ? { capabilities: meta.capabilities.filter((c: unknown) => typeof c === 'string').slice(0, 32) } : {}),
        };
        void deps.client.presence(machineId, [entry]).catch(error => logger.debug(`[projects] presence write skipped: ${String(error)}`));
    }

    function markDelivered(sid: string, ids: string[]) {
        if (ids.length) void deps.client.delivered(sid, ids).catch(error => logger.debug(`[projects] delivered ack skipped: ${String(error)}`));
    }

    async function firstTurn(sid: string, message: string): Promise<string> {
        const ctx = await withTimeout(deps.client.context(sid, {}, timeoutMs));
        for (const s of ctx.sessions) if (s.title) titles.set(s.sessionId, s.title);
        const built = buildFirstTurnPrefix(ctx, { label });
        if (!built || !ctx.project) { state.projectId = null; return message; }
        state.projectId = ctx.project.id;
        state.prefixSent = true;
        state.cursor = ctx.asOf;
        state.injectedVersion = built.instructionsVersion;
        markDelivered(sid, ctx.unread.map(u => u.id));
        reportPresence(true);
        return prependToMessage(message, built.prefix);
    }

    async function laterTurn(sid: string, message: string): Promise<string> {
        const d = await withTimeout(deps.client.digest(sid, state.cursor, timeoutMs));
        if (!d.projectId) {
            // Left the project (or it was archived): the next membership gets a fresh prefix.
            state.projectId = null; state.prefixSent = false; state.injectedVersion = null;
            return message;
        }
        if (d.projectId !== state.projectId) {
            state.prefixSent = false;
            return firstTurn(sid, message);
        }
        state.cursor = d.asOf;
        if (d.instructions) state.injectedVersion = d.instructions.version;
        markDelivered(sid, d.messages.map(m => m.id));
        reportPresence(!!d.instructions);
        return prependToMessage(message, buildDigestLine(d, { label }));
    }

    return {
        state: () => ({ ...state }),
        /** A fresh agent with no memory of earlier turns (ACP backend restart, new Claude conversation) needs P again. */
        reset() { state.prefixSent = false; state.cursor = 0; },
        async decorate<T>(message: T): Promise<T> {
            if (typeof message !== 'string') return message;
            const sid = deps.sessionId();
            if (!sid || deps.client.isDisabled()) return message;
            try {
                const out = state.prefixSent ? await laterTurn(sid, message) : await firstTurn(sid, message);
                return out as unknown as T;
            } catch (error) {
                if (!(error instanceof ProjectsUnsupportedError)) logger.debug(`[projects] injection skipped: ${String(error)}`);
                return message;
            }
        },
    };
}
export type ProjectInjector = ReturnType<typeof createProjectInjector>;
