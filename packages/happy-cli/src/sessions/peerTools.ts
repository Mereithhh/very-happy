/**
 * `session_message` / `session_peers` MCP tools (B-497). One schema, three
 * transports — the same shape as the automation tools: managed Claude
 * registers them in-process (startHappyServer), the Codex stdio bridge
 * forwards them by name to that HTTP server, managed pi discovers them over
 * HAPPY_MCP_URL `tools/list`. Execution always happens in the owning session
 * process, which knows who it is (`ApiSessionClient`) and holds the keys.
 *
 * Also the shared implementation of `very-happy sessions peers|message`
 * (`executeSessionPeerTool` with a CLI-built `PeerSelf`).
 */

import { randomUUID } from 'node:crypto'
import { hostname, userInfo } from 'node:os'
import { z } from 'zod'
import type { AssistantToolRegistrar } from '@/assistant/assistantTools'
import { isValidSessionId } from '@/assistant/ids'
import { listDaemonPeers } from '@/daemon/controlClient'
import type { PeerSessionInfo } from '@/daemon/types'
import { readPersistedSessions, type PersistedSession } from '@/persistence'
import { sendUserMessage, sessionWebUrl } from '@/commands/sessionMessage'
import { deliverToSession, type DeliveryResult } from '@/commands/sessionDelivery'
import { CLI_PEER_SENDER_ID, formatSessionPeerMessage, SESSION_PEER_SENT_FROM, type PeerSender } from './peerMessage'
import { isPeerInScope, PEER_SCOPES, resolveRepoIdentity, type PeerScope, type RepoIdentity } from './repoIdentity'

export const SESSION_PEER_TOOL_NAMES = ['session_message', 'session_peers'] as const
export type SessionPeerToolName = typeof SESSION_PEER_TOOL_NAMES[number]

export const SESSION_PEER_TOOL_SCHEMAS: Record<SessionPeerToolName, { description: string; title: string; readOnly: boolean; inputSchema: Record<string, z.ZodTypeAny> }> = {
    session_message: {
        title: 'Message Another Session',
        readOnly: false,
        description: 'Send a message to another agent session running on this machine (find ids with session_peers). It lands in that session\'s chat with your title, session id and cwd, and tells the peer how to reply to you. Use it to coordinate when you both edit the same files: say what you are changing and ask what they are changing. Returns as soon as the message is queued; the reply arrives later as a message from that session. Only sessions this machine\'s daemon runs can be reached; terminal-mirror sessions cannot receive messages.',
        inputSchema: {
            to: z.string().min(1).max(128).describe('Target session id (from session_peers, or a peer\'s message header)'),
            body: z.string().min(1).max(16_000).describe('The message text'),
            replyTo: z.string().min(1).max(64).optional().describe('Id of the peer message you are answering (from its header), if any'),
        },
    },
    session_peers: {
        title: 'List Peer Sessions',
        readOnly: true,
        description: 'List the other agent sessions running on this machine and the files each edited in the last 30 minutes. Default scope "repo": sessions in the same git repository, including its other worktrees (sameWorktree says whether they share your checkout). "cwd": the same directory only. "machine": every live session here.',
        inputSchema: {
            scope: z.enum(['repo', 'cwd', 'machine']).optional().describe('repo (default) | cwd | machine'),
        },
    },
}

/** Who is calling: a managed session, or the CLI in a shell. */
export interface PeerSelf extends PeerSender {
    /** Directory the caller's repo/cwd scope is computed from. */
    cwd: string
}

/** Per-target send budget: more than this many messages to one session inside the window is a loop, not coordination. */
export const PEER_MESSAGE_RATE_LIMIT = 8
export const PEER_MESSAGE_RATE_WINDOW_MS = 10 * 60_000

export interface PeerToolContext {
    self: () => PeerSelf
    listPeers?: () => Promise<PeerSessionInfo[]>
    readPersisted?: () => Record<string, PersistedSession>
    /** B-501 semantics: classify, send, re-check; default `deliverToSession` with the peer envelope. */
    deliver?: (to: string, persisted: PersistedSession, text: string, localId: string) => Promise<DeliveryResult>
    repoOf?: (cwd: string) => RepoIdentity
    /** Send times per target session (the executor keeps one per session process). */
    sentTo?: Map<string, number[]>
    now?: () => number
}

