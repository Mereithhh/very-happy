import { describe, expect, it, vi } from 'vitest'
import type { PeerSessionInfo } from '@/daemon/types'
import type { PersistedSession } from '@/persistence'
import { cliPeerSelf, executeSessionPeerTool, listPeerSessions, registerSessionPeerTools, sendPeerMessage, SESSION_PEER_TOOL_NAMES, type PeerToolContext } from './peerTools'
import { parsePeerMessage } from './peerMessage'

const persisted = (id: string, metadata: Record<string, unknown> = {}): PersistedSession => ({
    encryptionKey: 'k', encryptionVariant: 'dataKey', seq: 0, metadataVersion: 0, agentStateVersion: 0, savedAt: 1,
    metadata: { path: '/repo', host: 'h', homeDir: '/', happyHomeDir: '/', happyLibDir: '/', happyToolsDir: '/', ...metadata } as PersistedSession['metadata'],
})

const peers: PeerSessionInfo[] = [
    { sessionId: 'me', kind: 'managed', cwd: '/repo', flavor: 'claude', edits: [] },
    { sessionId: 'sib', kind: 'managed', cwd: '/repo/packages/cli', flavor: 'codex', title: 'Codex fix', edits: [{ path: '/repo/a.ts', tool: 'CodexPatch', at: 5 }] },
    { sessionId: 'wt', kind: 'managed', cwd: '/wt/b497', flavor: 'claude', edits: [] },
    { sessionId: 'other', kind: 'managed', cwd: '/other', flavor: 'claude', edits: [] },
    { sessionId: 'mirror', kind: 'mirror', cwd: '/repo', flavor: 'terminal-mirror', edits: [] },
    { sessionId: 'nocwd', kind: 'managed', edits: [] },
]

const repoOf = (cwd: string) => {
    if (cwd.startsWith('/repo')) return { root: '/repo', common: '/repo/.git' }
    if (cwd.startsWith('/wt/b497')) return { root: '/wt/b497', common: '/repo/.git' }
    if (cwd.startsWith('/other')) return { root: '/other', common: '/other/.git' }
    return { root: null, common: null }
}

function context(overrides: Partial<PeerToolContext> = {}): PeerToolContext & { send: ReturnType<typeof vi.fn> } {
    const send = vi.fn(async () => undefined)
    return {
        self: () => ({ sessionId: 'me', title: 'Me', flavor: 'claude', cwd: '/repo' }),
        listPeers: async () => peers,
        readPersisted: () => ({ me: persisted('me'), sib: persisted('sib'), wt: persisted('wt'), mirror: persisted('mirror'), dead: persisted('dead') }),
        repoOf,
        send,
        ...overrides,
    } as PeerToolContext & { send: typeof send }
}

describe('listPeerSessions (B-497)', () => {
    it('repo scope excludes self, other repos and cwd-less sessions, and marks worktrees', async () => {
        const listing = await listPeerSessions(context(), 'repo')
        expect(listing.self).toEqual({ sessionId: 'me', cwd: '/repo', repoRoot: '/repo', scope: 'repo' })
        expect(listing.peers.map((p) => [p.sessionId, p.sameWorktree])).toEqual([['sib', true], ['wt', false], ['mirror', true]])
        expect(listing.peers[0].url).toMatch(/\/session\/sib$/)
        expect(listing.peers[0].edits).toEqual([{ path: '/repo/a.ts', tool: 'CodexPatch', at: 5 }])
    })

    it('cwd and machine scopes', async () => {
        expect((await listPeerSessions(context(), 'cwd')).peers.map((p) => p.sessionId)).toEqual(['mirror'])
        expect((await listPeerSessions(context(), 'machine')).peers.map((p) => p.sessionId)).toEqual(['sib', 'wt', 'other', 'mirror', 'nocwd'])
    })
})

