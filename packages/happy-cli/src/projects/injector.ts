import type { ProjectPresenceEntry, ProjectSessionContext } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { buildDigestLine, buildFirstTurnPrefix, isolateContext, isolateDigest, prependToMessage } from './prompt';
import { ProjectsUnsupportedError, type ProjectsClient } from './client';
import { createIssueDigest, type IssueDigest } from '@/issues/digest';
import { createTeamExitNotice, type TeamExitNotice } from '@/teams/exitNotice';
import { createTeamLanguageBackfill, type TeamLanguageBackfill } from '@/teams/languageBackfill';
import { formatSessionPeerMessage } from '@/sessions/peerMessage';

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
    /** B-874: the issue digest line (spec §5) rides on the same decorate call; default = one for this session. */
    issueDigest?: Pick<IssueDigest, 'decorate'> | null;
    /** B-877b: the one-time 「team mode ended」 note after the lead left its team; default = one for this session. */
    teamExitNotice?: Pick<TeamExitNotice, 'decorate'> | null;
    /** B-877c: the language rule, once, for a team session that started without it; default = one for this session. */
    teamLanguageBackfill?: Pick<TeamLanguageBackfill, 'decorate'> | null;
    /**
     * B-939c: hand a message another session stored for this one while it was
     * offline to the agent the way a live session message arrives — local
     * routing, no server write (ApiSessionClient.routeLocalSessionPeer). Absent
     * (Gemini) = the old text line in front of the user's message.
     */
    dispatchToSelf?: ((text: string, localKey: string) => void) | null;
    /**
     * B-939c: when a dispatched message counts as handed to the agent. `decorate`
     * (default): the turn carrying it is being sent (Codex, pi — sent right
     * after decorate). `pushed`: only on `handed(localKeys)` — Claude, where a
     * session message can still be held behind Claude Code's own turn after
     * its prompt was finalized; the launcher calls it when it pushes it.
     */
    handedOn?: 'decorate' | 'pushed';
};

type StoredMessage = ProjectSessionContext['unread'][number];