export interface PeerListing {
    self: { sessionId: string; cwd: string; repoRoot: string | null; scope: PeerScope }
    scope: PeerScope
    peers: Array<PeerSessionInfo & { url: string; sameWorktree: boolean }>
}

export async function listPeerSessions(context: PeerToolContext, scope: PeerScope = 'repo'): Promise<PeerListing> {
    const self = context.self()
    const repoOf = context.repoOf ?? resolveRepoIdentity
    const selfRepo = repoOf(self.cwd)
    const sessions = await (context.listPeers ?? listDaemonPeers)()
    const peers = sessions
        .filter((session) => session.sessionId !== self.sessionId)
        .filter((session) => {
            const cwd = session.cwd ?? ''
            if (!cwd) return scope === 'machine'
            return isPeerInScope(scope, { cwd: self.cwd, repo: selfRepo }, { cwd, repo: repoOf(cwd) })
        })
        .map((session) => ({
            ...session,
            url: sessionWebUrl(session.sessionId),
            sameWorktree: !!session.cwd && !!selfRepo.root && repoOf(session.cwd).root === selfRepo.root,
        }))
    return { self: { sessionId: self.sessionId, cwd: self.cwd, repoRoot: selfRepo.root, scope }, scope, peers }
}

export interface SendPeerMessageResult {
    /** A live wrapper was attached before and after the POST (B-501 semantics). */
    delivered: boolean
    /** The message exists server-side even when `delivered` is false. */
    stored: boolean
    status: DeliveryResult['status']
    messageId: string
    to: string
    url: string
    error?: string
}

function defaultDeliver(to: string, persisted: PersistedSession, text: string, localId: string): Promise<DeliveryResult> {
    return deliverToSession(to, persisted, text, 'session-message', {
        sentFrom: SESSION_PEER_SENT_FROM,
        resumeHint: 'It has to be running to read a peer message; spawn a new session or ask the person.',
    }, {
        send: (sessionId, key, body, client, options) => sendUserMessage(sessionId, key, body, client, { ...options, localId }),
    })
}

/** Pure: is one more message to `to` inside the budget? Prunes the window in place. */
export function checkPeerSendBudget(sentTo: Map<string, number[]>, to: string, now: number, limit = PEER_MESSAGE_RATE_LIMIT, windowMs = PEER_MESSAGE_RATE_WINDOW_MS): { ok: boolean; count: number } {
    const recent = (sentTo.get(to) ?? []).filter((t) => now - t <= windowMs)
    sentTo.set(to, recent)
    return { ok: recent.length < limit, count: recent.length }
}

/**
 * Validate the target (well-formed, not self, key held locally, live on this
 * machine, not a mirror), format the message and push it into the target's
 * queue. Throws with a precise reason on every refusal.
 */
export async function sendPeerMessage(context: PeerToolContext, args: { to: string; body: string; replyTo?: string }): Promise<SendPeerMessageResult> {
    const self = context.self()
    if (!isValidSessionId(args.to)) throw new Error('Invalid session id')
    if (args.to === self.sessionId) throw new Error('That is this session; message a peer instead')
    const body = typeof args.body === 'string' ? args.body.trim() : ''
    if (!body) throw new Error('body must be non-empty')
    const persisted = (context.readPersisted ?? readPersistedSessions)()[args.to]
    if (!persisted) {
        throw new Error(`Session ${args.to} is not on this machine (no local key); messaging sessions on other machines is not supported yet`)
    }
    const live = (await (context.listPeers ?? listDaemonPeers)()).find((session) => session.sessionId === args.to)
    if (!live) throw new Error(`Session ${args.to} is not running on this machine; nothing would read the message`)
    if (live.kind === 'mirror') throw new Error(`Session ${args.to} is a terminal mirror (a person typing claude in a terminal); it cannot receive messages`)
    const now = (context.now ?? Date.now)()
    if (context.sentTo) {
        const budget = checkPeerSendBudget(context.sentTo, args.to, now)
        if (!budget.ok) {
            throw new Error(`Refused: this session already sent ${budget.count} messages to ${args.to} in the last ${Math.round(PEER_MESSAGE_RATE_WINDOW_MS / 60_000)} minutes. That is a reply loop, not coordination — STOP replying to that session now; do not send acknowledgements or thanks. Continue your own work.`)
        }
    }
    const messageId = randomUUID().slice(0, 8)
    const text = formatSessionPeerMessage({ id: messageId, from: self, body, replyTo: args.replyTo })
    const result = await (context.deliver ?? defaultDeliver)(args.to, persisted, text, `session-message-${messageId}`)
    context.sentTo?.get(args.to)?.push(now)
    return {
        delivered: result.delivered,
        stored: result.stored,
        status: result.status,
        messageId,
        to: args.to,
        url: sessionWebUrl(args.to),
        ...(result.error ? { error: result.error } : {}),
    }
}

