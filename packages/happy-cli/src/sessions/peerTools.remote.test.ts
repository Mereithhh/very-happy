/**
 * B-915: `session_message` across machines through the DEFAULT remote hop
 * (`context.remoteMessage` unset) — `machineId` must reach the lookup:
 * the named machine is asked directly, a wrong one fails loudly, and no
 * machineId still sweeps every online machine as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedSession } from '@/persistence'
import type { AccountMachine, RemoteClientDeps, RemoteTransport } from './remoteSessionClient'

const fake = vi.hoisted(() => ({ deps: null as null | Partial<RemoteClientDeps> }))

vi.mock('./remoteSessionClient', async (importOriginal) => {
    const real = await importOriginal<typeof import('./remoteSessionClient')>()
    return {
        ...real,
        // Same code path, only the network deps are faked.
        sendRemotePeerMessage: (args: Parameters<typeof real.sendRemotePeerMessage>[0], options: Parameters<typeof real.sendRemotePeerMessage>[1]) =>
            real.sendRemotePeerMessage(args, options, fake.deps ?? {}),
    }
})

const { sendPeerMessage } = await import('./peerTools')
type PeerToolContext = import('./peerTools').PeerToolContext

const machines: AccountMachine[] = [
    { id: 'self', active: true, activeAt: 900, cliVersion: '0.2.157' },
    { id: 'dev-sg', active: true, activeAt: 800, cliVersion: '0.2.157' },
    { id: 'mac-mini', active: true, activeAt: 700, cliVersion: '0.2.157' },
]

/** mac-mini (second in sweep order) holds `far`; dev-sg holds nothing — so a sweep and a direct ask differ. Records every RPC. */
function fleet() {
    const calls: Array<{ machineId: string; method: string; args: any }> = []
    const holds: Record<string, string[]> = { 'dev-sg': [], 'mac-mini': ['far'] }
    const transport: RemoteTransport = {
        call: async (method, paramsJson) => {
            const [machineId, name] = method.split(':')
            const { args } = JSON.parse(paramsJson)
            calls.push({ machineId, method: name, args })
            if (!(machineId in holds)) return { ok: false, error: 'RPC method not available' }
            if (name === 'sessions.list') {
                return { ok: true, result: JSON.stringify({ ok: true, result: { host: machineId, machineId, sessions: holds[machineId].filter((id) => args.ids.includes(id)).map((id) => ({ id })) } }) }
            }
            if (name === 'sessions.message') {
                return { ok: true, result: JSON.stringify({ ok: true, result: { delivered: true, stored: true, status: 'live', messageId: 'r1', to: args.to, url: 'u' } }) }
            }
            return { ok: false, error: 'RPC method not available' }
        },
        close: vi.fn(),
    }
    fake.deps = {
        listMachines: async () => machines,
        selfMachineId: async () => 'self',
        openTransport: async () => transport,
        caller: async () => ({ machineId: 'self', host: 'mac', cli: '0.2.157' }),
        sleep: async () => undefined,
        now: () => 1_000,
    }
    return calls
}

const persisted = (): PersistedSession => ({
    encryptionKey: 'k', encryptionVariant: 'dataKey', seq: 0, metadataVersion: 0, agentStateVersion: 0, savedAt: 1,
    metadata: { path: '/repo', host: 'h', homeDir: '/', happyHomeDir: '/', happyLibDir: '/', happyToolsDir: '/' } as PersistedSession['metadata'],
})

function context(storeOffline = vi.fn(async () => null as null | { messageId: string })): PeerToolContext {
    return {
        self: () => ({ sessionId: 'me', title: 'Me', flavor: 'claude', cwd: '/repo' }),
        listPeers: async () => [],
        readPersisted: () => ({ me: persisted() }),
        sentTo: new Map(),
        now: () => 1_000_000,
        storeOffline,
        // remoteMessage left undefined on purpose: the default hop is under test.
    } as PeerToolContext
}

const sent = (calls: ReturnType<typeof fleet>) => calls.filter((c) => c.method === 'sessions.message').map((c) => c.machineId)
const listed = (calls: ReturnType<typeof fleet>) => calls.filter((c) => c.method === 'sessions.list').map((c) => c.machineId)

describe('sendPeerMessage default remote hop honours machineId (B-915)', () => {
    beforeEach(() => { fake.deps = null })

    it('right machine: asks only that machine and delivers there', async () => {
        const calls = fleet()
        const out = await sendPeerMessage(context(), { to: 'far', body: 'hi', machineId: 'mac-mini' })
        expect(out).toMatchObject({ delivered: true, status: 'live', machine: { id: 'mac-mini', host: 'mac-mini' } })
        expect(listed(calls)).toEqual(['mac-mini'])
        expect(sent(calls)).toEqual(['mac-mini'])
    })

    it('wrong machine (does not hold the session): a precise error, nothing sent, not parked offline', async () => {
        const calls = fleet()
        const storeOffline = vi.fn(async () => ({ messageId: 'offline-1' }))
        await expect(sendPeerMessage(context(storeOffline), { to: 'far', body: 'hi', machineId: 'dev-sg' }))
            .rejects.toMatchObject({ code: 'no_local_key', message: expect.stringContaining('dev-sg') })
        expect(listed(calls)).toEqual(['dev-sg'])
        expect(sent(calls)).toEqual([])
        expect(storeOffline).not.toHaveBeenCalled()
    })

    it('machine not on the account: unknown_machine error, no RPC, not parked offline', async () => {
        const calls = fleet()
        const storeOffline = vi.fn(async () => ({ messageId: 'offline-1' }))
        await expect(sendPeerMessage(context(storeOffline), { to: 'far', body: 'hi', machineId: 'ghost' }))
            .rejects.toMatchObject({ code: 'unknown_machine', message: expect.stringContaining('ghost') })
        expect(calls).toEqual([])
        expect(storeOffline).not.toHaveBeenCalled()
    })

    it('no machineId: unchanged — sweeps the online machines until one holds it', async () => {
        const calls = fleet()
        const out = await sendPeerMessage(context(), { to: 'far', body: 'hi' })
        expect(out).toMatchObject({ delivered: true, machine: { id: 'mac-mini' } })
        expect(listed(calls)).toEqual(['dev-sg', 'mac-mini'])
        expect(sent(calls)).toEqual(['mac-mini'])
        const miss = fleet()
        await expect(sendPeerMessage(context(), { to: 'nowhere', body: 'hi' })).rejects.toMatchObject({ code: 'not_located' })
        expect(listed(miss)).toEqual(['dev-sg', 'mac-mini'])
    })

    it('no machineId and nobody holds it: still falls back to the same-project offline store (B-646)', async () => {
        fleet()
        const storeOffline = vi.fn(async () => ({ messageId: 'offline-12345678' }))
        const out = await sendPeerMessage(context(storeOffline), { to: 'nowhere', body: 'hi' })
        expect(out).toMatchObject({ delivered: false, stored: true, status: 'offline-stored' })
    })
})
