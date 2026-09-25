import { describe, expect, it, vi } from 'vitest'
import type { PersistedSession } from '@/persistence'
import type { DeliveryResult } from '@/commands/sessionDelivery'
import { RemoteCallBudget, type RemoteCaller } from '@/sessions/remoteSessionOps'
import { createRemoteSessionOpsHandlers, type RemoteSessionOpsDeps } from './remoteSessionOps'

const { sendUserMessageMock } = vi.hoisted(() => ({ sendUserMessageMock: vi.fn(async () => undefined) }))
vi.mock('@/commands/sessionMessage', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/commands/sessionMessage')>()), sendUserMessage: sendUserMessageMock }))

const persisted = (id: string, title?: string): PersistedSession => ({
    encryptionKey: 'k', encryptionVariant: 'dataKey', seq: 0, metadataVersion: 0, agentStateVersion: 0, savedAt: 5,
    metadata: { path: '/repo', host: 'h', homeDir: '/', happyHomeDir: '/', happyLibDir: '/', happyToolsDir: '/', flavor: 'claude', ...(title ? { summary: { text: title, updatedAt: 1 } } : {}) } as PersistedSession['metadata'],
})

const from: RemoteCaller = { machineId: 'mac-A', host: 'mac', cli: '0.2.157' }
const req = (args: unknown, caller: RemoteCaller = from) => ({ v: 1, from: caller, args })

function build(overrides: Partial<RemoteSessionOpsDeps> = {}) {
    const log = vi.fn()
    const deps: Partial<RemoteSessionOpsDeps> = {
        host: 'dev-sg',
        enabled: async () => true,
        readPersisted: () => ({ mine: persisted('mine', 'Mine'), old: persisted('old') }),
        listLocal: async () => [{ id: 'mine', live: true, pid: 4, url: 'u/mine', title: 'Mine' }],
        listAccount: async () => [
            { id: 'mine', live: true, url: 'u/mine', decryptable: true, readable: true, active: true, archived: false, attention: false, title: 'Mine' },
            { id: 'foreign', live: false, url: 'u/foreign', decryptable: false, readable: false, active: true, archived: false, attention: false },
        ],
        readTranscript: async (sessionId, limit) => ({ summary: { id: sessionId, live: true, url: 'u' }, messageCount: limit, transcript: 'x'.repeat(300_000), turn: { ended: true, answer: 'done', userSeq: 1, lastSeq: 2 } as any }),
        deliver: vi.fn(async (sessionId): Promise<DeliveryResult> => ({ sessionId, status: 'live', delivered: true, resumed: false, stored: true })),
        listPeers: vi.fn(async (context, scope) => ({ self: { ...context.self(), repoRoot: null, scope }, scope, peers: [] })),
        sendPeer: vi.fn(async (context, args) => ({ delivered: true, stored: true, status: 'live' as const, messageId: 'm1', to: args.to, url: 'u', from: context.self(), remote: context.remoteMessage })),
        log,
        now: () => 1_000,
        ...overrides,
    }
    return { handlers: createRemoteSessionOpsHandlers('dev-sg-id', deps), log, deps }
}

describe('createRemoteSessionOpsHandlers (B-506, target daemon)', () => {
    it('registers exactly the five whitelisted methods', () => {
        expect(Object.keys(build().handlers).sort()).toEqual(['sessions.list', 'sessions.message', 'sessions.peers', 'sessions.read', 'sessions.send'])
    })

    it('answers disabled with a code and still writes the audit line', async () => {
        const { handlers, log } = build({ enabled: async () => false })
        expect(await handlers['sessions.read'](req({ sessionId: 'mine' }))).toMatchObject({ ok: false, error: { code: 'disabled' } })
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[REMOTE SESSION OPS\] sessions\.read from machine=\? host=\? .* → disabled/))
    })

    it('sessions.list with ids = locate: only what this machine holds, live rows from the daemon, the rest from the key file', async () => {
        const { handlers, log } = build()
        const out = await handlers['sessions.list'](req({ ids: ['mine', 'old', 'foreign'] }))
        expect(out).toEqual({ ok: true, result: { machineId: 'dev-sg-id', host: 'dev-sg', sessions: [
            { id: 'mine', live: true, pid: 4, url: 'u/mine', title: 'Mine' },
            expect.objectContaining({ id: 'old', live: false, cwd: '/repo', flavor: 'claude', savedAt: 5 }),
        ] } })
        expect(log).toHaveBeenCalledWith('[REMOTE SESSION OPS] sessions.list from machine=mac-A host=mac cli=0.2.157 session=- target=- → ok (0ms)')
    })

    it('sessions.list with all = the account rows this machine can decrypt, filtered to the asked ids', async () => {
        const { handlers } = build()
        const out = await handlers['sessions.list'](req({ ids: ['mine', 'foreign'], all: true }))
        expect(out).toMatchObject({ ok: true, result: { sessions: [expect.objectContaining({ id: 'mine', decryptable: true })] } })
    })

    it('sessions.read: no_local_key for a session this machine did not spawn; caps a huge transcript', async () => {
        const { handlers } = build()
        expect(await handlers['sessions.read'](req({ sessionId: 'foreign' }))).toMatchObject({ ok: false, error: { code: 'no_local_key', message: expect.stringContaining('dev-sg') } })
        const out = await handlers['sessions.read'](req({ sessionId: 'mine', limit: 500 }))
        expect(out.ok).toBe(true)
        const result = (out as { ok: true; result: any }).result
        expect(result).toMatchObject({ machineId: 'dev-sg-id', host: 'dev-sg', messageCount: 100, truncated: true })
        expect(Buffer.byteLength(result.transcript)).toBeLessThanOrEqual(200 * 1024)
    })

    it('sessions.send delivers through the B-501 path with the remote client tag and forwards resume/model', async () => {
        const { handlers, deps } = build()
        const out = await handlers['sessions.send'](req({ sessionId: 'mine', text: 'hello', resume: true, model: null }))
        expect(out).toMatchObject({ ok: true, result: { delivered: true, status: 'live' } })
        expect(deps.deliver).toHaveBeenCalledWith('mine', expect.objectContaining({ encryptionKey: 'k' }), 'hello', 'cli-send-remote', { resume: true, model: null, waitMs: 10_000, pollMs: 1_000 }, { send: expect.any(Function) })
    })

    it('sessions.peers computes the scope on this machine from the caller\'s cwd; no cwd = machine scope', async () => {
        const { handlers, deps } = build()
        await handlers['sessions.peers'](req({ scope: 'repo' }, { ...from, sessionId: 'sA' }))
        expect(deps.listPeers).toHaveBeenLastCalledWith(expect.anything(), 'machine')
        await handlers['sessions.peers'](req({ scope: 'repo', cwd: '/home/u/repo' }, { ...from, sessionId: 'sA' }))
        expect(deps.listPeers).toHaveBeenLastCalledWith(expect.anything(), 'repo')
        const context = (deps.listPeers as ReturnType<typeof vi.fn>).mock.calls[1][0]
        expect(context.self()).toEqual({ sessionId: 'sA', cwd: '/home/u/repo', machine: 'mac' })
    })

    it('sessions.message delivers here with the caller\'s identity and NEVER bounces onward', async () => {
        const { handlers, deps } = build()
        const out = await handlers['sessions.message'](req({ to: 'mine', body: 'hi', from: { sessionId: 'sA', title: 'A', cwd: '/w' } }))
        expect(out).toMatchObject({ ok: true, result: { delivered: true, to: 'mine', from: { sessionId: 'sA', title: 'A', cwd: '/w', machine: 'mac' }, remote: null } })
        expect(deps.sendPeer).toHaveBeenCalledTimes(1)
        expect(await handlers['sessions.message'](req({ to: 'foreign', body: 'hi', from: { sessionId: 'sA' } }))).toMatchObject({ ok: false, error: { code: 'no_local_key' } })
    })

    it('rate-limits all remote callers together and reports internal failures without a stack', async () => {
        const { handlers } = build({ budget: new RemoteCallBudget(1, () => 0), listLocal: async () => { throw new Error('daemon exploded') } })
        expect(await handlers['sessions.list'](req({}))).toMatchObject({ ok: false, error: { code: 'internal', message: 'daemon exploded' } })
        expect(await handlers['sessions.list'](req({}))).toMatchObject({ ok: false, error: { code: 'rate_limited' } })
    })
})