export async function executeSessionPeerTool(name: SessionPeerToolName, args: any, context: PeerToolContext): Promise<unknown> {
    switch (name) {
        case 'session_message': return sendPeerMessage(context, { to: String(args?.to ?? ''), body: String(args?.body ?? ''), ...(args?.replyTo ? { replyTo: String(args.replyTo) } : {}) })
        case 'session_peers': {
            const scope = args?.scope
            if (scope !== undefined && !PEER_SCOPES.includes(scope)) throw new Error(`scope must be one of ${PEER_SCOPES.join(', ')}`)
            return listPeerSessions(context, scope ?? 'repo')
        }
    }
}

export type SessionPeerToolExecutor = (name: SessionPeerToolName, args: any) => Promise<unknown>

/**
 * The CLI's identity when no session is speaking: the session named by
 * `VH_PEER_SESSION_ID` (every managed runner sets it for its child; dedicated
 * so it never changes what `very-happy teams …` does — HAPPY_SESSION_ID would),
 * else the user at this host.
 */
export function cliPeerSelf(env: NodeJS.ProcessEnv, cwd: string, persisted: Record<string, PersistedSession>): PeerSelf {
    const sessionId = env.VH_PEER_SESSION_ID
    if (sessionId && isValidSessionId(sessionId)) {
        const meta = persisted[sessionId]?.metadata
        return { sessionId, title: meta?.summary?.text, flavor: meta?.flavor, cwd: meta?.path ?? cwd }
    }
    let user = 'user'
    try { user = userInfo().username } catch { /* keep default */ }
    return { sessionId: CLI_PEER_SENDER_ID, title: `cli ${user}@${hostname()}`, flavor: 'cli', cwd }
}

/** In-process executor for a managed session: identity from its ApiSessionClient. */
export function createSessionPeerToolExecutor(client: { sessionId: string; getMetadata: () => { path?: string; flavor?: string; summary?: { text: string } } | null }): SessionPeerToolExecutor {
    const context: PeerToolContext = {
        self: () => {
            const meta = client.getMetadata()
            return { sessionId: client.sessionId, title: meta?.summary?.text, flavor: meta?.flavor, cwd: meta?.path ?? process.cwd() }
        },
        // One budget per session process: the reply-loop guard.
        sentTo: new Map(),
    }
    return (name, args) => executeSessionPeerTool(name, args, context)
}

export function registerSessionPeerTools(server: AssistantToolRegistrar, execute: SessionPeerToolExecutor): void {
    for (const name of SESSION_PEER_TOOL_NAMES) {
        const spec = SESSION_PEER_TOOL_SCHEMAS[name]
        server.registerTool(name, {
            description: spec.description, title: spec.title, inputSchema: spec.inputSchema,
            annotations: { readOnlyHint: spec.readOnly, idempotentHint: spec.readOnly, openWorldHint: false, destructiveHint: false },
        }, async (args: any) => {
            try { return { content: [{ type: 'text' as const, text: JSON.stringify(await execute(name, args ?? {})) }], isError: false } }
            catch (error) { return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Session peer operation failed' }], isError: true } }
        })
    }
}
