import { describe, expect, it, vi } from 'vitest'
import type { AccountSessionSummary } from './sessionOps'
import {
    callRemoteSessionOp,
    fillForeignAccountRows,
    locateRemoteSession,
    pickRemoteCandidates,
    readRemoteTranscript,
    RemoteSessionOpsError,
    resolveExplicitMachine,
    sendRemoteMessage,
    sendRemotePeerMessage,
    waitForRemoteTurnEnd,
    withDefaults,
    type AccountMachine,
    type RemoteClientDeps,
    type RemoteTransport,
} from './remoteSessionClient'

const machines: AccountMachine[] = [
    { id: 'self', active: true, activeAt: 900, cliVersion: '0.2.157' },
    { id: 'dev-sg', active: true, activeAt: 800, cliVersion: '0.2.157' },
    { id: 'mac-office', active: false, activeAt: 100, cliVersion: '0.2.157' },
    { id: 'old-box', active: true, activeAt: 850, cliVersion: '0.2.155' },
    { id: 'unknown-ver', active: true, activeAt: 700, cliVersion: null },
]

/** A fake fleet: method → handler on each machine; missing machine/method = server "not available". */
function fleet(daemons: Record<string, Record<string, (args: any) => unknown>>) {
    const calls: Array<{ machineId: string; method: string; params: any }> = []
    const transport: RemoteTransport = {
        call: async (method, paramsJson) => {
            const [machineId, name] = method.split(':')
            const params = JSON.parse(paramsJson)
            calls.push({ machineId, method: name, params })
            const handler = daemons[machineId]?.[name]
            if (!handler) return { ok: false, error: 'RPC method not available' }
            return { ok: true, result: JSON.stringify(handler(params.args)) }
        },
        close: vi.fn(),
    }
    return { transport, calls }
}

function deps(transport: RemoteTransport, overrides: Partial<RemoteClientDeps> = {}): RemoteClientDeps {
    return withDefaults({
        listMachines: async () => machines,
        selfMachineId: async () => 'self',
        openTransport: async () => transport,
        caller: async () => ({ machineId: 'self', host: 'mac', cli: '0.2.157' }),
        sleep: async () => undefined,
        now: () => 1_000,
        ...overrides,
    })
}

describe('pickRemoteCandidates (B-506)', () => {
    it('skips self, offline and known-too-old machines; keeps unknown versions; newest-active first', () => {
        const { candidates, skipped } = pickRemoteCandidates(machines, 'self')
        expect(candidates.map((m) => m.id)).toEqual(['dev-sg', 'unknown-ver'])
        expect(skipped.map((s) => [s.machine.id, s.reason])).toEqual([['self', 'self'], ['mac-office', 'offline'], ['old-box', 'too_old']])
    })
})

describe('resolveExplicitMachine', () => {
    it('fails fast on unknown, offline and too-old machines without any RPC', async () => {
        const d = deps(fleet({}).transport)
        await expect(resolveExplicitMachine('nope', d)).rejects.toMatchObject({ code: 'unknown_machine' })
        await expect(resolveExplicitMachine('mac-office', d)).rejects.toMatchObject({ code: 'offline', message: expect.stringContaining('offline') })
        await expect(resolveExplicitMachine('old-box', d)).rejects.toMatchObject({ code: 'too_old', message: expect.stringContaining('0.2.157') })
        await expect(resolveExplicitMachine('dev-sg', d)).resolves.toMatchObject({ id: 'dev-sg' })
    })
})

