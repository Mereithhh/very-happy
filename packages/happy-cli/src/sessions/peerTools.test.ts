import { describe, expect, it, vi } from 'vitest'
import type { PeerSessionInfo } from '@/daemon/types'
import type { PersistedSession } from '@/persistence'
import { checkPeerSendBudget, cliPeerSelf, executeSessionPeerTool, listPeerSessions, registerSessionPeerTools, sendPeerMessage, SESSION_PEER_TOOL_NAMES, type PeerToolContext } from './peerTools'
import type { DeliveryResult } from '@/commands/sessionDelivery'
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

function context(overrides: Partial<PeerToolContext> = {}): PeerToolContext & { deliver: ReturnType<typeof vi.fn> } {
    const deliver = vi.fn(async (to: string): Promise<DeliveryResult> => ({ sessionId: to, status: 'live', delivered: true, resumed: false, stored: true }))
    return {
        self: () => ({ sessionId: 'me', title: 'Me', flavor: 'claude', cwd: '/repo' }),
        listPeers: async () => peers,
        readPersisted: () => ({ me: persisted('me'), sib: persisted('sib'), wt: persisted('wt'), mirror: persisted('mirror'), dead: persisted('dead') }),
        repoOf,
        deliver,
        sentTo: new Map(),
        now: () => 1_000_000,
        ...overrides,
    } as PeerToolContext & { deliver: typeof deliver }
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
        expect(result).toMatchObject({ delivered: true, stored: true, status: 'live', to: 'sib' })
        expect(result.url).toMatch(/\/session\/sib$/)
        expect(ctx.deliver).toHaveBeenCalledTimes(1)
        const [to, key, text, localId] = ctx.deliver.mock.calls[0] as unknown as [string, PersistedSession, string, string]
        expect(to).toBe('sib')
        expect(key).toEqual(persisted('sib'))
        expect(localId).toBe(`session-message-${result.messageId}`)
        expect(parsePeerMessage(text)).toEqual({
            kind: 'message', id: result.messageId, replyTo: 'm0', body: 'I am changing a.ts',
            from: { sessionId: 'me', title: 'Me', flavor: 'claude', cwd: '/repo' },
        })
    })

    it('refuses self, unknown, foreign (hop disabled), dead and mirror targets before sending', async () => {
        // B-506: a foreign target normally goes to the owning machine; with the hop
        // disabled (what a daemon answering a proxied call does) it is refused here.
        const ctx = context({ remoteMessage: null })
        await expect(sendPeerMessage(ctx, { to: 'me', body: 'x' })).rejects.toThrow(/this session/)
        await expect(sendPeerMessage(ctx, { to: 'bad id', body: 'x' })).rejects.toThrow(/Invalid session id/)
        await expect(sendPeerMessage(ctx, { to: 'sib', body: '  ' })).rejects.toThrow(/non-empty/)
        await expect(sendPeerMessage(ctx, { to: 'other', body: 'x' })).rejects.toThrow(/not on this machine \(no local key\)/)
        await expect(sendPeerMessage(ctx, { to: 'dead', body: 'x' })).rejects.toThrow(/not running on this machine/)
        await expect(sendPeerMessage(ctx, { to: 'mirror', body: 'x' })).rejects.toThrow(/terminal mirror/)
        expect(ctx.deliver).not.toHaveBeenCalled()
    })

    it('reports B-501 delivery semantics instead of a blind delivered:true', async () => {
        const ctx = context({ deliver: async (to): Promise<DeliveryResult> => ({ sessionId: to, status: 'offline', delivered: false, resumed: false, stored: true, error: 'went offline while sending' }) })
        const result = await sendPeerMessage(ctx, { to: 'sib', body: 'x' })
        expect(result).toMatchObject({ delivered: false, stored: true, status: 'offline', error: 'went offline while sending' })
    })

    it('refuses the 9th message to one target inside 10 minutes and says to stop', async () => {
        let t = 0
        const ctx = context({ now: () => t })
        for (let i = 0; i < 8; i++) { t += 1_000; await sendPeerMessage(ctx, { to: 'sib', body: `m${i}` }) }
        t += 1_000
        await expect(sendPeerMessage(ctx, { to: 'sib', body: 'm8' })).rejects.toThrow(/already sent 8 messages .* STOP replying/)
        // Another target has its own budget; the window frees the first one.
        await expect(sendPeerMessage(ctx, { to: 'wt', body: 'x' })).resolves.toMatchObject({ delivered: true })
        t += 10 * 60_000
        await expect(sendPeerMessage(ctx, { to: 'sib', body: 'later' })).resolves.toMatchObject({ delivered: true })
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

describe('checkPeerSendBudget', () => {
    it('counts only the window and prunes in place', () => {
        const sentTo = new Map<string, number[]>([['x', [0, 1, 2]]])
        expect(checkPeerSendBudget(sentTo, 'x', 5, 3, 5)).toEqual({ ok: false, count: 3 })
        expect(checkPeerSendBudget(sentTo, 'x', 5, 3, 3)).toEqual({ ok: true, count: 1 })
        expect(sentTo.get('x')).toEqual([2])
    })
})

describe('cliPeerSelf', () => {
    it('is the VH_PEER_SESSION_ID session when set (never HAPPY_SESSION_ID: that one changes teams behaviour), else the CLI user', () => {
        const store = { s1: persisted('s1', { summary: { text: 'Task', updatedAt: 1 }, flavor: 'codex', path: '/repo/x' }) }
        expect(cliPeerSelf({ VH_PEER_SESSION_ID: 's1' }, '/elsewhere', store)).toEqual({ sessionId: 's1', title: 'Task', flavor: 'codex', cwd: '/repo/x' })
        expect(cliPeerSelf({ VH_PEER_SESSION_ID: 'unknown' }, '/elsewhere', store)).toMatchObject({ sessionId: 'unknown', cwd: '/elsewhere' })
        expect(cliPeerSelf({ HAPPY_SESSION_ID: 's1' }, '/elsewhere', store)).toMatchObject({ sessionId: 'cli' })
        const cli = cliPeerSelf({}, '/here', store)
        expect(cli).toMatchObject({ sessionId: 'cli', flavor: 'cli', cwd: '/here' })
        expect(cli.title).toMatch(/^cli .+@.+/)
    })
})

describe('sendPeerMessage across machines (B-506)', () => {
    it('hands a session without a local key to the remote route with the sender identity, and counts it in the budget', async () => {
        const remoteMessage = vi.fn(async (args: any) => ({ delivered: true, stored: true, status: 'live' as const, messageId: 'r1', to: args.to, url: 'u', machine: { id: 'dev-sg', host: 'dev-sg' } }))
        const ctx = context({ remoteMessage })
        const result = await sendPeerMessage(ctx, { to: 'other', body: ' remote hi ', replyTo: 'm0' })
        expect(result).toMatchObject({ delivered: true, to: 'other', machine: { host: 'dev-sg' } })
        expect(remoteMessage).toHaveBeenCalledWith({ to: 'other', body: 'remote hi', replyTo: 'm0', from: { sessionId: 'me', title: 'Me', flavor: 'claude', cwd: '/repo' }, machineId: undefined })
        expect(ctx.deliver).not.toHaveBeenCalled()
        expect(ctx.sentTo!.get('other')).toEqual([1_000_000])
    })

    it('an explicit machineId forces the remote route even when a local key exists', async () => {
        const remoteMessage = vi.fn(async (args: any) => ({ delivered: true, stored: true, status: 'live' as const, messageId: 'r1', to: args.to, url: 'u', machine: { id: 'x', host: 'x' } }))
        const ctx = context({ remoteMessage })
        await sendPeerMessage(ctx, { to: 'sib', body: 'x', machineId: 'x' })
        expect(remoteMessage).toHaveBeenCalledWith(expect.objectContaining({ to: 'sib', machineId: 'x' }))
        expect(ctx.deliver).not.toHaveBeenCalled()
    })

    it('with the hop disabled (a daemon answering a proxied call) a foreign target is refused instead of bounced', async () => {
        const ctx = context({ remoteMessage: null })
        await expect(sendPeerMessage(ctx, { to: 'other', body: 'x' })).rejects.toThrow(/not on this machine \(no local key\)/)
    })

    it('session_peers with machineId lists through the remote route', async () => {
        const remotePeers = vi.fn(async (machineId: string, options: any) => ({ self: { sessionId: 'cli', cwd: '/', repoRoot: null, scope: 'machine' as const }, scope: 'machine' as const, peers: [], machineId, host: 'dev-sg', options }))
        const ctx = context({ remotePeers })
        expect(await executeSessionPeerTool('session_peers', { machineId: 'dev-sg', scope: 'cwd', cwd: '/home/u' }, ctx)).toMatchObject({ host: 'dev-sg', options: { scope: 'cwd', cwd: '/home/u' } })
        expect(remotePeers).toHaveBeenCalledWith('dev-sg', { scope: 'cwd', cwd: '/home/u' })
    })
})