describe('sendPeerMessage', () => {
    it('formats the message with the sender identity and queues it into the target', async () => {
        const ctx = context()
        const result = await sendPeerMessage(ctx, { to: 'sib', body: ' I am changing a.ts ', replyTo: 'm0' })
        expect(result).toMatchObject({ delivered: true, to: 'sib' })
        expect(result.url).toMatch(/\/session\/sib$/)
        expect(ctx.send).toHaveBeenCalledTimes(1)
        const [to, key, text, client, options] = ctx.send.mock.calls[0] as unknown as [string, PersistedSession, string, string, { sentFrom: string; localId: string }]
        expect(to).toBe('sib')
        expect(key).toEqual(persisted('sib'))
        expect(client).toBe('session-message')
        expect(options).toEqual({ sentFrom: 'session-peer', localId: `session-message-${result.messageId}` })
        expect(parsePeerMessage(text)).toEqual({
            kind: 'message', id: result.messageId, replyTo: 'm0', body: 'I am changing a.ts',
            from: { sessionId: 'me', title: 'Me', flavor: 'claude', cwd: '/repo' },
        })
    })

    it('refuses self, unknown, foreign, dead and mirror targets before sending', async () => {
        const ctx = context()
        await expect(sendPeerMessage(ctx, { to: 'me', body: 'x' })).rejects.toThrow(/this session/)
        await expect(sendPeerMessage(ctx, { to: 'bad id', body: 'x' })).rejects.toThrow(/Invalid session id/)
        await expect(sendPeerMessage(ctx, { to: 'sib', body: '  ' })).rejects.toThrow(/non-empty/)
        await expect(sendPeerMessage(ctx, { to: 'other', body: 'x' })).rejects.toThrow(/not on this machine/)
        await expect(sendPeerMessage(ctx, { to: 'dead', body: 'x' })).rejects.toThrow(/not running on this machine/)
        await expect(sendPeerMessage(ctx, { to: 'mirror', body: 'x' })).rejects.toThrow(/terminal mirror/)
        expect(ctx.send).not.toHaveBeenCalled()
    })

    it('surfaces an old daemon precisely', async () => {
        const ctx = context({ listPeers: async () => { throw new Error('The running daemon does not support session peers') } })
        await expect(sendPeerMessage(ctx, { to: 'sib', body: 'x' })).rejects.toThrow(/does not support session peers/)
    })
})

describe('executeSessionPeerTool / registerSessionPeerTools', () => {
    it('validates the scope and routes both tools', async () => {
        const ctx = context()
        await expect(executeSessionPeerTool('session_peers', { scope: 'planet' }, ctx)).rejects.toThrow(/scope must be one of/)
        expect(((await executeSessionPeerTool('session_peers', {}, ctx)) as { scope: string }).scope).toBe('repo')
        expect(((await executeSessionPeerTool('session_message', { to: 'sib', body: 'hi' }, ctx)) as { delivered: boolean }).delivered).toBe(true)
    })

    it('registers exactly the two tools and wraps errors as isError results', async () => {
        const handlers = new Map<string, (args: unknown) => Promise<{ isError: boolean; content: Array<{ text: string }> }>>()
        const names: string[] = []
        registerSessionPeerTools({ registerTool: ((name: string, _spec: unknown, handler: (args: unknown) => Promise<never>) => { names.push(name); handlers.set(name, handler); return {} as never }) as never }, async (name) => {
            if (name === 'session_peers') return { peers: [] }
            throw new Error('nope')
        })
        expect(names).toEqual([...SESSION_PEER_TOOL_NAMES])
        expect(await handlers.get('session_peers')!({})).toEqual({ isError: false, content: [{ type: 'text', text: '{"peers":[]}' }] })
        expect(await handlers.get('session_message')!({})).toEqual({ isError: true, content: [{ type: 'text', text: 'nope' }] })
    })
})

describe('cliPeerSelf', () => {
    it('is the HAPPY_SESSION_ID session when set, else the CLI user', () => {
        const store = { s1: persisted('s1', { summary: { text: 'Task', updatedAt: 1 }, flavor: 'codex', path: '/repo/x' }) }
        expect(cliPeerSelf({ HAPPY_SESSION_ID: 's1' }, '/elsewhere', store)).toEqual({ sessionId: 's1', title: 'Task', flavor: 'codex', cwd: '/repo/x' })
        expect(cliPeerSelf({ HAPPY_SESSION_ID: 'unknown' }, '/elsewhere', store)).toMatchObject({ sessionId: 'unknown', cwd: '/elsewhere' })
        const cli = cliPeerSelf({}, '/here', store)
        expect(cli).toMatchObject({ sessionId: 'cli', flavor: 'cli', cwd: '/here' })
        expect(cli.title).toMatch(/^cli .+@.+/)
    })
})