describe('callRemoteSessionOp', () => {
    const from = { host: 'mac', cli: '0.2.157' }

    it('sends the versioned envelope and unwraps a successful result', async () => {
        const { transport, calls } = fleet({ 'dev-sg': { 'sessions.list': (args) => ({ ok: true, result: { host: 'dev-sg', machineId: 'dev-sg', sessions: [], echoed: args } }) } })
        const out = await callRemoteSessionOp<'sessions.list', any>(transport, 'dev-sg', 'sessions.list', { ids: ['s1'] }, from)
        expect(out).toMatchObject({ host: 'dev-sg', echoed: { ids: ['s1'] } })
        expect(calls[0]).toEqual({ machineId: 'dev-sg', method: 'sessions.list', params: { v: 1, from, args: { ids: ['s1'] } } })
    })

    it('maps "not available" to unreachable with the three causes, daemon codes to themselves, and a bare {error} to internal', async () => {
        const { transport } = fleet({
            'dev-sg': {
                'sessions.read': () => ({ ok: false, error: { code: 'no_local_key', message: 'nope' } }),
                'sessions.send': () => ({ error: 'handler blew up' }),
            },
        })
        await expect(callRemoteSessionOp(transport, 'dev-sg', 'sessions.list', {}, from)).rejects.toMatchObject({ code: 'unreachable', message: expect.stringMatching(/offline, restarting, or runs a CLI older than 0\.2\.157/) })
        await expect(callRemoteSessionOp(transport, 'dev-sg', 'sessions.read', { sessionId: 's1' }, from)).rejects.toMatchObject({ code: 'no_local_key', message: 'Machine dev-sg: nope' })
        await expect(callRemoteSessionOp(transport, 'dev-sg', 'sessions.send', { sessionId: 's1', text: 'x' }, from)).rejects.toMatchObject({ code: 'internal', message: 'Machine dev-sg: handler blew up' })
        const dead: RemoteTransport = { call: async () => { throw new Error('operation has timed out') }, close: vi.fn() }
        await expect(callRemoteSessionOp(dead, 'dev-sg', 'sessions.list', {}, from)).rejects.toMatchObject({ code: 'unreachable', message: expect.stringContaining('timed out') })
    })
})

describe('locateRemoteSession', () => {
    it('sweeps the candidates newest-first and stops at the first machine that reports the session', async () => {
        const { transport, calls } = fleet({
            'dev-sg': { 'sessions.list': () => ({ ok: true, result: { host: 'dev-sg', machineId: 'dev-sg', sessions: [] } }) },
            'unknown-ver': { 'sessions.list': (args) => ({ ok: true, result: { host: 'box', machineId: 'unknown-ver', sessions: args.ids.map((id: string) => ({ id })) } }) },
        })
        const located = await locateRemoteSession(transport, 's1', {}, deps(transport))
        expect(located).toMatchObject({ machine: { id: 'unknown-ver' }, host: 'box' })
        expect(calls.map((c) => c.machineId)).toEqual(['dev-sg', 'unknown-ver'])
    })

    it('explains a miss: which machines said no, which were unreachable, which were skipped and why', async () => {
        const { transport } = fleet({ 'dev-sg': { 'sessions.list': () => ({ ok: true, result: { host: 'dev-sg', machineId: 'dev-sg', sessions: [] } }) } })
        const error = await locateRemoteSession(transport, 's1', {}, deps(transport)).catch((e) => e)
        expect(error).toBeInstanceOf(RemoteSessionOpsError)
        expect(error.code).toBe('not_located')
        expect(error.message).toContain('dev-sg: not there')
        expect(error.message).toContain('unknown-ver: unreachable')
        expect(error.message).toContain('mac-office: offline')
        expect(error.message).toContain('old-box: too_old')
        expect(error.message).toContain('--machine <id>')
    })

    it('with --machine: validates the machine, asks only it, and reports no_local_key precisely', async () => {
        const { transport, calls } = fleet({ 'dev-sg': { 'sessions.list': () => ({ ok: true, result: { host: 'dev-sg', machineId: 'dev-sg', sessions: [] } }) } })
        await expect(locateRemoteSession(transport, 's1', { machineId: 'dev-sg' }, deps(transport))).rejects.toMatchObject({ code: 'no_local_key', message: expect.stringContaining('not spawned there') })
        expect(calls.map((c) => c.machineId)).toEqual(['dev-sg'])
        await expect(locateRemoteSession(transport, 's1', { machineId: 'mac-office' }, deps(transport))).rejects.toMatchObject({ code: 'offline' })
    })
})