describe('review follow-up: fail-closed switch, deadlines, split budgets, caps', () => {
    it('a setting that cannot be read means OFF (fail closed), with the audit line', async () => {
        const { handlers, log } = build({ enabled: async () => { throw new Error('settings unreadable') } })
        expect(await handlers['sessions.read'](req({ sessionId: 'mine' }))).toMatchObject({ ok: false, error: { code: 'disabled' } })
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/sessions\.read .* → disabled/))
    })

    it('send/message and list/read/peers draw from separate buckets', async () => {
        const { handlers } = build({ budget: new RemoteCallBudget(1, () => 0), writeBudget: new RemoteCallBudget(1, () => 0) })
        expect(await handlers['sessions.read'](req({ sessionId: 'mine' }))).toMatchObject({ ok: true })
        expect(await handlers['sessions.read'](req({ sessionId: 'mine' }))).toMatchObject({ ok: false, error: { code: 'rate_limited', message: expect.stringContaining('list/read/peers') } })
        expect(await handlers['sessions.send'](req({ sessionId: 'mine', text: 'x' }))).toMatchObject({ ok: true })
        expect(await handlers['sessions.send'](req({ sessionId: 'mine', text: 'x' }))).toMatchObject({ ok: false, error: { code: 'rate_limited', message: expect.stringContaining('send/message') } })
    })

    it('an op that outlives the deadline is answered with timeout instead of the server\'s 30 s silence', async () => {
        const { handlers } = build({ deadlineMs: 30, readTranscript: () => new Promise(() => undefined) })
        expect(await handlers['sessions.read'](req({ sessionId: 'mine' }))).toMatchObject({ ok: false, error: { code: 'timeout', message: expect.stringContaining('did not finish') } })
    })

    it('send: bounded resume wait, the caller\'s localId is used for the POST, and no POST after the commit deadline', async () => {
        let t = 0
        const deliver = vi.fn(async (sessionId: string, _p: PersistedSession, text: string, client: string, options: any, d: any): Promise<DeliveryResult> => {
            t += 1_000
            await d.send(sessionId, _p, text, client, { sentFrom: options.sentFrom })
            return { sessionId, status: 'live', delivered: true, resumed: false, stored: true }
        })
        const { handlers } = build({ deliver, now: () => t, sendCommitDeadlineMs: 5_000, resumeWaitMs: 4_000 })
        const out = await handlers['sessions.send'](req({ sessionId: 'mine', text: 'hi', resume: true, localId: 'remote-send-abc', sentFrom: 'assistant' }))
        expect(out).toMatchObject({ ok: true, result: { delivered: true } })
        expect(deliver.mock.calls[0][4]).toMatchObject({ resume: true, waitMs: 4_000, pollMs: 1_000, sentFrom: 'assistant' })
        expect(sendUserMessageMock).toHaveBeenCalledWith('mine', expect.anything(), 'hi', 'cli-send-remote', { sentFrom: 'assistant', localId: 'remote-send-abc' })
        sendUserMessageMock.mockClear()
        // Same op, but the resume wait ate the whole commit window: the POST is refused.
        t = 0
        const slow = vi.fn(async (sessionId: string, _p: PersistedSession, text: string, client: string, options: any, d: any): Promise<DeliveryResult> => {
            t += 6_000
            await d.send(sessionId, _p, text, client, options)
            return { sessionId, status: 'live', delivered: true, resumed: true, stored: true }
        })
        const late = build({ deliver: slow, now: () => t, sendCommitDeadlineMs: 5_000 })
        expect(await late.handlers['sessions.send'](req({ sessionId: 'mine', text: 'hi', resume: true }))).toMatchObject({ ok: false, error: { code: 'timeout', message: expect.stringContaining('nothing was sent') } })
        expect(sendUserMessageMock).not.toHaveBeenCalled()
    })

    it('read: answer and title are capped so the ack stays small', async () => {
        const { handlers } = build({ readTranscript: async (sessionId) => ({ summary: { id: sessionId, live: true, url: 'u', title: 't'.repeat(5_000) }, messageCount: 1, transcript: 'x', turn: { ended: true, answer: 'a'.repeat(70 * 1024), userSeq: 1, lastSeq: 2 } as any }) })
        const out = await handlers['sessions.read'](req({ sessionId: 'mine' })) as { ok: true; result: any }
        expect(Buffer.byteLength(out.result.turn.answer)).toBeLessThanOrEqual(64 * 1024)
        expect(out.result.turn.answer.startsWith('…')).toBe(true)
        expect(Buffer.byteLength(out.result.summary.title)).toBeLessThanOrEqual(1024)
    })
})