const STORED_PREFIX = 'project-msg-';
/** B-939c: the localKey of a stored project message routed into its recipient — not a server record. */
export const storedMessageLocalId = (id: string) => `${STORED_PREFIX}${id}`;
/** B-939c: such a key has no server record to replay or tombstone; the stored message itself stays unread until handed. */
export const isStoredMessageLocalId = (localId: string) => localId.startsWith(STORED_PREFIX);

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
    let teamReader = false;
    let lastPresenceAt = 0;
    let lastPresenceVersion: number | null = null;
    const label = (id: string) => titles.get(id) ?? id.slice(0, 8);
    /** B-939c: stored messages routed to the agent and not yet handed to it (localKey → message id, envelope header). */
    const dispatched = new Map<string, { id: string; header: string }>();
    /** B-939c: handed and acked (or the ack is in flight) — never routed again by this process. */
    const handedIds = new Set<string>();
    const issueDigest = deps.issueDigest === undefined ? createIssueDigest({ sessionId: deps.sessionId, metadata: () => deps.metadata?.() ?? null, timeoutMs }) : deps.issueDigest;
    const teamExitNotice = deps.teamExitNotice === undefined ? createTeamExitNotice({ sessionId: deps.sessionId }) : deps.teamExitNotice;
    const teamLanguageBackfill = deps.teamLanguageBackfill === undefined ? createTeamLanguageBackfill({ sessionId: deps.sessionId }) : deps.teamLanguageBackfill;

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

    /**
     * B-939c: messages other sessions stored for this one go to the agent as
     * session messages of their own (live delivery's envelope and channel —
     * NON-USER on Claude), queued behind the turn being decorated; isolated or
     * shared alike. Marked delivered only once handed to the agent: a process
     * that stops first leaves them unread, and the next one routes them again.
     * Returns the messages left for the text line (no channel).
     */
    function deliverStored(sid: string, messages: StoredMessage[]): StoredMessage[] {
        const dispatch = deps.dispatchToSelf;
        if (!dispatch) return messages;
        const inFlight = new Set([...dispatched.values()].map(d => d.id));
        for (const m of messages) {
            if (inFlight.has(m.id) || handedIds.has(m.id)) continue;
            if (m.body === null) { handedIds.add(m.id); markDelivered(sid, [m.id]); continue; }
            const text = formatSessionPeerMessage({ id: m.id.slice(0, 8), from: { sessionId: m.fromSessionId, ...(titles.get(m.fromSessionId) ? { title: titles.get(m.fromSessionId) } : {}) }, body: m.body });
            const localKey = storedMessageLocalId(m.id);
            dispatched.set(localKey, { id: m.id, header: text.slice(0, text.indexOf('\n')) });
            try { dispatch(text, localKey); }
            catch (error) { dispatched.delete(localKey); logger.debug(`[projects] stored message ${m.id} not routed, tried again next turn: ${String(error)}`); }
        }
        return [];
    }

    function handed(localKeys: readonly string[]) {
        const sid = deps.sessionId();
        const ids: string[] = [];
        for (const key of localKeys) {
            const d = dispatched.get(key);
            if (!d) continue;
            dispatched.delete(key);
            handedIds.add(d.id);
            ids.push(d.id);
        }
        if (sid && ids.length) markDelivered(sid, ids);
    }

    async function firstTurn(sid: string, message: string): Promise<string> {
        const raw = await withTimeout(deps.client.context(sid, {}, timeoutMs));
        const parentId = typeof deps.metadata?.()?.parentSessionId === 'string' ? deps.metadata?.()?.parentSessionId as string : null;
        // B-939b: an isolated session sees no other sessions — and only what it is shown is marked delivered.
        const ctx = isolateContext(raw, { selfId: sid, parentId });
        teamReader = !!raw.team || raw.via === 'team';
        for (const s of ctx.sessions) if (s.title) titles.set(s.sessionId, s.title);
        if (!ctx.project) { state.projectId = null; return message; }
        const unread = deliverStored(sid, ctx.unread);
        const built = buildFirstTurnPrefix({ ...ctx, unread }, { label, selfId: sid, parentId });
        if (!built) { state.projectId = null; return message; }
        state.projectId = ctx.project.id;
        state.prefixSent = true;
        state.cursor = ctx.asOf;
        state.injectedVersion = built.instructionsVersion;
        markDelivered(sid, unread.map(u => u.id));
        reportPresence(true);
        return prependToMessage(message, built.prefix);
    }

    async function laterTurn(sid: string, message: string): Promise<string> {
        const raw = await withTimeout(deps.client.digest(sid, state.cursor, timeoutMs));
        // B-939b: the digest carries the project's current sharing; team sessions always share.
        const d = isolateDigest(raw, { selfId: sid, isolated: !teamReader && raw.sharing !== 'shared' });
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
        const messages = deliverStored(sid, d.messages);
        markDelivered(sid, messages.map(m => m.id));
        reportPresence(!!d.instructions);
        return prependToMessage(message, buildDigestLine({ ...d, messages }, { label }));
    }

    return {
        state: () => ({ ...state }),
        /** B-939c: these prompts reached the agent (Claude: pushed to Claude Code) — mark their stored messages delivered. */
        handed,
        /** A fresh agent with no memory of earlier turns (ACP backend restart, new Claude conversation) needs P again. */
        reset() { state.prefixSent = false; state.cursor = 0; },
        async decorate<T>(message: T): Promise<T> {
            if (typeof message !== 'string') return message;
            if ((deps.handedOn ?? 'decorate') === 'decorate' && dispatched.size) {
                handed([...dispatched].filter(([, d]) => message.includes(d.header)).map(([key]) => key));
            }
            // The team-exit note goes first: it changes how the model reads everything after it.
            const withIssue = async (text: string) => {
                const digested = issueDigest ? await issueDigest.decorate(text) : text;
                const noticed = teamExitNotice ? teamExitNotice.decorate(digested) : digested;
                return teamLanguageBackfill ? teamLanguageBackfill.decorate(noticed, message) : noticed;
            };
            const sid = deps.sessionId();
            if (!sid || deps.client.isDisabled()) return await withIssue(message) as unknown as T;
            let out: string = message;
            try {
                out = state.prefixSent ? await laterTurn(sid, message) : await firstTurn(sid, message);
            } catch (error) {
                if (!(error instanceof ProjectsUnsupportedError)) logger.debug(`[projects] injection skipped: ${String(error)}`);
            }
            return await withIssue(out) as unknown as T;
        },
    };
}
export type ProjectInjector = ReturnType<typeof createProjectInjector>;