describe('high-level operations', () => {
    const read = { summary: { id: 's1', live: true, url: 'u' }, messageCount: 1, transcript: 't', machineId: 'dev-sg', host: 'dev-sg' }

    it('readRemoteTranscript locates then reads on one transport and closes it', async () => {
        const { transport, calls } = fleet({ 'dev-sg': {
            'sessions.list': () => ({ ok: true, result: { host: 'dev-sg', machineId: 'dev-sg', sessions: [{ id: 's1' }] } }),
            'sessions.read': (args) => ({ ok: true, result: { ...read, turn: { ended: true }, args } }),
        } })
        const out = await readRemoteTranscript('s1', { limit: 7, full: true }, deps(transport))
        expect(out).toMatchObject({ host: 'dev-sg', args: { sessionId: 's1', limit: 7, full: true } })
        expect(calls.map((c) => c.method)).toEqual(['sessions.list', 'sessions.read'])
        expect(transport.close).toHaveBeenCalledTimes(1)
    })

    it('waitForRemoteTurnEnd polls the remote read until the turn ended, or reports the timeout with the last read', async () => {
        let reads = 0
        const { transport } = fleet({ 'dev-sg': {
            'sessions.list': () => ({ ok: true, result: { host: 'dev-sg', machineId: 'dev-sg', sessions: [{ id: 's1' }] } }),
            'sessions.read': () => ({ ok: true, result: { ...read, turn: { ended: ++reads >= 3 } } }),
        } })
        let t = 0
        const d = deps(transport, { now: () => t, sleep: async () => { t += 3_000 } })
        expect(await waitForRemoteTurnEnd('s1', { timeoutMs: 60_000 }, d)).toMatchObject({ timedOut: false, read: { turn: { ended: true } } })
        expect(reads).toBe(3)
        reads = -10
        t = 0
        expect(await waitForRemoteTurnEnd('s1', { timeoutMs: 5_000 }, d)).toMatchObject({ timedOut: true, read: { turn: { ended: false } } })
    })

    it('sendRemotePeerMessage stamps the sender with this host and returns the machine it went through', async () => {
        const { transport, calls } = fleet({ 'dev-sg': {
            'sessions.list': () => ({ ok: true, result: { host: 'dev-sg', machineId: 'dev-sg', sessions: [{ id: 's1' }] } }),
            'sessions.message': (args) => ({ ok: true, result: { delivered: true, stored: true, status: 'live', messageId: 'm1', to: args.to, url: 'u', got: args } }),
        } })
        const out = await sendRemotePeerMessage({ to: 's1', body: 'hi', from: { sessionId: 'sA', title: 'A', cwd: '/w' } }, {}, deps(transport))
        expect(out).toMatchObject({ delivered: true, machine: { id: 'dev-sg', host: 'dev-sg' } })
        expect(calls[1].params.args.from).toEqual({ sessionId: 'sA', title: 'A', cwd: '/w', machine: 'mac' })
    })
})

describe('fillForeignAccountRows (sessions list --all)', () => {
    const row = (id: string, decryptable: boolean): AccountSessionSummary => ({ id, url: `u/${id}`, live: false, decryptable, readable: decryptable, active: true, archived: false, attention: false })

    it('asks each candidate once for all pending ids and replaces the rows it answers for', async () => {
        const { transport, calls } = fleet({
            'dev-sg': { 'sessions.list': (args) => ({ ok: true, result: { host: 'dev-sg', machineId: 'dev-sg', sessions: args.ids.filter((id: string) => id === 'f1').map((id: string) => ({ id, url: 'u', live: true, decryptable: true, readable: true, active: true, archived: false, attention: false, title: 'On dev-sg', cwd: '/home/u/x' })) } }) },
            'unknown-ver': { 'sessions.list': () => ({ ok: true, result: { host: 'box', machineId: 'unknown-ver', sessions: [] } }) },
        })
        const out = await fillForeignAccountRows([row('mine', true), row('f1', false), row('f2', false)], deps(transport))
        expect(out.rows.map((r) => [r.id, r.readable, r.via, r.machine?.host, r.title])).toEqual([
            ['mine', true, undefined, undefined, undefined],
            ['f1', true, 'dev-sg', 'dev-sg', 'On dev-sg'],
            ['f2', false, undefined, undefined, undefined],
        ])
        expect(out.rows[1].decryptable).toBe(false)
        expect(calls.map((c) => [c.machineId, c.params.args])).toEqual([
            ['dev-sg', { ids: ['f1', 'f2'], all: true }],
            ['unknown-ver', { ids: ['f2'], all: true }],
        ])
        expect(out.asked).toEqual([{ machineId: 'dev-sg', host: 'dev-sg', filled: 1 }, { machineId: 'unknown-ver', host: 'box', filled: 0 }])
        expect(out.skipped).toEqual([{ machineId: 'mac-office', reason: 'offline' }, { machineId: 'old-box', reason: 'too_old' }])
    })

    it('does nothing when every row is already readable (no machines listed, no socket opened)', async () => {
        const openTransport = vi.fn()
        const out = await fillForeignAccountRows([row('a', true)], deps(fleet({}).transport, { openTransport, listMachines: vi.fn() }))
        expect(out).toEqual({ rows: [row('a', true)], asked: [], skipped: [] })
        expect(openTransport).not.toHaveBeenCalled()
    })
})

describe('review follow-up: idempotent send retry, slower remote --wait', () => {
    it('sendRemoteMessage retries exactly once with the SAME localId after an ambiguous transport failure', async () => {
        let n = 0
        const seen: string[] = []
        const transport: RemoteTransport = {
            call: async (method, paramsJson) => {
                const [, name] = method.split(':')
                if (name === 'sessions.list') return { ok: true, result: JSON.stringify({ ok: true, result: { host: 'dev-sg', machineId: 'dev-sg', sessions: [{ id: 's1' }] } }) }
                seen.push(JSON.parse(paramsJson).args.localId)
                if (++n === 1) throw new Error('operation has timed out')
                return { ok: true, result: JSON.stringify({ ok: true, result: { sessionId: 's1', status: 'live', delivered: true, resumed: false, stored: true } }) }
            },
            close: vi.fn(),
        }
        const out = await sendRemoteMessage('s1', 'hi', {}, deps(transport))
        expect(out).toMatchObject({ delivered: true, machine: { id: 'dev-sg' } })
        expect(seen).toHaveLength(2)
        expect(seen[0]).toBe(seen[1])
        expect(seen[0]).toMatch(/^remote-send-/)
    })

    it('does not retry a definite refusal (daemon code other than timeout, or "not available")', async () => {
        let sends = 0
        const { transport } = fleet({ 'dev-sg': {
            'sessions.list': () => ({ ok: true, result: { host: 'dev-sg', machineId: 'dev-sg', sessions: [{ id: 's1' }] } }),
            'sessions.send': () => { sends++; return { ok: false, error: { code: 'no_local_key', message: 'gone' } } },
        } })
        await expect(sendRemoteMessage('s1', 'hi', {}, deps(transport))).rejects.toMatchObject({ code: 'no_local_key' })
        expect(sends).toBe(1)
    })

    it('retries once when the daemon reports timeout (nothing was posted)', async () => {
        let sends = 0
        const { transport } = fleet({ 'dev-sg': {
            'sessions.list': () => ({ ok: true, result: { host: 'dev-sg', machineId: 'dev-sg', sessions: [{ id: 's1' }] } }),
            'sessions.send': () => ++sends === 1 ? { ok: false, error: { code: 'timeout', message: 'not live in time' } } : { ok: true, result: { sessionId: 's1', status: 'live', delivered: true, resumed: true, stored: true } },
        } })
        await expect(sendRemoteMessage('s1', 'hi', { resume: true }, deps(transport))).resolves.toMatchObject({ delivered: true })
        expect(sends).toBe(2)
    })

    it('waitForRemoteTurnEnd polls every 5 s by default', async () => {
        let reads = 0
        const { transport } = fleet({ 'dev-sg': {
            'sessions.list': () => ({ ok: true, result: { host: 'dev-sg', machineId: 'dev-sg', sessions: [{ id: 's1' }] } }),
            'sessions.read': () => ({ ok: true, result: { summary: { id: 's1', live: true, url: 'u' }, messageCount: 1, transcript: 't', machineId: 'dev-sg', host: 'dev-sg', turn: { ended: ++reads >= 2 } } }),
        } })
        const sleep = vi.fn(async () => undefined)
        await waitForRemoteTurnEnd('s1', { timeoutMs: 60_000 }, deps(transport, { sleep }))
        expect(sleep).toHaveBeenCalledWith(5_000)
    })
})
